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
  },
  {
    id: "0100_mcp_token_resources",
    sql: `
      CREATE TABLE IF NOT EXISTS mcp_token_resources (
        access_token TEXT PRIMARY KEY NOT NULL,
        resource TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcp_token_resources_expiry_idx ON mcp_token_resources(expires_at);
    `
  },
  {
    id: "0101_tj_mirror",
    sql: `
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
    `
  },
  {
    id: "0102_drop_song_genres",
    sql: `ALTER TABLE songs DROP COLUMN genres_json;`
  },
  {
    id: "0103_drop_practicing_status",
    disableForeignKeys: true,
    sql: `
      CREATE TABLE songs_next (
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
        original_work TEXT NOT NULL DEFAULT '',
        key_candidates_json TEXT NOT NULL DEFAULT '[]',
        performer_ids_json TEXT NOT NULL DEFAULT '[]',
        memo TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','favorite','hold','deletion_candidate','deleted')),
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

      INSERT INTO songs_next (
        id,tj_number,title,title_reading_ko,title_romanized,title_aliases_json,
        artist,artist_reading_ko,artist_aliases_json,country,original_work,
        key_candidates_json,performer_ids_json,memo,status,youtube_url,
        youtube_video_id,is_official_tj_video,source_type,source_reference,
        created_by_email,created_by_name,created_at,updated_by_email,
        updated_by_name,updated_at,deleted_at,deleted_by_email,version
      )
      SELECT
        id,tj_number,title,title_reading_ko,title_romanized,title_aliases_json,
        artist,artist_reading_ko,artist_aliases_json,country,original_work,
        key_candidates_json,performer_ids_json,memo,
        CASE WHEN status = 'practicing' THEN 'active' ELSE status END,
        youtube_url,youtube_video_id,is_official_tj_video,source_type,
        source_reference,created_by_email,created_by_name,created_at,
        updated_by_email,updated_by_name,updated_at,deleted_at,deleted_by_email,
        version
      FROM songs;

      DROP TABLE songs;
      ALTER TABLE songs_next RENAME TO songs;
      CREATE INDEX songs_status_idx ON songs(status);
      CREATE INDEX songs_updated_at_idx ON songs(updated_at);
    `
  },
  {
    id: "0104_personal_favorites",
    disableForeignKeys: true,
    sql: `
      CREATE TABLE songs_next (
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
        original_work TEXT NOT NULL DEFAULT '',
        key_candidates_json TEXT NOT NULL DEFAULT '[]',
        performer_ids_json TEXT NOT NULL DEFAULT '[]',
        memo TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hold','deletion_candidate','deleted')),
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

      INSERT INTO songs_next (
        id,tj_number,title,title_reading_ko,title_romanized,title_aliases_json,
        artist,artist_reading_ko,artist_aliases_json,country,original_work,
        key_candidates_json,performer_ids_json,memo,status,youtube_url,
        youtube_video_id,is_official_tj_video,source_type,source_reference,
        created_by_email,created_by_name,created_at,updated_by_email,
        updated_by_name,updated_at,deleted_at,deleted_by_email,version
      )
      SELECT
        id,tj_number,title,title_reading_ko,title_romanized,title_aliases_json,
        artist,artist_reading_ko,artist_aliases_json,country,original_work,
        key_candidates_json,performer_ids_json,memo,
        CASE WHEN status = 'favorite' THEN 'active' ELSE status END,
        youtube_url,youtube_video_id,is_official_tj_video,source_type,
        source_reference,created_by_email,created_by_name,created_at,
        updated_by_email,updated_by_name,updated_at,deleted_at,deleted_by_email,
        version
      FROM songs;

      DROP TABLE songs;
      ALTER TABLE songs_next RENAME TO songs;
      CREATE INDEX songs_status_idx ON songs(status);
      CREATE INDEX songs_updated_at_idx ON songs(updated_at);

      CREATE TABLE song_favorites (
        user_email TEXT NOT NULL,
        song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE ON UPDATE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_email, song_id)
      );
      CREATE INDEX song_favorites_song_idx ON song_favorites(song_id);
    `
  },
  {
    id: "0105_collapse_song_schema",
    disableForeignKeys: true,
    sql: `
      CREATE TABLE songs_next (
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

      INSERT INTO songs_next (
        id,tj_number,title,title_reading_ko,artist,artist_reading_ko,country,
        recommended_key_json,performer_ids_json,memo,source_type,
        source_reference,created_by_email,created_by_name,created_at,
        updated_by_email,updated_by_name,updated_at,deleted_at,deleted_by_email,
        version
      )
      SELECT
        id,tj_number,title,title_reading_ko,artist,artist_reading_ko,country,
        CASE WHEN json_array_length(key_candidates_json) > 0 THEN
          json_object(
            'baseMode', CASE json_extract(key_candidates_json, '$[0].baseMode')
              WHEN 'female' THEN 'female'
              WHEN 'male' THEN 'male'
              ELSE 'original'
            END,
            'offset', COALESCE(json_extract(key_candidates_json, '$[0].offset'), 0)
          )
        ELSE NULL END,
        performer_ids_json,
        CASE WHEN length(trim(original_work)) > 0 THEN
          '원작: ' || trim(original_work) ||
          CASE WHEN length(trim(memo)) > 0 THEN char(10) || memo ELSE '' END
        ELSE memo END,
        source_type,source_reference,created_by_email,created_by_name,created_at,
        updated_by_email,updated_by_name,updated_at,deleted_at,deleted_by_email,
        version
      FROM songs;

      DROP TABLE songs;
      ALTER TABLE songs_next RENAME TO songs;
      CREATE INDEX songs_updated_at_idx ON songs(updated_at);

      UPDATE performances
      SET key_selection_json = json_object(
        'baseMode', CASE json_extract(key_selection_json, '$.baseMode')
          WHEN 'female' THEN 'female'
          WHEN 'male' THEN 'male'
          ELSE 'original'
        END,
        'offset', COALESCE(json_extract(key_selection_json, '$.offset'), 0)
      )
      WHERE key_selection_json IS NOT NULL;
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
    const disableForeignKeys = "disableForeignKeys" in migration && migration.disableForeignKeys;
    const foreignKeysWereEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
    if (disableForeignKeys && foreignKeysWereEnabled) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) throw new Error(`Migration ${migration.id} introduced foreign key violations.`);
        db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, new Date().toISOString());
      })();
    } finally {
      if (disableForeignKeys && foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
    }
    ran.push(migration.id);
  }
  return ran;
}
