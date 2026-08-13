import type Database from "better-sqlite3";

export const migrations = [
  {
    id: "0001_core",
    sql: `
      CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY NOT NULL,
        tj_number TEXT UNIQUE,
        title TEXT NOT NULL,
        title_reading_ko TEXT NOT NULL DEFAULT '',
        title_romanized TEXT NOT NULL DEFAULT '',
        title_aliases_json TEXT NOT NULL DEFAULT '[]',
        artist TEXT NOT NULL,
        artist_reading_ko TEXT NOT NULL DEFAULT '',
        artist_aliases_json TEXT NOT NULL DEFAULT '[]',
        country TEXT NOT NULL DEFAULT '',
        genres_json TEXT NOT NULL DEFAULT '[]',
        original_work TEXT NOT NULL DEFAULT '',
        key_candidates_json TEXT NOT NULL DEFAULT '[]',
        performer_ids_json TEXT NOT NULL DEFAULT '[]',
        memo TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','favorite','practicing','hold','deletion_candidate','deleted')),
        youtube_url TEXT NOT NULL DEFAULT '',
        youtube_video_id TEXT NOT NULL DEFAULT '',
        is_official_tj_video INTEGER,
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
      CREATE INDEX IF NOT EXISTS songs_status_idx ON songs(status);
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
        actor_email TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
      CREATE INDEX IF NOT EXISTS idempotency_keys_actor_operation_idx ON idempotency_keys(actor_email, operation);
    `
  }
] as const;

export function ensureMigrationTable(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
}

export function runMigrations(db: Database.Database): string[] {
  ensureMigrationTable(db);
  const applied = new Set<string>(db.prepare("SELECT id FROM schema_migrations").all().map((row) => String((row as { id: string }).id)));
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, new Date().toISOString());
    })();
    ran.push(migration.id);
  }
  return ran;
}
