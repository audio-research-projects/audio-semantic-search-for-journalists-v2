"""HTTP surface for the retrieval half of the agent.

This service owns everything that needs PyTorch: the CLAP text encoder, the
sentence-transformers encoder, the FAISS indices and the dataset itself. The ADK
agent runs in a separate container without any of it and calls these endpoints
through ``src.agent_service.search_client``.

The split exists because those models are a poor fit for a scale-to-zero
runtime: the CLAP checkpoint is ~1.7 GB and is fetched at first use rather than
baked by pip, so every cold start paid for it before answering. Here the image
ships the checkpoint, while ``min-instances=0`` permits scale-to-zero. Each
cold start still loads the checkpoint from the image. See ARCHITECTURE-CLOUD.md.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from src.agent_service.search_engine import AudioSearchEngine
from src.query_translation import translate_to_english
from src.search_service.dataset_registry import DatasetRegistry

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Loading the encoders costs far more than a request, so it happens at startup
# rather than on the first query. Readiness stays false until it finishes, which
# is what lets Cloud Run hold traffic back instead of serving a slow request.
_registry: DatasetRegistry | None = None
_startup_error: str | None = None


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Consulta en lenguaje natural")
    k: int = Field(default=5, ge=1, le=50, description="Cantidad de segmentos")
    dataset_id: str | None = Field(
        default=None,
        description="Catálogo de datasets configurado en el servicio. Si se omite usa el default.",
    )


class AudioSearchRequest(SearchRequest):
    query_en: str | None = Field(
        default=None,
        min_length=1,
        description=(
            "Traducción inglesa previamente resuelta para repetir exactamente un plan. "
            "Si se omite, el servicio traduce query antes de buscar con CLAP o YAMNet."
        ),
    )


class SearchResponse(BaseModel):
    """Raw engine output: the agent-side serialization stays in tools.py."""

    results: list[dict]
    translated_query: str | None = None
    dataset_id: str | None = None
    dataset_label: str | None = None
    dataset_release: str | None = None


def _warm_up() -> DatasetRegistry:
    """Load the dataset catalog and the default dataset plus its text encoder.

    CLAP remains lazy because acoustic search is opt-in. Its first requested
    search may therefore take longer while the checkpoint is loaded.
    """
    registry = DatasetRegistry()
    # Text search is the default path, so readiness waits for that encoder only.
    registry.get_engine(registry.default_dataset_id()).text_model.generate_embedding("warm up")
    return registry


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global _registry, _startup_error
    try:
        _registry = _warm_up()
    except Exception as error:  # noqa: BLE001 - surfaced through /readyz
        # Swallowed so the container still binds a port and can report why it is
        # unhealthy; crashing would only produce an opaque restart loop.
        _startup_error = str(error)
        logger.exception("Search service failed to warm up")
    yield


app = FastAPI(
    title="audio-search-retrieval",
    description="Búsqueda por texto, CLAP y clases AudioSet/YAMNet del corpus de audio",
    version="0.1.0",
    lifespan=lifespan,
)


def _require_engine(dataset_id: str | None = None) -> AudioSearchEngine:
    if _registry is None:
        raise HTTPException(
            status_code=503,
            detail=f"Search engine unavailable: {_startup_error or 'still warming up'}",
        )
    try:
        return _registry.get_engine(dataset_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


def _dataset_meta(engine: AudioSearchEngine, dataset_id: str | None) -> dict[str, str | None]:
    if _registry is None:
        return {"dataset_id": dataset_id, "dataset_label": None, "dataset_release": None}
    resolved_id = dataset_id or _registry.default_dataset_id()
    entry = _registry.catalog_entry(resolved_id) or {}
    return {
        "dataset_id": resolved_id,
        "dataset_label": entry.get("label"),
        "dataset_release": entry.get("release_uri"),
    }


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness: the process is up, regardless of whether the models loaded."""
    return {"status": "healthy"}


@app.get("/readyz")
async def readyz() -> dict:
    """Readiness: true once the dataset, indices and default text encoder are loaded."""
    if _registry is None:
        raise HTTPException(status_code=503, detail=_startup_error or "warming up")
    engine = _require_engine()
    return {"status": "ready", "total_segments": engine.total_segments}


@app.get("/datasets")
async def datasets() -> dict:
    """List datasets available to the direct-search UI."""
    if _registry is None:
        raise HTTPException(status_code=503, detail=_startup_error or "warming up")
    return {"datasets": _registry.list_datasets()}


@app.get("/corpus")
async def corpus(dataset_id: str | None = None) -> dict:
    """Metadata needed by the direct-search UI; no corpus text is exposed here."""
    engine = _require_engine(dataset_id)
    return {
        "dataset_id": dataset_id or _registry.default_dataset_id() if _registry else None,
        "total_segments": engine.total_segments,
        "files": [],
        "active_indexes": engine.active_indexes,
        "dataset_version": engine.dataset_version,
    }


@app.post("/search/semantic", response_model=SearchResponse)
async def search_semantic(request: SearchRequest) -> SearchResponse:
    """Text search over the transcriptions."""
    engine = _require_engine(request.dataset_id)
    return SearchResponse(
        results=engine.search_semantic(request.query, k=request.k),
        **_dataset_meta(engine, request.dataset_id),
    )


@app.post("/search/audio", response_model=SearchResponse)
async def search_audio(request: AudioSearchRequest) -> SearchResponse:
    """Cross-modal text-to-audio search through CLAP.

    Fresh requests are translated to English here because CLAP's text encoder
    is English-language. ``query_en`` is accepted only to replay a previously
    returned search plan without translating it again.
    """
    engine = _require_engine(request.dataset_id)
    translated_query = request.query_en or translate_to_english(request.query)
    return SearchResponse(
        results=engine.search_audio_by_text(
            translated_query,
            k=request.k,
            source_language="en",
        ),
        translated_query=translated_query,
        **_dataset_meta(engine, request.dataset_id),
    )


@app.post("/search/yamnet", response_model=SearchResponse)
async def search_yamnet(request: AudioSearchRequest) -> SearchResponse:
    """Search the stored English AudioSet labels produced by YAMNet.

    This is label/classifier search rather than vector similarity. The service
    still translates fresh queries so Spanish terms can match AudioSet labels.
    """
    engine = _require_engine(request.dataset_id)
    translated_query = request.query_en or translate_to_english(request.query)
    return SearchResponse(
        results=engine.search_audio_by_classes(translated_query, k=request.k, source_language="en"),
        translated_query=translated_query,
        **_dataset_meta(engine, request.dataset_id),
    )


@app.get("/segments/{segment_id}")
async def get_segment(segment_id: int, dataset_id: str | None = None) -> dict:
    """Full metadata for one segment."""
    segment = _require_engine(dataset_id).get_segment_info(segment_id)
    if segment is None:
        raise HTTPException(status_code=404, detail=f"Segmento {segment_id} no encontrado.")
    return {"segment": segment}


@app.get("/segments/{segment_id}/audio-classes")
async def get_audio_classes(segment_id: int, dataset_id: str | None = None) -> dict:
    """YAMNet AudioSet labels stored for one segment.

    An empty list means the dataset was ingested without YAMNet enabled, which
    the caller reports differently from a missing segment.
    """
    classes = _require_engine(dataset_id).get_audio_classes(segment_id)
    if classes is None:
        raise HTTPException(status_code=404, detail=f"Segmento {segment_id} no encontrado.")
    return {"classes": classes}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
