import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { search } from "./api";
import { detectLocale, persistLocale, ui, type Locale, type UiCopy } from "./i18n";
import type { IndexResults, SearchIndex, SearchPlan, SearchResponse, SearchResult } from "./types";

const indexLabels = (copy: UiCopy): Record<SearchIndex, string> => ({
  text: copy.indexText,
  audio: copy.indexAudio,
  yamnet: copy.indexYamnet,
});
const resultSourceLabels = (copy: UiCopy): Record<SearchIndex, string> => ({
  text: copy.sourceText,
  audio: copy.sourceAudio,
  yamnet: copy.sourceYamnet,
});

const initialUrl = new URLSearchParams(window.location.search);
const legacyIndex = initialUrl.get("idx");
const initialIncludeText = initialUrl.has("text")
  ? initialUrl.get("text") !== "0"
  : true;
const initialIncludeClap = initialUrl.has("clap")
  ? initialUrl.get("clap") === "1"
  : legacyIndex === "audio" || legacyIndex === "both" || legacyIndex === "all";
const initialIncludeYamnet = initialUrl.has("yamnet")
  ? initialUrl.get("yamnet") === "1"
  : legacyIndex === "yamnet" || legacyIndex === "all";
const asTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};
const resultKey = (index: SearchIndex, result: SearchResult) => `${index}-${result.segment_id}-${result.rank}`;

function weakThreshold(index: SearchIndex): number | undefined {
  const source = index === "text"
    ? import.meta.env.VITE_WEAK_TEXT_SIMILARITY
    : index === "audio"
      ? import.meta.env.VITE_WEAK_AUDIO_SIMILARITY
      : import.meta.env.VITE_WEAK_YAMNET_SCORE;
  const value = Number(source);
  return Number.isFinite(value) && source !== undefined ? value : undefined;
}

function lowScoreWarningThreshold(): number {
  const configured = import.meta.env.VITE_LOW_SCORE_WARNING;
  const value = configured === undefined ? 0.1 : Number(configured);
  return Number.isFinite(value) && value >= 0 ? value : 0.1;
}

interface PlayerCommand { play: () => void; focus: () => void }

