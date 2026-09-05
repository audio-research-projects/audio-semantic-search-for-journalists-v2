import { CopilotKit } from "@copilotkit/react-core";
import { CopilotPopup } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

declare const __RUNTIME_URL__: string | undefined;

const runtimeUrl = __RUNTIME_URL__ || import.meta.env.VITE_COPILOT_RUNTIME_URL || "http://localhost:8080/api/copilotkit";
const feedbackUrl = runtimeUrl.replace(/\/api\/copilotkit\/?$/, "/api/feedback");

type FeedbackKind = "thumbsUp" | "thumbsDown";
type Locale = "es" | "en";

function currentLocale(): Locale {
  const saved = window.localStorage.getItem("audio-search-locale");
  if (saved === "en" || saved === "es") return saved;
  return navigator.languages.some(language => language.toLowerCase().startsWith("en")) ? "en" : "es";
}

function messageText(message: unknown): string {
  return typeof (message as { content?: unknown } | undefined)?.content === "string"
    ? (message as { content: string }).content
    : "";
}

function sendFeedback(message: unknown, feedback: FeedbackKind, question: string): void {
  const messageId = (message as { id?: unknown } | undefined)?.id;
  if (typeof messageId !== "string") return;
  void fetch(feedbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId, feedback, question, answer: messageText(message) }),
  }).catch((error: unknown) => console.error("No se pudo registrar el feedback.", error));
}

function signedUrlExpiresAt(url: URL): number | undefined {
  const date = url.searchParams.get("X-Goog-Date");
  const expires = Number(url.searchParams.get("X-Goog-Expires"));
  const match = date?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match || !Number.isFinite(expires) || expires < 0) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) + expires * 1_000;
}

export function isSignedClipUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    const expiresAt = signedUrlExpiresAt(url);
    return url.protocol === "https:"
      && (url.hostname === "storage.googleapis.com" || url.hostname.endsWith(".storage.googleapis.com"))
      && url.pathname.endsWith(".opus")
      && url.searchParams.get("X-Goog-Algorithm") === "GOOG4-RSA-SHA256"
      && Boolean(url.searchParams.get("X-Goog-Credential"))
      && Boolean(url.searchParams.get("X-Goog-Signature"))
      && expiresAt !== undefined
      && expiresAt > Date.now();
  } catch {
    return false;
  }
}

function ClipLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
  const [failedToLoad, setFailedToLoad] = useState(false);
  const isGcsObjectUrl = typeof href === "string" && href.includes("storage.googleapis.com");
  if (!isSignedClipUrl(href)) {
    if (isGcsObjectUrl) {
      return <span title="El enlace de reproducción debe ser una URL V4 firmada y vigente.">Audio no disponible: renová la búsqueda.</span>;
    }
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  }
  if (failedToLoad) {
    return <span title="La URL firmada fue rechazada o venció mientras se cargaba.">No se pudo cargar el audio. Renová la búsqueda.</span>;
  }
  return (
    <audio controls preload="metadata" src={href} onError={() => setFailedToLoad(true)}>
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    </audio>
  );
}

export default function App() {
  const lastQuestion = useRef("");
  const [locale, setLocale] = useState<Locale>(currentLocale);
  useEffect(() => {
    const update = (event: Event) => {
      const next = (event as CustomEvent<Locale>).detail;
      if (next === "es" || next === "en") setLocale(next);
    };
    window.addEventListener("audio-search-locale-change", update);
    return () => window.removeEventListener("audio-search-locale-change", update);
  }, []);
  const english = locale === "en";
  return (
    <CopilotKit runtimeUrl={runtimeUrl} agent="default" useSingleEndpoint showDevConsole={false}>
      <CopilotPopup
        instructions={english ? "Respond in English and cite the file and timestamps returned by the agent." : "Respondé en español y citá el archivo y timestamps que entregue el agente."}
        labels={english ? { title: "Audio search", initial: "What would you like to find in the audio archive?" } : { title: "Búsqueda de audio", initial: "¿Qué querés encontrar en el archivo de audio?" }}
        markdownTagRenderers={{ a: ClipLink }}
        onSubmitMessage={(message: string) => { lastQuestion.current = message; }}
        onThumbsUp={(message: unknown) => sendFeedback(message, "thumbsUp", lastQuestion.current)}
        onThumbsDown={(message: unknown) => sendFeedback(message, "thumbsDown", lastQuestion.current)}
      />
    </CopilotKit>
  );
}
