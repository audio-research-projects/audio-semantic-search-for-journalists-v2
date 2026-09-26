import "dotenv/config";
import { randomUUID } from "node:crypto";

import { A2AClient } from "@a2a-js/sdk/client";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import { Logging } from "@google-cloud/logging";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { GoogleAuth } from "google-auth-library";
import { Observable } from "rxjs";
import { A2ASearchPlanner } from "./a2a-planner.js";
import { effectivePlan, SearchServiceClient, executeSearch, parseSearchRequest, type DirectSearchRequest, type SearchIndex, type SearchPlan } from "./direct-search.js";

const agentUrl = process.env.A2A_AGENT_URL?.trim();
if (!agentUrl) throw new Error("A2A_AGENT_URL environment variable is required");
const configuredAgentUrl: string = agentUrl;
const searchServiceUrl = process.env.SEARCH_SERVICE_URL?.trim().replace(/\/$/, "");
const searchService = searchServiceUrl ? new SearchServiceClient(searchServiceUrl) : undefined;

const agentCardPath = "/.well-known/agent-card.json";
const legacyAgentCardPath = "/.well-known/agent.json";
const agentRuntimeHostSuffix = "-aiplatform.googleapis.com";

function isAgentRuntimeUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(agentRuntimeHostSuffix);
  } catch {
    return false;
  }
}

/**
 * The A2A SDK does not expose a hook to attach IAM headers. Agent Runtime
 * requires a bearer token even for its A2A agent card, so authenticate all
 * requests made to the Vertex AI host with Cloud Run's ADC identity.
 */
function installAgentRuntimeAuth(): void {
  if (!isAgentRuntimeUrl(configuredAgentUrl)) return;

  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!isAgentRuntimeUrl(url)) return originalFetch(input, init);

    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", `Bearer ${token}`);
    const normalizedUrl = url.endsWith(legacyAgentCardPath)
      ? `${url.slice(0, -legacyAgentCardPath.length)}${agentCardPath}`
      : url;
    return originalFetch(normalizedUrl, { ...init, headers });
  }) as typeof fetch;
}

function lastUserMessage(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part): part is { type: string; text: string } =>
          Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string"
        )
        .map((part) => part.text)
        .join("");
    }
  }
  return "";
}

function textFromA2AResult(result: unknown): string {
  const value = result as { kind?: string; parts?: Array<{ kind?: string; text?: string }>; artifacts?: Array<{ parts?: Array<{ kind?: string; text?: string }> }>; history?: Array<{ role?: string; parts?: Array<{ kind?: string; text?: string }> }> };
  const fromParts = (parts?: Array<{ kind?: string; text?: string }>) =>
    (parts ?? []).filter((part) => part.kind === "text" && typeof part.text === "string").map((part) => part.text as string).join("");
  if (value.kind === "message") return fromParts(value.parts);
  if (value.kind === "task") {
    const artifactText = fromParts(value.artifacts?.at(-1)?.parts);
    if (artifactText) return artifactText;
    for (const item of [...(value.history ?? [])].reverse()) {
      if (item.role === "agent") return fromParts(item.parts);
    }
  }
  return "";
}

/** A single-agent, non-LLM bridge from AG-UI requests to A2A JSON-RPC. */
class AudioSearchA2AAgent extends AbstractAgent {
  private readonly client = new A2AClient(configuredAgentUrl, agentCardPath);

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      void (async () => {
        subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent);
        const response = await this.client.sendMessage({
          message: {
            kind: "message",
            role: "user",
            messageId: randomUUID(),
            contextId: input.threadId,
            parts: [{ kind: "text", text: lastUserMessage(input.messages) }],
          },
        });
        if (!("result" in response)) throw new Error(`A2A error: ${response.error.message}`);

        const messageId = randomUUID();
        subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent);
        subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: textFromA2AResult(response.result) || "No obtuve respuesta del agente." } as BaseEvent);
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
        subscriber.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent);
        subscriber.complete();
      })().catch((error: unknown) => subscriber.error(error));
    });
  }

  override clone(): AudioSearchA2AAgent {
    const clone = new AudioSearchA2AAgent({ agentId: this.agentId, description: this.description, threadId: this.threadId });
    clone.messages = [...this.messages];
    clone.state = this.state;
    return clone;
  }
}

installAgentRuntimeAuth();
// A2AClient obtains and caches the agent card when it is constructed. Install
// IAM authentication first so the planner's initial card request is authorized.
const searchPlanner = new A2ASearchPlanner(configuredAgentUrl);
const runtime = new CopilotRuntime({ agents: { default: new AudioSearchA2AAgent({ description: "A2A bridge to the audio-search-journalists agent." }) } });
const app = express();
const origins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const corsOptions = { origin: origins.length === 0 ? false : origins, methods: ["GET", "POST"] };
// Cloud Run provides Application Default Credentials even when it does not
// expose GOOGLE_CLOUD_PROJECT as an environment variable. Let the client
// resolve the project from those credentials so feedback always reaches the
// dedicated log consumed by the BigQuery sink.
const feedbackLog = new Logging().log("audio_search_journalists_feedback");
app.set("trust proxy", 1);
app.use(cors(corsOptions));
app.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));
app.use(express.json({ limit: "32kb" }));
app.get("/health", (_request, response) => response.json({ status: "ok" }));

