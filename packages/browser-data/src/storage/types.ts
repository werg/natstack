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

export interface ImportLogEntry {
  browser: string;
  profilePath: string;
  dataType: string;
  itemsImported: number;
  itemsSkipped: number;
  warnings?: string[];
}

export interface StoredImportLog {
  id: number;
  browser: string;
  profile_path: string;
  data_type: string;
  items_imported: number;
  items_skipped: number;
  imported_at: number;
  warnings: string | null;
}
