"""Stage a versioned audio-search dataset from Cloud Storage when configured."""

from __future__ import annotations

import logging
import os
import shutil
import uuid
from pathlib import Path, PurePosixPath
from threading import Lock
from urllib.parse import urlparse

from google.cloud import storage

from src.segment_clips import CLIP_DIR_NAME

logger = logging.getLogger(__name__)

_GCS_URI_ENV = "DATASET_GCS_URI"
_SOURCE_MARKER = ".dataset_source_uri"
_REQUIRED_DATASET_FILE = Path("final/complete_dataset.pkl")
# Playback clips stay in the bucket and are fetched per request through
# ``src.segment_clip_storage``: staging them would make cold starts scale with
# the number of audio hours instead of with the index size.
_ON_DEMAND_PREFIXES = (f"{CLIP_DIR_NAME}/",)
_STAGING_LOCK = Lock()
_EPHEMERAL_ROOT = Path("/tmp").resolve()


def resolve_dataset_path(dataset_path: str | None = None) -> str:
    """Return a local dataset path, staging a GCS release when requested.

    ``DATASET_GCS_URI`` is optional to preserve local development. When set, it
    must refer to a GCS prefix and ``DATASET_PATH`` must be under ``/tmp``.
    FAISS then reads the fully downloaded local snapshot.
    """
    configured_path = Path(dataset_path or os.getenv("DATASET_PATH", "./dataset"))
    source_uri = os.getenv(_GCS_URI_ENV, "").strip()
    if not source_uri:
        return str(configured_path)

    destination = configured_path.resolve()
    if not destination.is_relative_to(_EPHEMERAL_ROOT):
        if (destination / _REQUIRED_DATASET_FILE).is_file():
            logger.warning(
                "DATASET_GCS_URI is set, but DATASET_PATH %s already exists locally; "
                "using it without staging from GCS.",
                destination,
            )
            return str(destination)
        raise ValueError(
            "DATASET_PATH must be under /tmp when DATASET_GCS_URI is configured. "
            "Example: /tmp/audio-search-dataset/2026-08-26"
        )

    bucket_name, prefix = _parse_gcs_uri(source_uri)
    with _STAGING_LOCK:
        if _is_current_snapshot(destination, source_uri):
            logger.info("Using cached dataset snapshot from %s at %s", source_uri, destination)
            return str(destination)

        staging = destination.with_name(f"{destination.name}.staging-{uuid.uuid4().hex}")
        try:
            _download_prefix(bucket_name, prefix, staging)
            if not (staging / _REQUIRED_DATASET_FILE).is_file():
                raise RuntimeError(
                    f"Dataset release {source_uri} is missing {_REQUIRED_DATASET_FILE}."
                )
            (staging / _SOURCE_MARKER).write_text(f"{source_uri}\n", encoding="utf-8")
            _replace_snapshot(staging, destination)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    logger.info("Staged dataset snapshot from %s at %s", source_uri, destination)
    return str(destination)


def stage_release(source_uri: str, destination: str | Path) -> str:
    """Stage a specific GCS release into ``destination`` and return the local path.

    Unlike ``resolve_dataset_path`` this targets an explicit release URI instead
    of the environment variable, allowing multiple releases to coexist on the same
    runtime.
    """
    destination_path = Path(destination).resolve()
    if not destination_path.is_relative_to(_EPHEMERAL_ROOT):
        raise ValueError(
            f"Dataset staging destination must be under {_EPHEMERAL_ROOT}, got {destination_path}"
        )

    bucket_name, prefix = _parse_gcs_uri(source_uri)
    with _STAGING_LOCK:
        if _is_current_snapshot(destination_path, source_uri):
            logger.info(
                "Using cached dataset snapshot from %s at %s", source_uri, destination_path
            )
            return str(destination_path)

        staging = destination_path.with_name(
            f"{destination_path.name}.staging-{uuid.uuid4().hex}"
        )
        try:
            _download_prefix(bucket_name, prefix, staging)
            if not (staging / _REQUIRED_DATASET_FILE).is_file():
                raise RuntimeError(
                    f"Dataset release {source_uri} is missing {_REQUIRED_DATASET_FILE}."
                )
            (staging / _SOURCE_MARKER).write_text(f"{source_uri}\n", encoding="utf-8")
            _replace_snapshot(staging, destination_path)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    logger.info("Staged dataset snapshot from %s at %s", source_uri, destination_path)
    return str(destination_path)


def _parse_gcs_uri(source_uri: str) -> tuple[str, str]:
    parsed = urlparse(source_uri)
    prefix = parsed.path.lstrip("/").rstrip("/")
    if parsed.scheme != "gs" or not parsed.netloc or not prefix:
        raise ValueError(
            "DATASET_GCS_URI must be a GCS prefix such as "
            "gs://your-bucket/releases/2026-08-26"
        )
    return parsed.netloc, prefix


def _is_current_snapshot(destination: Path, source_uri: str) -> bool:
    marker = destination / _SOURCE_MARKER
    try:
        return (
            marker.read_text(encoding="utf-8").strip() == source_uri
            and (destination / _REQUIRED_DATASET_FILE).is_file()
        )
    except FileNotFoundError:
        return False


def _download_prefix(bucket_name: str, prefix: str, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    prefix_with_separator = f"{prefix}/"
    blobs = storage.Client().list_blobs(bucket_name, prefix=prefix_with_separator)
    count = 0
    skipped = 0
    for blob in blobs:
        relative_name = blob.name.removeprefix(prefix_with_separator)
        if not relative_name:
            continue
        if relative_name.startswith(_ON_DEMAND_PREFIXES):
            skipped += 1
            continue
        relative_path = PurePosixPath(relative_name)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise RuntimeError(f"Unsafe object name in dataset release: {blob.name}")
        local_file = destination.joinpath(*relative_path.parts)
        local_file.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(str(local_file))
        count += 1

    if skipped:
        logger.info("Skipped %d on-demand objects (playback clips stay in the bucket)", skipped)
    if count == 0:
        raise RuntimeError(f"Dataset release {bucket_name}/{prefix} contains no objects.")


def _replace_snapshot(staging: Path, destination: Path) -> None:
    backup = destination.with_name(f"{destination.name}.previous-{uuid.uuid4().hex}")
    if destination.exists():
        destination.rename(backup)
    try:
        staging.rename(destination)
    except Exception:
        if backup.exists():
            backup.rename(destination)
        raise
    shutil.rmtree(backup, ignore_errors=True)