interface FeedbackPayload {
  messageId?: unknown;
  feedback?: unknown;
  question?: unknown;
  answer?: unknown;
}

function isValidFeedback(value: unknown): value is Required<FeedbackPayload> & { feedback: "thumbsUp" | "thumbsDown" } {
  if (!value || typeof value !== "object") return false;
  const { messageId, feedback, question, answer } = value as FeedbackPayload;
  return typeof messageId === "string"
    && (feedback === "thumbsUp" || feedback === "thumbsDown")
    && typeof question === "string"
    && typeof answer === "string"
    && question.length <= 10_000
    && answer.length <= 10_000;
}

function requireSearchService(response: express.Response): SearchServiceClient | undefined {
  if (searchService) return searchService;
  response.status(503).json({ detail: "SEARCH_SERVICE_URL no está configurada en el proxy." });
  return undefined;
}

async function resolveSearchPlan(request: DirectSearchRequest): Promise<SearchPlan | undefined> {
  if (!request.rewrite || request.plan) return request.plan;
  try {
    return await searchPlanner.rewrite(request);
  } catch (error) {
    console.error("A2A search-plan rewrite failed.", error);
    throw new Error("No se pudo reformular la consulta con el agente. Intentá nuevamente.");
  }
}

app.post("/api/search/plan", async (request, response) => {
  try {
    const requestedIndexes = request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>).indexes
      : undefined;
    const parsed = parseSearchRequest({
      ...request.body,
      indexes: requestedIndexes,
      k: 10,
    });
    response.json(effectivePlan({ ...parsed, plan: await resolveSearchPlan(parsed) }));
  } catch (error) {
    response.status(400).json({ detail: error instanceof Error ? error.message : "Solicitud inválida." });
  }
});

app.post("/api/search", async (request, response) => {
  const client = requireSearchService(response);
  if (!client) return;
  try {
    const parsed = parseSearchRequest(request.body);
    response.json(await executeSearch({ ...parsed, plan: await resolveSearchPlan(parsed) }, client));
  } catch (error) {
    response.status(400).json({ detail: error instanceof Error ? error.message : "Solicitud inválida." });
  }
});

app.get("/api/segments/:segmentId", async (request, response) => {
  const client = requireSearchService(response);
  if (!client) return;
  const segmentId = Number(request.params.segmentId);
  if (!Number.isInteger(segmentId) || segmentId < 0) {
    response.status(400).json({ detail: "segmentId debe ser un entero no negativo." });
    return;
  }
  try {
    response.json(await client.request("GET", `/segments/${segmentId}`));
  } catch (error) {
    response.status(502).json({ detail: "No fue posible consultar el segmento." });
  }
});

app.get("/api/datasets", async (_request, response) => {
  const client = requireSearchService(response);
  if (!client) return;
  try {
    response.json(await client.request("GET", "/datasets"));
  } catch (error) {
    response.status(502).json({ detail: "No fue posible listar los datasets." });
  }
});

app.get("/api/corpus", async (request, response) => {
  const client = requireSearchService(response);
  if (!client) return;
  try {
    const datasetId = typeof request.query.dataset_id === "string" ? request.query.dataset_id : undefined;
    response.json(await client.request("GET", datasetId ? `/corpus?dataset_id=${encodeURIComponent(datasetId)}` : "/corpus"));
  } catch (error) {
    response.status(502).json({ detail: "No fue posible consultar el corpus." });
  }
});

// Feedback is recorded under a dedicated Cloud Logging log name. Terraform
// exports that log to BigQuery, keeping browser requests away from BigQuery
// credentials and preserving a queryable audit trail.
app.post(
  "/api/feedback",
  rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false }),
  async (request, response, next) => {
    try {
      if (!isValidFeedback(request.body)) {
        response.status(400).json({ detail: "Feedback inválido." });
        return;
      }

      const payload = {
        log_type: "feedback",
        service_name: "audio-search-journalists",
        message_id: request.body.messageId,
        feedback: request.body.feedback,
        question: request.body.question,
        answer: request.body.answer,
        timestamp: new Date().toISOString(),
      };
      await feedbackLog.write(feedbackLog.entry({ severity: "INFO" }, payload));
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);
app.use(createCopilotExpressHandler({ runtime, basePath: "/api/copilotkit", cors: corsOptions, mode: "single-route" }));
app.listen(Number(process.env.PORT ?? 8080), () => console.log("CopilotKit proxy listening"));