export default function App() {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const copy = ui[locale];
  const labels = indexLabels(copy);
  const [query, setQuery] = useState(initialUrl.get("q") ?? "");
  const [includeText, setIncludeText] = useState(initialIncludeText);
  const [includeClap, setIncludeClap] = useState(initialIncludeClap);
  const [includeYamnet, setIncludeYamnet] = useState(initialIncludeYamnet);
  const [k, setK] = useState(Number(initialUrl.get("k")) || 10);
  const [rewrite, setRewrite] = useState(true);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState(false);
  const [draftPlan, setDraftPlan] = useState<SearchPlan | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const playerCommands = useRef(new Map<string, PlayerCommand>());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[] | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    persistLocale(locale);
    document.title = copy.pageTitle;
  }, [copy.pageTitle, locale]);

  const changeLocale = (value: Locale) => setLocale(value);

  const selectedIndexes = useMemo<SearchIndex[]>(
    () => [
      ...(includeText ? ["text" as const] : []),
      ...(includeClap ? ["audio" as const] : []),
      ...(includeYamnet ? ["yamnet" as const] : []),
    ],
    [includeText, includeClap, includeYamnet],
  );
  const allResults = useMemo(() => selectedIndexes.flatMap(index =>
    (response?.indexes[index]?.results ?? []).map(result => ({ index, result })),
  ), [response, selectedIndexes]);

  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query.trim()); else url.searchParams.delete("q");
    url.searchParams.delete("idx");
    if (!includeText) url.searchParams.set("text", "0"); else url.searchParams.delete("text");
    if (includeClap) url.searchParams.set("clap", "1"); else url.searchParams.delete("clap");
    if (includeYamnet) url.searchParams.set("yamnet", "1"); else url.searchParams.delete("yamnet");
    url.searchParams.set("k", String(k));
    window.history.replaceState(null, "", url);
  }, [query, includeText, includeClap, includeYamnet, k]);

  const performSearch = useCallback(async (plan?: SearchPlan) => {
    const cleanedQuery = query.trim();
    if (!cleanedQuery) {
      setError(copy.searchError);
      return;
    }
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(null);
    setQueue(null);
    try {
      const result = await search({ query: cleanedQuery, include_text: includeText, include_clap: includeClap, include_yamnet: includeYamnet, k, rewrite, plan }, nextController.signal);
      setResponse(result);
      setDraftPlan(result.plan);
      setEditingPlan(false);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
    } finally {
      if (controller.current === nextController) setLoading(false);
    }
  }, [copy.searchError, includeText, includeClap, includeYamnet, k, query, rewrite]);

  const onSubmit = (event: FormEvent) => { event.preventDefault(); void performSearch(); };
  const changeSourceInclusion = (source: "text" | "clap" | "yamnet", enabled: boolean) => {
    if (!enabled && selectedIndexes.length === 1) {
      setError(copy.minimumIndexError);
      return;
    }
    setError(null);
    if (source === "text") setIncludeText(enabled);
    else if (source === "clap") setIncludeClap(enabled);
    else setIncludeYamnet(enabled);
    setResponse(null);
    setDraftPlan(null);
    setEditingPlan(false);
    setQueue(null);
  };

  useEffect(() => {
    if (!response) return;
    const expirations = Object.values(response.indexes)
      .flatMap(bucket => bucket?.results ?? [])
      .map(result => result.clip_expires_at ? new Date(result.clip_expires_at).getTime() : Number.NaN)
      .filter(Number.isFinite);
    if (!expirations.length) return;
    // Renew slightly before the signed URL expires, while the current plan still
    // represents the exact retrieval the journalist is reviewing.
    const delay = Math.max(1_000, Math.min(...expirations) - Date.now() - 30_000);
    const timer = window.setTimeout(() => void performSearch(response.plan), delay);
    return () => window.clearTimeout(timer);
  }, [performSearch, response]);

  const requestPlay = useCallback((audio: HTMLAudioElement) => {
    if (activeAudio.current && activeAudio.current !== audio) activeAudio.current.pause();
    activeAudio.current = audio;
  }, []);
  const registerPlayer = useCallback((key: string, command: PlayerCommand | null) => {
    if (command) playerCommands.current.set(key, command); else playerCommands.current.delete(key);
  }, []);
  const onPlayerFinished = useCallback((key: string) => {
    setQueue(current => {
      if (!current) return current;
      const position = current.indexOf(key);
      const next = current[position + 1];
      if (!next) return null;
      window.setTimeout(() => playerCommands.current.get(next)?.play(), 0);
      return current;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button")) return;
      if (!allResults.length) return;
      const current = Math.max(0, allResults.findIndex(item => resultKey(item.index, item.result) === focusedKey));
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        const key = resultKey(allResults[current].index, allResults[current].result);
        playerCommands.current.get(key)?.play();
      }
      if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
        event.preventDefault();
        const offset = event.key.toLowerCase() === "j" ? 1 : -1;
        const targetResult = allResults[Math.min(Math.max(current + offset, 0), allResults.length - 1)];
        const key = resultKey(targetResult.index, targetResult.result);
        setFocusedKey(key);
        playerCommands.current.get(key)?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [allResults, focusedKey]);

  const savePlan = () => {
    if (!draftPlan) return;
    const plan = { ...draftPlan, original_query: query, indexes: selectedIndexes };
    setDraftPlan(plan);
    void performSearch(plan);
  };
  const startContinuous = () => {
    const keys = allResults.map(item => resultKey(item.index, item.result));
    if (keys.length) {
      setQueue(keys);
      playerCommands.current.get(keys[0])?.play();
    }
  };

  return (
    <main className="shell">
      <header className="masthead">
        <div className="masthead-top"><p className="eyebrow">{copy.eyebrow}</p><LanguageSelector locale={locale} copy={copy} onChange={changeLocale} /></div>
        <h1>{copy.heading}</h1>
        <p className="lede">{copy.lead}</p>
        <p className="startup-note"><strong>{copy.startup}</strong> {copy.startupMessage}</p>
      </header>

      <section className="search-panel" aria-label={copy.search}>
        <form onSubmit={onSubmit}>
          <div className="search-line">
            <label className="sr-only" htmlFor="query">{copy.query}</label>
            <input id="query" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy.queryPlaceholder} autoFocus />
            <button className="primary" type="submit" disabled={loading}>{loading ? copy.searching : copy.searchButton}</button>
          </div>
          <div className="controls-row">
            <label className={`source-toggle source-toggle-text ${includeText ? "active" : ""}`}>
              <input type="checkbox" checked={includeText} onChange={event => changeSourceInclusion("text", event.target.checked)} />
              <span><strong>{copy.includeText}</strong><small>{copy.includeTextHelp}</small></span>
            </label>
            <label className={`source-toggle source-toggle-audio ${includeClap ? "active" : ""}`}>
              <input type="checkbox" checked={includeClap} onChange={event => changeSourceInclusion("clap", event.target.checked)} />
              <span><strong>{copy.includeClap}</strong><small>{copy.includeClapHelp}</small></span>
            </label>
            <label className={`source-toggle source-toggle-yamnet ${includeYamnet ? "active" : ""}`}>
              <input type="checkbox" checked={includeYamnet} onChange={event => changeSourceInclusion("yamnet", event.target.checked)} />
              <span><strong>{copy.includeYamnet}</strong><small>{copy.includeYamnetHelp}</small></span>
            </label>
            <label className="toggle"><input type="checkbox" checked={rewrite} onChange={event => setRewrite(event.target.checked)} /> {copy.rewrite}</label>
            <label className="k-picker">{copy.results}
              <select value={k} onChange={event => setK(Number(event.target.value))}>{[5, 10, 20, 50].map(value => <option key={value} value={value}>{value}</option>)}</select>
            </label>
          </div>
        </form>
      </section>

      {response && <PlanPanel copy={copy} plan={draftPlan ?? response.plan} editing={editingPlan} onEdit={() => setEditingPlan(true)} onChange={setDraftPlan} onCancel={() => { setDraftPlan(response.plan); setEditingPlan(false); }} onSave={savePlan} />}
      {error && <p className="notice error" role="alert">{error}</p>}
      {loading && <p className="notice">{`${copy.searching.replace("…", "")} ${selectedIndexes.map(index => labels[index]).join(", ")}.${includeClap ? copy.loadingClap : ""}`}</p>}

      {response && <>
        <div className="result-toolbar">
          <p><strong>{allResults.length}</strong> {allResults.length === 1 ? copy.result : copy.resultsPlural} · {response.took_ms} ms</p>
          {allResults.length > 1 && <button className="quiet" onClick={startContinuous}>{queue ? copy.playing : copy.playAll}</button>}
        </div>
        <Filters copy={copy} fileFilter={fileFilter} setFileFilter={setFileFilter} fromTime={fromTime} setFromTime={setFromTime} toTime={toTime} setToTime={setToTime} />
        <section className="result-columns" aria-label={copy.results}>
          {selectedIndexes.map(index => <ResultColumn copy={copy} key={index} index={index} bucket={response.indexes[index]} fileFilter={fileFilter} fromTime={fromTime} toTime={toTime} focusedKey={focusedKey} setFocusedKey={setFocusedKey} requestPlay={requestPlay} registerPlayer={registerPlayer} onPlayerFinished={onPlayerFinished} />)}
        </section>
      </>}
    </main>
  );
}

