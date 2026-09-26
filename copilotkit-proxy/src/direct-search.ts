import { GoogleAuth } from "google-auth-library";

export type SearchIndex = "text" | "audio" | "yamnet";

export interface SearchPlan {
  original_query: string;
  indexes: SearchIndex[];
  text_query?: string;
  audio_query?: string;
  audio_query_en?: string;
  yamnet_query?: string;
  yamnet_query_en?: string;
  rationale?: string;
}

export interface DirectSearchRequest {
  query: string;
  indexes: SearchIndex[];
  k: number;
  rewrite: boolean;
  dataset_id?: string;
  plan?: SearchPlan;
}

interface RetrievalResult {
  segment?: Record<string, unknown>;
  similarity?: number;
}

interface RetrievalResponse {
  results?: RetrievalResult[];
  translated_query?: string;
}

interface ServiceTransport {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}

const indexLabels: Record<SearchIndex, string> = {
  text: "Índice de texto (transcripciones)",
  audio: "Índice de audio (CLAP)",
  yamnet: "Clases de audio (YAMNet/AudioSet)",
};

export class SearchServiceClient implements ServiceTransport {
  private readonly baseUrl: string;
  private readonly auth = new GoogleAuth();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const client = await this.auth.getIdTokenClient(this.baseUrl);
    const response = await client.request<unknown>({
      url: `${this.baseUrl}${path}`,
      method,
      data: body,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    });
    return response.data;
  }
}

export function parseSearchRequest(value: unknown): DirectSearchRequest {
  if (!value || typeof value !== "object") throw new Error("El body debe ser un objeto JSON.");
  const source = value as Record<string, unknown>;
  const query = typeof source.query === "string" ? source.query.trim() : "";
  if (!query) throw new Error("query es obligatorio.");

  if (source.include_text !== undefined && typeof source.include_text !== "boolean") {
    throw new Error("include_text debe ser booleano.");
  }
  if (source.include_clap !== undefined && typeof source.include_clap !== "boolean") {
    throw new Error("include_clap debe ser booleano.");
  }
  if (source.include_yamnet !== undefined && typeof source.include_yamnet !== "boolean") {
    throw new Error("include_yamnet debe ser booleano.");
  }
  if (source.indexes !== undefined && !Array.isArray(source.indexes)) {
    throw new Error("indexes debe ser una lista.");
  }
  if (source.dataset_id !== undefined && typeof source.dataset_id !== "string") {
    throw new Error("dataset_id debe ser una cadena.");
  }
  const dataset_id = source.dataset_id ? String(source.dataset_id) : undefined;
  const explicitIndexes = Array.isArray(source.indexes)
    ? source.indexes.filter((index): index is SearchIndex =>
      index === "text" || index === "audio" || index === "yamnet")
    : undefined;
  if (
    explicitIndexes
    && (!explicitIndexes.length
      || explicitIndexes.length !== source.indexes?.length
      || explicitIndexes.length !== new Set(explicitIndexes).size)
  ) {
    throw new Error("indexes debe contener text, audio y/o yamnet sin duplicados.");
  }
  // Text remains active for legacy clients that omit include_text. All three
  // sources are independently selectable from the direct-search frontend.
  const indexes: SearchIndex[] = explicitIndexes ?? [
    ...(source.include_text !== false ? ["text" as const] : []),
    ...(source.include_clap === true ? ["audio" as const] : []),
    ...(source.include_yamnet === true ? ["yamnet" as const] : []),
  ];
  if (!indexes.length) throw new Error("Elegí al menos un índice para buscar.");

  const k = typeof source.k === "number" ? source.k : Number(source.k ?? 10);
  if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error("k debe ser un entero entre 1 y 50.");

  const plan = parsePlan(source.plan, query, indexes);
  return { query, indexes, k, rewrite: source.rewrite !== false, dataset_id, plan };
}

export function parsePlan(value: unknown, query: string, indexes: SearchIndex[]): SearchPlan | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("plan debe ser un objeto JSON.");
  const source = value as Record<string, unknown>;
  if (source.indexes !== undefined && !Array.isArray(source.indexes)) {
    throw new Error("plan.indexes debe ser una lista.");
  }
  const planIndexes = Array.isArray(source.indexes)
    ? source.indexes.filter((index): index is SearchIndex =>
      index === "text" || index === "audio" || index === "yamnet")
    : indexes;
  if (
    !planIndexes.length
    || (Array.isArray(source.indexes) && planIndexes.length !== source.indexes.length)
    || planIndexes.length !== new Set(planIndexes).size
  ) {
    throw new Error("plan.indexes debe contener text, audio y/o yamnet sin duplicados.");
  }
  if (
    planIndexes.length !== indexes.length
    || planIndexes.some((index) => !indexes.includes(index))
  ) {
    throw new Error("plan.indexes debe coincidir con los índices elegidos por el usuario.");
  }
  const optionalText = (field: "text_query" | "audio_query" | "audio_query_en" | "yamnet_query" | "yamnet_query_en" | "rationale") =>
    typeof source[field] === "string" && source[field].trim() ? source[field].trim() : undefined;
  return {
    original_query: typeof source.original_query === "string" ? source.original_query : query,
    indexes: planIndexes,
    text_query: optionalText("text_query"),
    audio_query: optionalText("audio_query"),
    audio_query_en: optionalText("audio_query_en"),
    yamnet_query: optionalText("yamnet_query"),
    yamnet_query_en: optionalText("yamnet_query_en"),
    rationale: optionalText("rationale"),
  };
}

