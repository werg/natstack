export interface StoredBookmark {
  id: number;
  title: string;
  url: string | null;
  folder_path: string;
  date_added: number;
  date_modified: number | null;
  favicon_id: number | null;
  position: number;
  source_browser: string | null;
  source_profile_path: string;
  import_key: string | null;
  tags: string | null;
  keyword: string | null;
}

export interface StoredHistory {
  id: number;
  url: string;
  title: string | null;
  visit_count: number;
  typed_count: number;
  first_visit: number | null;
  last_visit: number;
  favicon_id: number | null;
}

export interface StoredVisit {
  id: number;
  history_id: number;
  visit_time: number;
  transition: string;
  from_visit_id: number | null;
  source: string;
  source_browser: string;
  source_profile_path: string;
  panel_id: string;
  title: string | null;
  typed: number;
}

export interface StoredPassword {
  id: number;
  origin_url: string;
  username: string;
  password: string;
  action_url: string;
  realm: string;
  date_created: number | null;
  date_last_used: number | null;
  date_password_changed: number | null;
  times_used: number;
}

export interface StoredCookie {
  id: number;
  name: string;
  value: string;
  domain: string;
  host_only: number;
  path: string;
  expiration_date: number | null;
  secure: number;
  http_only: number;
  same_site: string;
  source_scheme: string | null;
  source_port: number;
  source_browser: string | null;
  created_at: number;
  last_accessed: number | null;
}

export interface StoredAutofill {
  id: number;
  field_name: string;
  value: string;
  date_created: number | null;
  date_last_used: number | null;
  times_used: number;
}

export interface StoredSearchEngine {
  id: number;
  name: string;
  keyword: string | null;
  search_url: string;
  suggest_url: string | null;
  favicon_url: string | null;
  is_default: number;
  source_browser: string;
  source_profile_path: string;
  import_key: string | null;
}

export interface StoredFavicon {
  id: number;
  url: string;
  data: Buffer | null;
  mime_type: string | null;
  last_updated: number | null;
}

export interface StoredPermission {
  id: number;
  origin: string;
  permission: string;
  setting: string;
  date_set: number | null;
}

/** Per-data-type counts for a single import run. `added`/`changed`/`unchanged`
 * become meaningful once the dry-run classifier lands; until then `scanned`,
 * `skipped`, and `errors` are populated and the diff buckets stay 0. */
export interface ImportRunSummaryInput {
  dataType: string;
  scanned: number;
  added: number;
  changed: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

/** A single `startImport` invocation, recorded for the run timeline. */
export interface ImportRunInput {
  browser: string;
  profilePath: string;
  mode: "import" | "preview";
  status: "success" | "partial" | "error";
  startedAt: number;
  finishedAt: number;
  dataTypes: string[];
  warnings?: string[];
  summaries: ImportRunSummaryInput[];
}

export interface StoredImportRun {
  id: number;
  browser: string;
  profile_path: string;
  mode: string;
  status: string;
  started_at: number;
  finished_at: number;
  data_types: string;
  warnings: string | null;
}

export interface StoredImportRunSummary {
  id: number;
  run_id: number;
  data_type: string;
  scanned: number;
  added: number;
  changed: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

/** A run joined with its per-type summaries — what `getImportHistory` returns. */
export interface StoredImportRunWithSummaries extends StoredImportRun {
  summaries: StoredImportRunSummary[];
}