function LanguageSelector({ locale, copy, onChange }: { locale: Locale; copy: UiCopy; onChange: (locale: Locale) => void }) {
  return <label className="language-selector"><span>{copy.language}</span><select value={locale} onChange={event => onChange(event.target.value as Locale)} aria-label={copy.language}><option value="es">{copy.spanish}</option><option value="en">{copy.english}</option></select></label>;
}

function PlanPanel({ copy, plan, editing, onEdit, onChange, onCancel, onSave }: { copy: UiCopy; plan: SearchPlan; editing: boolean; onEdit: () => void; onChange: (value: SearchPlan) => void; onCancel: () => void; onSave: () => void }) {
  const copyPlan = async () => { await navigator.clipboard?.writeText(JSON.stringify(plan, null, 2)); };
  return <section className="plan" aria-label={copy.effectivePlan}>
    <div><p className="eyebrow">{copy.effectivePlan}</p><p className="plan-hint">{copy.planHint}</p></div>
    {editing ? <div className="plan-editor">
      {plan.indexes.includes("text") && <label>{copy.textQuery}<input value={plan.text_query ?? ""} onChange={event => onChange({ ...plan, text_query: event.target.value })} /></label>}
      {plan.indexes.includes("audio") && <><label>{copy.acousticDescription}<input value={plan.audio_query ?? ""} onChange={event => onChange({ ...plan, audio_query: event.target.value, audio_query_en: undefined })} /></label>{plan.audio_query_en && <p className="translated-plan">{copy.fixedClapTranslation} “{plan.audio_query_en}”. {copy.updateDescription}</p>}</>}
      {plan.indexes.includes("yamnet") && <><label>{copy.yamnetClasses}<input value={plan.yamnet_query ?? ""} onChange={event => onChange({ ...plan, yamnet_query: event.target.value, yamnet_query_en: undefined })} /></label>{plan.yamnet_query_en && <p className="translated-plan">{copy.fixedYamnetTranslation} “{plan.yamnet_query_en}”. {copy.updateYamnet}</p>}</>}
      <div className="inline-actions"><button className="primary" onClick={onSave}>{copy.applyPlan}</button><button className="quiet" onClick={onCancel}>{copy.cancel}</button></div>
    </div> : <div className="plan-summary">
      {plan.text_query && <span><b>{copy.text}</b> “{plan.text_query}”</span>}
      {plan.audio_query && <span><b>{copy.audio}</b> “{plan.audio_query}”</span>}
      {plan.audio_query_en && <span className="translation">{copy.clapSearchedEnglish} “{plan.audio_query_en}”</span>}
      {plan.yamnet_query && <span><b>YAMNet</b> “{plan.yamnet_query}”</span>}
      {plan.yamnet_query_en && <span className="translation">{copy.yamnetSearchedEnglish} “{plan.yamnet_query_en}”</span>}
      {plan.rationale && <span className="rationale">{plan.rationale}</span>}
      <button className="quiet" onClick={() => void copyPlan()}>{copy.copyPlan}</button><button className="quiet" onClick={onEdit}>{copy.editPlan}</button>
    </div>}
  </section>;
}