export function effectivePlan(request: DirectSearchRequest): SearchPlan {
  if (request.plan) return { ...request.plan, original_query: request.query };
  return {
    original_query: request.query,
    indexes: request.indexes,
    text_query: request.indexes.includes("text") ? request.query : undefined,
    audio_query: request.indexes.includes("audio") ? request.query : undefined,
    yamnet_query: request.indexes.includes("yamnet") ? request.query : undefined,
    rationale: "Búsqueda literal.",
  };
}

function normalizeResults(payload: unknown, index: SearchIndex): Record<string, unknown>[] {
  const response = payload as RetrievalResponse;
  return (response.results ?? []).flatMap((item, position) => {
    if (!item.segment || typeof item.segment !== "object") return [];
    return [{
      ...item.segment,
      similarity: typeof item.similarity === "number" ? item.similarity : 0,
      rank: position + 1,
      search_index: index,
      search_index_label: indexLabels[index],
    }];
  });
}

function unavailableIndex(query: string, message: string) {
  return { available: false, effective_query: query, results: [], error: message };
}

export async function executeSearch(request: DirectSearchRequest, transport: ServiceTransport): Promise<Record<string, unknown>> {
  const plan = effectivePlan(request);
  const start = Date.now();
  const searches = await Promise.all(plan.indexes.map(async (index) => {
    const query = index === "text"
      ? plan.text_query || request.query
      : index === "audio"
        ? plan.audio_query || request.query
        : plan.yamnet_query || request.query;
    const path = index === "text"
      ? "/search/semantic"
      : index === "audio"
        ? "/search/audio"
        : "/search/yamnet";
    try {
      const savedTranslation = index === "audio"
        ? plan.audio_query_en
        : index === "yamnet"
          ? plan.yamnet_query_en
          : undefined;
      const body: Record<string, unknown> = savedTranslation
        ? { query, query_en: savedTranslation, k: request.k }
        : { query, k: request.k };
      if (request.dataset_id) body.dataset_id = request.dataset_id;
      const payload = await transport.request("POST", path, body);
      const retrieval = payload as RetrievalResponse;
      const translatedQuery = index === "audio" || index === "yamnet"
        ? retrieval.translated_query
        : undefined;
      return { index, translatedQuery, datasetMeta: pickDatasetMeta(payload), bucket: {
        available: true,
        effective_query: query,
        ...(translatedQuery ? { translated_query: translatedQuery } : {}),
        results: normalizeResults(payload, index),
      } };
    } catch (error) {
      console.error(`Direct ${index} search failed`, error);
      return {
        index,
        translatedQuery: undefined,
        datasetMeta: {} as DatasetMeta,
        bucket: unavailableIndex(query, "Fuente de búsqueda no disponible temporalmente."),
      };
    }
  }));
  const audioTranslation = searches.find(({ index }) => index === "audio")?.translatedQuery;
  const yamnetTranslation = searches.find(({ index }) => index === "yamnet")?.translatedQuery;
  const resolvedPlan = {
    ...plan,
    ...(audioTranslation ? { audio_query_en: audioTranslation } : {}),
    ...(yamnetTranslation ? { yamnet_query_en: yamnetTranslation } : {}),
  };
  // All searched indexes returned from the same dataset; surface once at top level.
  const representativeMeta = searches.find(({ datasetMeta }) => datasetMeta?.dataset_id)?.datasetMeta;
  return {
    query: request.query,
    dataset_id: representativeMeta?.dataset_id,
    dataset_label: representativeMeta?.dataset_label,
    dataset_release: representativeMeta?.dataset_release,
    plan: resolvedPlan,
    took_ms: Date.now() - start,
    indexes: Object.fromEntries(searches.map(({ index, bucket }) => [index, bucket])),
  };
}

interface DatasetMeta {
  dataset_id?: string;
  dataset_label?: string;
  dataset_release?: string;
}

function pickDatasetMeta(payload: unknown): DatasetMeta {
  if (!payload || typeof payload !== "object") return {};
  const source = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof source.dataset_id === "string") result.dataset_id = source.dataset_id;
  if (typeof source.dataset_label === "string") result.dataset_label = source.dataset_label;
  if (typeof source.dataset_release === "string") result.dataset_release = source.dataset_release;
  return result;
}
