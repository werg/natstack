export const BROWSER_DATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS favicons (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  data BLOB,
  mime_type TEXT DEFAULT 'image/png',
  last_updated INTEGER
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  folder_path TEXT NOT NULL DEFAULT '/',
  date_added INTEGER NOT NULL,
  date_modified INTEGER,
  favicon_id INTEGER REFERENCES favicons(id),
  position INTEGER NOT NULL DEFAULT 0,
  source_browser TEXT,
  tags TEXT,
  keyword TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);
CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder_path);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  typed_count INTEGER NOT NULL DEFAULT 0,
  first_visit INTEGER,
  last_visit INTEGER NOT NULL,
  favicon_id INTEGER REFERENCES favicons(id)
);
CREATE INDEX IF NOT EXISTS idx_history_url ON history(url);
CREATE INDEX IF NOT EXISTS idx_history_last_visit ON history(last_visit);

CREATE TABLE IF NOT EXISTS history_visits (
  id INTEGER PRIMARY KEY,
  history_id INTEGER NOT NULL REFERENCES history(id) ON DELETE CASCADE,
  visit_time INTEGER NOT NULL,
  transition TEXT DEFAULT 'link',
  from_visit_id INTEGER REFERENCES history_visits(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(url, title, content=history, content_rowid=id);

CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
  INSERT INTO history_fts(rowid, url, title) VALUES (new.id, new.url, new.title);
END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
  INSERT INTO history_fts(history_fts, rowid, url, title) VALUES('delete', old.id, old.url, old.title);
END;
CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE ON history BEGIN
  INSERT INTO history_fts(history_fts, rowid, url, title) VALUES('delete', old.id, old.url, old.title);
  INSERT INTO history_fts(rowid, url, title) VALUES (new.id, new.url, new.title);
END;

CREATE TABLE IF NOT EXISTS passwords (
  id INTEGER PRIMARY KEY,
  origin_url TEXT NOT NULL,
  username_hash BLOB NOT NULL,
  username_encrypted BLOB NOT NULL,
  password_encrypted BLOB NOT NULL,
  action_url TEXT NOT NULL DEFAULT '',
  realm TEXT NOT NULL DEFAULT '',
  date_created INTEGER,
  date_last_used INTEGER,
  date_password_changed INTEGER,
  times_used INTEGER DEFAULT 0,
  UNIQUE(origin_url, username_hash, action_url, realm)
);

CREATE TABLE IF NOT EXISTS cookies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  domain TEXT NOT NULL,
  host_only INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL DEFAULT '/',
  expiration_date INTEGER,
  secure INTEGER NOT NULL DEFAULT 0,
  http_only INTEGER NOT NULL DEFAULT 0,
  same_site TEXT NOT NULL DEFAULT 'unspecified',
  source_scheme TEXT DEFAULT 'unset',
  source_port INTEGER DEFAULT -1,
  source_browser TEXT,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER,
  UNIQUE(name, domain, path)
);
CREATE INDEX IF NOT EXISTS idx_cookies_domain ON cookies(domain);

CREATE TABLE IF NOT EXISTS autofill (
  id INTEGER PRIMARY KEY,
  field_name TEXT NOT NULL,
  value TEXT NOT NULL,
  date_created INTEGER,
  date_last_used INTEGER,
  times_used INTEGER NOT NULL DEFAULT 1,
  UNIQUE(field_name, value)
);
CREATE INDEX IF NOT EXISTS idx_autofill_field ON autofill(field_name);

CREATE TABLE IF NOT EXISTS search_engines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  keyword TEXT,
  search_url TEXT NOT NULL,
  suggest_url TEXT,
  favicon_url TEXT,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  permission TEXT NOT NULL,
  setting TEXT NOT NULL DEFAULT 'ask',
  date_set INTEGER,
  UNIQUE(origin, permission)
);

CREATE TABLE IF NOT EXISTS import_log (
  id INTEGER PRIMARY KEY,
  browser TEXT NOT NULL,
  profile_path TEXT NOT NULL,
  data_type TEXT NOT NULL,
  items_imported INTEGER NOT NULL,
  items_skipped INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  warnings TEXT
);
`;