function Filters({ copy, fileFilter, setFileFilter, fromTime, setFromTime, toTime, setToTime }: { copy: UiCopy; fileFilter: string; setFileFilter: (value: string) => void; fromTime: string; setFromTime: (value: string) => void; toTime: string; setToTime: (value: string) => void }) {
  return <div className="filters" aria-label={copy.resultFilters}>
    <label>{copy.file}<input value={fileFilter} onChange={event => setFileFilter(event.target.value)} placeholder={copy.filePlaceholder} /></label>
    <label>{copy.from}<input type="number" min="0" value={fromTime} onChange={event => setFromTime(event.target.value)} /></label>
    <label>{copy.until}<input type="number" min="0" value={toTime} onChange={event => setToTime(event.target.value)} /></label>
  </div>;
}

function ResultColumn({ copy, index, bucket, fileFilter, fromTime, toTime, focusedKey, setFocusedKey, requestPlay, registerPlayer, onPlayerFinished }: { copy: UiCopy; index: SearchIndex; bucket?: IndexResults; fileFilter: string; fromTime: string; toTime: string; focusedKey: string | null; setFocusedKey: (key: string) => void; requestPlay: (audio: HTMLAudioElement) => void; registerPlayer: (key: string, command: PlayerCommand | null) => void; onPlayerFinished: (key: string) => void }) {
  const labels = indexLabels(copy);
  const [open, setOpen] = useState(true);
  const results = (bucket?.results ?? []).filter(result => {
    const matchesFile = result.original_file_name.toLocaleLowerCase().includes(fileFilter.toLocaleLowerCase());
    const afterStart = !fromTime || result.end_time >= Number(fromTime);
    const beforeEnd = !toTime || result.start_time <= Number(toTime);
    return matchesFile && afterStart && beforeEnd;
  });
  const topSimilarity = results[0]?.similarity ?? 0;
  const threshold = weakThreshold(index);
  const contentId = `results-${index}`;
  return <section className={`result-column result-column-${index}${open ? "" : " is-collapsed"}`}>
    <header>
      <button className="column-toggle" type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(current => !current)}>
        <span className="column-heading"><span className={`source-badge source-${index}`}>{labels[index]}</span><strong>{results.length} resultado{results.length === 1 ? "" : "s"}</strong></span>
        <span className="collapse-indicator" aria-hidden="true">{open ? copy.hide : copy.show} <b>{open ? "−" : "+"}</b></span>
      </button>
      {bucket?.effective_query && <p className="effective-query">{copy.queryLabel} “{bucket.effective_query}”</p>}
      {index !== "text" && bucket?.translated_query && <p className="effective-query">{copy.inEnglish} “{bucket.translated_query}”</p>}
    </header>
    {open && <div className="result-column-body" id={contentId}>
      {!bucket ? <p className="empty">{copy.noIndexResponse}</p> : !bucket.available ? <p className="notice error">{copy.indexUnavailable}{bucket.error ? ` ${bucket.error}` : ""}</p> : bucket.error ? <p className="notice error">{bucket.error}</p> : threshold !== undefined && results[0] && results[0].similarity < threshold ? <p className="notice">{copy.weakMatches}</p> : null}
      {bucket?.available && !bucket.error && results.length === 0 && <p className="empty">{copy.noFilteredResults}</p>}
      <div className="cards">{results.map(result => <ResultCard copy={copy} key={resultKey(index, result)} result={result} index={index} topSimilarity={topSimilarity} focused={focusedKey === resultKey(index, result)} onFocus={() => setFocusedKey(resultKey(index, result))} requestPlay={requestPlay} registerPlayer={registerPlayer} onPlayerFinished={onPlayerFinished} />)}</div>
    </div>}
  </section>;
}

