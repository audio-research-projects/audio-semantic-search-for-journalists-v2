import type { DatasetsResponse, SearchRequest, SearchResponse } from "./types";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export async function fetchDatasets(signal?: AbortSignal): Promise<DatasetsResponse> {
  const response = await fetch(`${apiBaseUrl}/api/datasets`, { signal });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail || `No se pudieron cargar los datasets (${response.status}).`);
  }
  return (await response.json()) as DatasetsResponse;
}

export async function search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  const response = await fetch(`${apiBaseUrl}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail || `La búsqueda falló (${response.status}).`);
  }
  return (await response.json()) as SearchResponse;
}
