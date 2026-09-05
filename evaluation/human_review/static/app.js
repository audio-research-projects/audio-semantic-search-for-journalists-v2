const state = {
  data: null,
  queryIndex: 0,
  candidateIndex: 0,
  annotations: new Map(),
};

const localeKey = "audio-search-locale";
const translations = {
  es: {
    title: "Búsqueda semántica sobre audios de archivo periodístico", eyebrow: "Evaluación humana", heading: "Retrieval acústico periodístico", language: "Idioma", reviewer: "Revisor", export: "Exportar JSON", saved: "juicios guardados", questions: "consultas", previous: "Consulta anterior", next: "Consulta siguiente", clapQuery: "Consulta enviada al encoder textual de CLAP", target: "Evento o propiedad buscada", method: "El ranking es solo una selección de candidatos. Escuchá el audio antes de asignar relevancia; no uses la transcripción como sustituto del sonido.", candidate: "Candidato", segment: "Segmento", originalRank: "rank original", source: "Fuente", time: "Tiempo", transcript: "Transcripción auxiliar", relevance: "Relevancia para la consulta", grades: ["Irrelevante", "Tangencial", "Relevante", "Directa"], eventPresent: "¿Está presente el evento?", unknown: "No se puede determinar", yes: "Sí", no: "No", confidence: "Confianza", confidenceValues: ["Muy baja", "Baja", "Media", "Alta", "Muy alta"], notes: "Notas", notesPlaceholder: "Ambigüedades, sonidos concurrentes o motivo de la decisión", save: "Guardar y continuar", savedStatus: "Juicio ya guardado", saving: "Guardando…", saveError: "No se pudo guardar", loadError: "No se pudo cargar la muestra de revisión", transcriptMissing: "Sin transcripción", yamnetOn: "disponible", yamnetOff: "no activo",
  },
  en: {
    title: "Semantic Search Across Journalistic Audio Archives", eyebrow: "Human review", heading: "Journalistic acoustic retrieval", language: "Language", reviewer: "Reviewer", export: "Export JSON", saved: "saved judgments", questions: "queries", previous: "Previous query", next: "Next query", clapQuery: "Query sent to CLAP's text encoder", target: "Sought event or property", method: "The ranking is only a candidate selection. Listen to the audio before assigning relevance; do not use the transcript as a substitute for sound.", candidate: "Candidate", segment: "Segment", originalRank: "original rank", source: "Source", time: "Time", transcript: "Supporting transcript", relevance: "Relevance to the query", grades: ["Irrelevant", "Tangential", "Relevant", "Direct"], eventPresent: "Is the event present?", unknown: "Cannot determine", yes: "Yes", no: "No", confidence: "Confidence", confidenceValues: ["Very low", "Low", "Medium", "High", "Very high"], notes: "Notes", notesPlaceholder: "Ambiguities, concurrent sounds, or rationale for the decision", save: "Save and continue", savedStatus: "Judgment already saved", saving: "Saving…", saveError: "Could not save", loadError: "Could not load the review sample", transcriptMissing: "No transcript", yamnetOn: "available", yamnetOff: "inactive",
  },
};
const browserLocale = () => navigator.languages.some((language) => language.toLowerCase().startsWith("en")) ? "en" : "es";
let locale = (() => { const saved = localStorage.getItem(localeKey); return saved === "en" || saved === "es" ? saved : browserLocale(); })();
const copy = () => translations[locale];

const byId = (id) => document.getElementById(id);
const annotationKey = (reviewer, caseId, segmentId) => `${reviewer}:${caseId}:${segmentId}`;
const currentReviewer = () => byId("reviewer").value || "anonymous";

function renderLanguage() {
  const t = copy();
  document.documentElement.lang = locale;
  document.title = t.title;
  byId("language-selector").value = locale;
  const fields = { eyebrow: t.eyebrow, "page-heading": t.heading, "language-label": t.language, "reviewer-label": t.reviewer, "export-link": t.export, "saved-label": t.saved, "questions-label": t.questions, "clap-query-label": t.clapQuery, "target-label": t.target, "method-note": t.method, "candidate-label": t.candidate, "segment-label": t.segment, "original-rank-label": t.originalRank, "source-label": t.source, "time-label": t.time, "transcript-label": t.transcript, "relevance-label": t.relevance, "event-present-label": t.eventPresent, "confidence-label": t.confidence, "notes-label": t.notes, "save-button": t.save };
  Object.entries(fields).forEach(([id, value]) => { byId(id).textContent = value; });
  t.grades.forEach((value, index) => { byId(`grade-${index}`).textContent = value; });
  byId("event-unknown").textContent = t.unknown;
  byId("event-yes").textContent = t.yes;
  byId("event-no").textContent = t.no;
  t.confidenceValues.forEach((value, index) => { byId(`confidence-${index + 1}`).textContent = `${index + 1} · ${value}`; });
  byId("notes").placeholder = t.notesPlaceholder;
  byId("previous-query").title = t.previous;
  byId("next-query").title = t.next;
}

function currentCase() {
  return state.data.cases[state.queryIndex];
}