function ResultCard({ copy, result, index, topSimilarity, focused, onFocus, requestPlay, registerPlayer, onPlayerFinished }: { copy: UiCopy; result: SearchResult; index: SearchIndex; topSimilarity: number; focused: boolean; onFocus: () => void; requestPlay: (audio: HTMLAudioElement) => void; registerPlayer: (key: string, command: PlayerCommand | null) => void; onPlayerFinished: (key: string) => void }) {
  const labels = indexLabels(copy);
  const sources = resultSourceLabels(copy);
  const key = resultKey(index, result);
  const citation = `${result.original_file_name} · ${asTime(result.start_time)}–${asTime(result.end_time)} · segment_id ${result.segment_id} · índice ${result.search_index_label ?? labels[index]}`;
  const normalized = topSimilarity > 0 ? Math.max(0, Math.min(100, (result.similarity / topSimilarity) * 100)) : 0;
  const isLowScore = result.similarity < lowScoreWarningThreshold();
  const scoreHelp = index === "yamnet"
    ? copy.yamnetScoreHelp
    : copy.similarityHelp;
  const copyCitation = async () => { await navigator.clipboard?.writeText(citation); };
  return <article className={`result-card${focused ? " is-focused" : ""}${isLowScore ? " is-low-score" : ""}`} tabIndex={0} onFocus={onFocus}>
    <div className="card-top"><span className={`source-badge source-${index}`} title={copy.resultOrigin}>{sources[index]}</span><span className="rank">#{result.rank}</span><div className={`score${isLowScore ? " is-low" : ""}`} title={scoreHelp}><span><i style={{ width: `${normalized}%` }} /></span><small>{result.similarity.toFixed(3)}</small></div>{isLowScore && <span className="low-score-warning" title={copy.reviewScore.replace("{threshold}", lowScoreWarningThreshold().toFixed(2))}>{copy.lowScore}</span>}</div>
    <h3 title={result.original_file_name}>{result.original_file_name}</h3>
    <p className="timestamp">{asTime(result.start_time)} → {asTime(result.end_time)} <span>({Math.round(result.duration ?? result.end_time - result.start_time)} s)</span></p>
    {result.yamnet_audio_classes?.length ? <p className="yamnet"><b>{copy.audioSetLabels}</b> {result.yamnet_audio_classes.slice(0, 3).map(item => `${item.label ?? item.class_name ?? "event"} ${item.score.toFixed(2)}`).join(" · ")}</p> : null}
    {result.clip_url ? <AudioPlayer copy={copy} id={key} result={result} preload={result.rank === 1} requestPlay={requestPlay} registerPlayer={registerPlayer} onFinished={() => onPlayerFinished(key)} /> : <p className="missing-audio">{copy.audioUnavailable}</p>}
    <p className="transcript">“{result.text || copy.noTranscript}”</p>
    {index === "yamnet" && result.yamnet_matched_classes?.length ? <p className="yamnet matched"><b>{copy.matches}</b> {result.yamnet_matched_classes.map(item => `${item.label ?? item.class_name ?? "event"} ${item.score.toFixed(2)}`).join(" · ")}</p> : null}
    <div className="card-actions"><button className="quiet" onClick={() => void copyCitation()}>{copy.copyCitation}</button>{result.clip_url && <a className="quiet" href={result.clip_url} download={`segment_${result.segment_id}.opus`}>{copy.download}</a>}<span title={citation}>ID {result.segment_id}</span></div>
  </article>;
}

