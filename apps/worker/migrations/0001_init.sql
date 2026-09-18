-- Songbook D1 schema. Mirrors the final state of packages/server-core/src/db/migrations.ts.
-- Apply with: wrangler d1 execute okdam-songbook --file=apps/worker/migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY NOT NULL,
  tj_number TEXT UNIQUE,
  title TEXT NOT NULL,
  title_reading_ko TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL,
  artist_reading_ko TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  recommended_key_json TEXT,
  performer_ids_json TEXT NOT NULL DEFAULT '[]',
  memo TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  source_reference TEXT NOT NULL DEFAULT '',
  created_by_email TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_by_email TEXT NOT NULL DEFAULT '',
  updated_by_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by_email TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (tj_number IS NULL OR (length(tj_number) > 0 AND tj_number NOT GLOB '*[^0-9]*'))
);
CREATE INDEX IF NOT EXISTS songs_updated_at_idx ON songs(updated_at);

CREATE TABLE IF NOT EXISTS performances (
  id TEXT PRIMARY KEY NOT NULL,
  song_id TEXT NOT NULL REFERENCES songs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  performed_at TEXT NOT NULL,
  key_selection_json TEXT,
  memo TEXT NOT NULL DEFAULT '',
  created_by_email TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by_email TEXT,
  client_request_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS performances_song_cancelled_idx ON performances(song_id, cancelled_at);
CREATE INDEX IF NOT EXISTS performances_performed_at_idx ON performances(performed_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT,
  created_at TEXT NOT NULL,
  client_request_id TEXT,
  entity_version_before INTEGER,
  entity_version_after INTEGER
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS audit_events_request_idx ON audit_events(client_request_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY NOT NULL,
  actor_subject TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idempotency_keys_actor_operation_idx ON idempotency_keys(actor_subject, operation);

CREATE TABLE IF NOT EXISTS song_favorites (
  user_subject TEXT NOT NULL,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_subject, song_id)
);
CREATE INDEX IF NOT EXISTS song_favorites_song_idx ON song_favorites(song_id);

CREATE TABLE IF NOT EXISTS tj_mirror_songs (
  tj_number TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  lyricist TEXT NOT NULL DEFAULT '',
  composer TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tj_mirror_queries (
  query_key TEXT PRIMARY KEY NOT NULL,
  query TEXT NOT NULL,
  search_type TEXT NOT NULL,
  nation TEXT NOT NULL DEFAULT '',
  page INTEGER NOT NULL,
  page_size INTEGER NOT NULL,
  has_more INTEGER NOT NULL DEFAULT 0,
  source_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  last_attempted_at TEXT NOT NULL,
  last_error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tj_mirror_query_results (
  query_key TEXT NOT NULL REFERENCES tj_mirror_queries(query_key) ON DELETE CASCADE ON UPDATE CASCADE,
  tj_number TEXT NOT NULL REFERENCES tj_mirror_songs(tj_number) ON DELETE RESTRICT ON UPDATE CASCADE,
  result_position INTEGER NOT NULL,
  PRIMARY KEY (query_key, tj_number)
);

INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES
  ('0001_core', datetime('now')),
  ('0100_mcp_token_resources', datetime('now')),
  ('0101_tj_mirror', datetime('now')),
  ('0102_drop_song_genres', datetime('now')),
  ('0103_drop_practicing_status', datetime('now')),
  ('0104_personal_favorites', datetime('now')),
  ('0105_collapse_song_schema', datetime('now')),
  ('0106_drop_mcp_token_resources', datetime('now')),
  ('0107_immutable_account_ownership', datetime('now'));