function currentCandidate() {
  return currentCase().candidates[state.candidateIndex];
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function updateProgress() {
  const total = state.data.sample_composition.candidate_judgments;
  const reviewerPrefix = `${currentReviewer()}:`;
  const saved = [...state.annotations.keys()].filter((key) => key.startsWith(reviewerPrefix)).length;
  byId("progress-count").textContent = `${saved} / ${total}`;
  byId("progress-bar").style.width = `${total ? (saved / total) * 100 : 0}%`;
}

function clearForm() {
  document.querySelectorAll('input[name="relevance"]').forEach((input) => {
    input.checked = false;
  });
  byId("event-present").value = "unknown";
  byId("confidence").value = "3";
  byId("notes").value = "";
  byId("save-status").textContent = "";
}

function restoreAnnotation() {
  const item = currentCandidate();
  const annotation = state.annotations.get(
    annotationKey(currentReviewer(), currentCase().eval_case_id, item.segment.segment_id),
  );
  if (!annotation) return;
  const radio = document.querySelector(`input[name="relevance"][value="${annotation.relevance}"]`);
  if (radio) radio.checked = true;
  byId("event-present").value =
    annotation.event_present === null ? "unknown" : String(annotation.event_present);
  byId("confidence").value = String(annotation.confidence);
  byId("notes").value = annotation.notes || "";
  byId("save-status").textContent = copy().savedStatus;
}

function render() {
  const reviewCase = currentCase();
  const candidate = currentCandidate();
  const segment = candidate.segment;
  byId("query-position").textContent = `${state.queryIndex + 1} / ${state.data.cases.length}`;
  byId("candidate-position").textContent = `${state.candidateIndex + 1} / ${reviewCase.candidates.length}`;
  byId("category").textContent = reviewCase.category.replaceAll("_", " ");
  byId("question").textContent = reviewCase.question;
  byId("clap-query").textContent = reviewCase.clap_query_en;
  byId("target-description").textContent = reviewCase.target_description;
  byId("segment-id").textContent = segment.segment_id;
  byId("similarity").textContent = candidate.similarity.toFixed(4);
  byId("stratum").textContent = candidate.stratum.replaceAll("_", " ");
  byId("original-rank").textContent = candidate.rank;
  byId("source").textContent = segment.original_file_name;
  byId("time-range").textContent = `${formatTime(segment.start_time)}–${formatTime(segment.end_time)}`;
  byId("transcript").textContent = segment.text || copy().transcriptMissing;
  byId("audio").src = segment.clip_url;
  clearForm();
  restoreAnnotation();
  updateProgress();
}

function moveCandidate(delta) {
  const reviewCase = currentCase();
  const next = state.candidateIndex + delta;
  if (next >= 0 && next < reviewCase.candidates.length) {
    state.candidateIndex = next;
  } else if (delta > 0 && state.queryIndex < state.data.cases.length - 1) {
    state.queryIndex += 1;
    state.candidateIndex = 0;
  } else if (delta < 0 && state.queryIndex > 0) {
    state.queryIndex -= 1;
    state.candidateIndex = state.data.cases[state.queryIndex].candidates.length - 1;
  }
  render();
}

function moveQuery(delta) {
  const next = Math.max(0, Math.min(state.data.cases.length - 1, state.queryIndex + delta));
  state.queryIndex = next;
  state.candidateIndex = 0;
  render();
}

async function saveAnnotation(event) {
  event.preventDefault();
  const relevance = document.querySelector('input[name="relevance"]:checked');
  if (!relevance) return;
  const reviewCase = currentCase();
  const segment = currentCandidate().segment;
  const eventValue = byId("event-present").value;
  const payload = {
    eval_case_id: reviewCase.eval_case_id,
    segment_id: segment.segment_id,
    relevance: Number(relevance.value),
    event_present: eventValue === "unknown" ? null : eventValue === "true",
    confidence: Number(byId("confidence").value),
    notes: byId("notes").value,
    reviewer: byId("reviewer").value || "anonymous",
  };
  byId("save-status").textContent = copy().saving;
  const response = await fetch("/api/annotations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    byId("save-status").textContent = copy().saveError;
    return;
  }
  const result = await response.json();
  state.annotations.set(
    annotationKey(payload.reviewer, payload.eval_case_id, payload.segment_id),
    result.annotation,
  );
  updateProgress();
  moveCandidate(1);
}

async function initialize() {
  const response = await fetch("/api/review-set");
  if (!response.ok) throw new Error(copy().loadError);
  state.data = await response.json();
  state.data.saved_annotations.forEach((annotation) => {
    state.annotations.set(
      annotationKey(annotation.reviewer || "anonymous", annotation.eval_case_id, annotation.segment_id),
      annotation,
    );
  });
  byId("question-count").textContent = state.data.sample_composition.questions;
  byId("yamnet-status").textContent = state.data.configuration.yamnet_available
    ? copy().yamnetOn
    : copy().yamnetOff;
  render();
}

byId("annotation-form").addEventListener("submit", saveAnnotation);
byId("previous-query").addEventListener("click", () => moveQuery(-1));
byId("next-query").addEventListener("click", () => moveQuery(1));
byId("reviewer").addEventListener("change", render);
byId("language-selector").addEventListener("change", (event) => {
  locale = event.target.value === "en" ? "en" : "es";
  localStorage.setItem(localeKey, locale);
  renderLanguage();
  if (state.data) render();
});
document.addEventListener("keydown", (event) => {
  if (["0", "1", "2", "3"].includes(event.key) && document.activeElement.tagName !== "TEXTAREA") {
    const radio = document.querySelector(`input[name="relevance"][value="${event.key}"]`);
    if (radio) radio.checked = true;
  }
  if (event.key === "ArrowRight") moveCandidate(1);
  if (event.key === "ArrowLeft") moveCandidate(-1);
});

renderLanguage();
initialize().catch((error) => {
  byId("question").textContent = error.message;
});