function AudioPlayer({ copy, id, result, preload, requestPlay, registerPlayer, onFinished }: { copy: UiCopy; id: string; result: SearchResult; preload: boolean; requestPlay: (audio: HTMLAudioElement) => void; registerPlayer: (key: string, command: PlayerCommand | null) => void; onFinished: () => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const clipStart = result.clip_start_time ?? result.start_time;
  const clipEnd = result.clip_end_time ?? result.end_time;
  const rangeStart = context ? Math.max(clipStart, result.start_time - 10) : result.start_time;
  const rangeEnd = context ? Math.min(clipEnd, result.end_time + 10) : result.end_time;
  const startOffset = Math.max(0, rangeStart - clipStart);
  const endOffset = Math.max(startOffset + 0.1, rangeEnd - clipStart);
  const progress = Math.max(0, Math.min(100, ((position - startOffset) / (endOffset - startOffset)) * 100));
  const play = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    requestPlay(element);
    if (element.currentTime < startOffset || element.currentTime >= endOffset) element.currentTime = startOffset;
    void element.play().catch(() => setPlaying(false));
  }, [endOffset, requestPlay, startOffset]);
  useEffect(() => { registerPlayer(id, { play, focus: () => root.current?.focus() }); return () => registerPlayer(id, null); }, [id, play, registerPlayer]);
  useEffect(() => { const element = audio.current; if (element) { element.pause(); element.currentTime = startOffset; } setPlaying(false); setPosition(startOffset); }, [startOffset, endOffset]);
  const toggle = () => { if (audio.current?.paused) play(); else audio.current?.pause(); };
  return <div className="audio-player" ref={root} tabIndex={-1}>
    <audio ref={audio} preload={preload ? "auto" : "metadata"} src={`${result.clip_url}#t=${startOffset},${endOffset}`} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={event => { const time = event.currentTarget.currentTime; setPosition(time); if (time >= endOffset) { event.currentTarget.pause(); onFinished(); } }} onEnded={onFinished} />
    <button className="play" onClick={toggle} aria-label={playing ? copy.pauseSegment : copy.playSegment}>{playing ? "❚❚" : "▶"}</button>
    <input aria-label={copy.audioProgress} type="range" min={startOffset} max={endOffset} step="0.1" value={Math.min(Math.max(position, startOffset), endOffset)} style={{ "--progress": `${progress}%` } as CSSProperties} onChange={event => { const value = Number(event.target.value); if (audio.current) audio.current.currentTime = value; setPosition(value); }} />
    <time>{asTime(Math.max(0, position - startOffset))}</time>
    <button className={`context ${context ? "active" : ""}`} onClick={() => setContext(value => !value)} title={copy.extendListening}>±10 s</button>
  </div>;
}
