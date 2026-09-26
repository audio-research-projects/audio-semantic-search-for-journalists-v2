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

export interface AudioClass {
  class_id?: string;
  label?: string;
  class_name?: string;
  score: number;
}

export interface SearchResult {
  segment_id: number;
  text: string;
  start_time: number;
  end_time: number;
  duration?: number;
  original_file_name: string;
  language?: string;
  confidence?: number;
  similarity: number;
  rank: number;
  search_index: SearchIndex;
  search_index_label?: string;
  clip_url?: string;
  clip_start_time?: number;
  clip_end_time?: number;
  clip_expires_at?: string;
  yamnet_audio_classes?: AudioClass[];
  yamnet_matched_classes?: AudioClass[];
}

export interface IndexResults {
  available: boolean;
  effective_query?: string;
  translated_query?: string;
  results: SearchResult[];
  error?: string;
}

export interface DatasetInfo {
  id: string;
  label: string;
  language: string;
  active_indexes: SearchIndex[];
  dataset_version?: string;
}

export interface DatasetsResponse {
  datasets: DatasetInfo[];
}

export interface SearchResponse {
  query: string;
  dataset_id?: string;
  dataset_label?: string;
  dataset_release?: string;
  plan: SearchPlan;
  took_ms: number;
  indexes: Partial<Record<SearchIndex, IndexResults>>;
}

export interface SearchRequest {
  query: string;
  include_text: boolean;
  include_clap: boolean;
  include_yamnet: boolean;
  k: number;
  rewrite: boolean;
  dataset_id?: string;
  plan?: SearchPlan;
}
