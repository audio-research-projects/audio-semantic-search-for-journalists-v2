import asyncio

from src.search_service import app as search_app


class _FakeSearchEngine:
    total_segments = 3

    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str | None]] = []

    def search_audio_by_text(
        self,
        query: str,
        k: int,
        *,
        source_language: str | None = None,
    ) -> list[dict]:
        self.calls.append((query, k, source_language))
        return []


class _FakeRegistry:
    def __init__(self, engine: _FakeSearchEngine) -> None:
        self._engine = engine

    def default_dataset_id(self) -> str:
        return "default"

    def catalog_entry(self, dataset_id: str) -> dict | None:
        return {"id": "default", "label": "Default", "release_uri": "gs://test/releases/default"}

    def get_engine(self, dataset_id: str | None = None) -> _FakeSearchEngine:
        return self._engine


def test_audio_search_translates_before_calculating_the_clap_embedding(monkeypatch):
    engine = _FakeSearchEngine()
    monkeypatch.setattr(search_app, "_registry", _FakeRegistry(engine))
    monkeypatch.setattr(
        search_app,
        "translate_to_english",
        lambda query: "applause after the speech",
    )

    response = asyncio.run(
        search_app.search_audio(
            search_app.AudioSearchRequest(query="aplausos al terminar el discurso", k=7)
        )
    )

    assert engine.calls == [("applause after the speech", 7, "en")]
    assert response.translated_query == "applause after the speech"


def test_audio_search_reuses_a_saved_english_query_without_retranslating(monkeypatch):
    engine = _FakeSearchEngine()
    monkeypatch.setattr(search_app, "_registry", _FakeRegistry(engine))

    def unexpected_translation(query: str) -> str:
        raise AssertionError(f"unexpected translation for {query}")

    monkeypatch.setattr(search_app, "translate_to_english", unexpected_translation)
    response = asyncio.run(
        search_app.search_audio(
            search_app.AudioSearchRequest(
                query="aplausos",
                query_en="audience applause",
                k=5,
            )
        )
    )

    assert engine.calls == [("audience applause", 5, "en")]
    assert response.translated_query == "audience applause"


def test_warm_up_does_not_load_clap_when_acoustic_search_is_not_requested(monkeypatch):
    encoded: list[str] = []

    class _TextModel:
        def generate_embedding(self, text: str):
            encoded.append(text)

    class _WarmEngine:
        total_segments = 2
        text_model = _TextModel()

        @property
        def clap_model(self):
            raise AssertionError("CLAP must remain lazy")

    engine = _WarmEngine()

    class _FakeRegistryClass:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def default_dataset_id(self) -> str:
            return "default"

        def get_engine(self, dataset_id: str | None = None) -> _WarmEngine:
            return engine

    monkeypatch.setattr(search_app, "DatasetRegistry", _FakeRegistryClass)

    registry = search_app._warm_up()

    assert registry.get_engine().total_segments == 2
    assert encoded == ["warm up"]
