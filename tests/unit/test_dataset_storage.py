from __future__ import annotations

import shutil
import uuid
from pathlib import Path

import pytest

from src import dataset_storage


class _FakeBlob:
    def __init__(self, name: str, content: bytes):
        self.name = name
        self._content = content

    def download_to_filename(self, filename: str) -> None:
        Path(filename).write_bytes(self._content)


class _FakeStorageClient:
    def __init__(self, blobs: list[_FakeBlob], expected_prefix: str = "releases/v1/"):
        self._blobs = blobs
        self._expected_prefix = expected_prefix

    def list_blobs(self, bucket_name: str, prefix: str):
        assert bucket_name == "your-test-bucket"
        assert prefix == self._expected_prefix
        return self._blobs


def test_resolve_dataset_path_downloads_gcs_snapshot_atomically(monkeypatch):
    target = Path("/tmp") / f"audio-search-dataset-{uuid.uuid4().hex}"
    blobs = [
        _FakeBlob("releases/v1/final/complete_dataset.pkl", b"dataset"),
        _FakeBlob("releases/v1/indices/text_index.faiss", b"index"),
    ]
    monkeypatch.setenv("DATASET_GCS_URI", "gs://your-test-bucket/releases/v1")
    monkeypatch.setenv("DATASET_PATH", str(target))
    monkeypatch.setattr(dataset_storage.storage, "Client", lambda: _FakeStorageClient(blobs))

    try:
        resolved = Path(dataset_storage.resolve_dataset_path())

        assert resolved == target.resolve()
        assert (target / "final/complete_dataset.pkl").read_bytes() == b"dataset"
        assert (target / "indices/text_index.faiss").read_bytes() == b"index"
        assert (
            target / ".dataset_source_uri"
        ).read_text() == "gs://your-test-bucket/releases/v1\n"
    finally:
        shutil.rmtree(target, ignore_errors=True)


def test_resolve_dataset_path_leaves_playback_clips_in_the_bucket(monkeypatch):
    target = Path("/tmp") / f"audio-search-dataset-{uuid.uuid4().hex}"
    blobs = [
        _FakeBlob("releases/v1/final/complete_dataset.pkl", b"dataset"),
        _FakeBlob("releases/v1/indices/text_index.faiss", b"index"),
        _FakeBlob("releases/v1/segment_clips/segment_0.opus", b"clip"),
    ]
    monkeypatch.setenv("DATASET_GCS_URI", "gs://your-test-bucket/releases/v1")
    monkeypatch.setenv("DATASET_PATH", str(target))
    monkeypatch.setattr(dataset_storage.storage, "Client", lambda: _FakeStorageClient(blobs))

    try:
        dataset_storage.resolve_dataset_path()

        assert (target / "final/complete_dataset.pkl").is_file()
        assert not (target / "segment_clips").exists(), "clips must be fetched on demand"
    finally:
        shutil.rmtree(target, ignore_errors=True)


def test_resolve_dataset_path_rejects_non_ephemeral_gcs_destination(monkeypatch):
    monkeypatch.setenv("DATASET_GCS_URI", "gs://your-test-bucket/releases/v1")
    monkeypatch.setenv("DATASET_PATH", "/some/local-dataset")

    with pytest.raises(ValueError, match="must be under /tmp"):
        dataset_storage.resolve_dataset_path()


def test_resolve_dataset_path_keeps_local_development_path(monkeypatch):
    monkeypatch.delenv("DATASET_GCS_URI", raising=False)
    monkeypatch.setenv("DATASET_PATH", "./dataset")

    assert dataset_storage.resolve_dataset_path() == "dataset"


def test_stage_release_downloads_explicit_release_uri(monkeypatch):
    target = Path("/tmp") / f"audio-search-staging-{uuid.uuid4().hex}"
    blobs = [
        _FakeBlob("releases/v2/final/complete_dataset.pkl", b"dataset"),
        _FakeBlob("releases/v2/indices/text_index.faiss", b"index"),
    ]
    monkeypatch.setattr(dataset_storage.storage, "Client", lambda: _FakeStorageClient(blobs, expected_prefix="releases/v2/"))

    try:
        resolved = Path(dataset_storage.stage_release("gs://your-test-bucket/releases/v2", target))

        assert resolved == target.resolve()
        assert (target / "final/complete_dataset.pkl").read_bytes() == b"dataset"
        assert (target / "indices/text_index.faiss").read_bytes() == b"index"
    finally:
        shutil.rmtree(target, ignore_errors=True)


def test_stage_release_rejects_non_ephemeral_destination():
    with pytest.raises(ValueError, match="must be under"):
        dataset_storage.stage_release("gs://your-test-bucket/releases/v2", "/some/path")
