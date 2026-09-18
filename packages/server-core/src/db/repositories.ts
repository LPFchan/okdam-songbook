import type { Song, Performance, RecommendedKey } from "@songbook/shared";
import type { AuditEventRow } from "./schema.js";
import type { SqlExecutor } from "./sql.js";

type RawSong = Record<string, unknown>;
type RawPerformance = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
export function songFromRow(row: RawSong, displayNameForEmail: (email: string) => string = () => ""): Song {
  const performances = Number(row.performance_count ?? 0);
  const lastPerformedByEmail = String(row.last_performed_by_email ?? "");
  const lastPerformedByName = String(row.last_performed_by_name ?? "");
  return {
    id: String(row.id), tjNumber: nullableString(row.tj_number) ?? "", title: String(row.title),
    titleReadingKo: String(row.title_reading_ko ?? ""), artist: String(row.artist),
    artistReadingKo: String(row.artist_reading_ko ?? ""), country: String(row.country ?? ""),
    recommendedKey: parseJson<RecommendedKey | null>(row.recommended_key_json, null), performerIds: parseJson<Song["performerIds"]>(row.performer_ids_json, []),
    memo: String(row.memo ?? ""),
    sourceType: String(row.source_type ?? ""), sourceReference: String(row.source_reference ?? ""),
    createdByName: String(row.created_by_name ?? ""), createdAt: String(row.created_at), updatedByName: String(row.updated_by_name ?? ""),
    updatedAt: String(row.updated_at), deletedAt: String(row.deleted_at ?? ""), version: Number(row.version),
    lastPerformedAt: String(row.last_performed_at ?? ""),
    lastPerformedByName: lastPerformedByName || (lastPerformedByEmail ? displayNameForEmail(lastPerformedByEmail) : ""),
    performanceCount: performances
  };
}

export function performanceFromRow(row: RawPerformance): Performance {
  return {
    id: String(row.id), songId: String(row.song_id), performedAt: String(row.performed_at),
    keySelection: parseJson<RecommendedKey | null>(row.key_selection_json, null), memo: String(row.memo ?? ""),
    createdByName: String(row.created_by_name ?? ""), createdAt: String(row.created_at), cancelledAt: String(row.cancelled_at ?? ""),
    clientRequestId: String(row.client_request_id), version: Number(row.version)
  };
}

export interface SongRepository {
  list(options?: { includeDeleted?: boolean }): Promise<Song[]>;
  get(id: string): Promise<Song | null>;
  getByTjNumber(tjNumber: string): Promise<Song | null>;
  findDuplicate(input: { tjNumber?: string | null; title: string; artist: string }, excludeId?: string, options?: { includeDeleted?: boolean }): Promise<Song | null>;
  insert(song: Song & { createdByEmail?: string; updatedByEmail?: string; deletedByEmail?: string | null }): Promise<void>;
  update(song: Song & { createdByEmail?: string; updatedByEmail?: string; deletedByEmail?: string | null }, expectedVersion: number): Promise<boolean>;
  remove(id: string, expectedVersion: number): Promise<boolean>;
}

const SONG_SELECT = "SELECT s.*, (SELECT COUNT(*) FROM performances p WHERE p.song_id=s.id AND p.cancelled_at IS NULL) AS performance_count, (SELECT MAX(p.performed_at) FROM performances p WHERE p.song_id=s.id AND p.cancelled_at IS NULL) AS last_performed_at, (SELECT p.created_by_email FROM performances p WHERE p.song_id=s.id AND p.cancelled_at IS NULL ORDER BY p.performed_at DESC, p.created_at DESC, p.id DESC LIMIT 1) AS last_performed_by_email, (SELECT p.created_by_name FROM performances p WHERE p.song_id=s.id AND p.cancelled_at IS NULL ORDER BY p.performed_at DESC, p.created_at DESC, p.id DESC LIMIT 1) AS last_performed_by_name FROM songs s";
const SONG_INSERT_SQL = "INSERT INTO songs (id,tj_number,title,title_reading_ko,artist,artist_reading_ko,country,recommended_key_json,performer_ids_json,memo,source_type,source_reference,created_by_email,created_by_name,created_at,updated_by_email,updated_by_name,updated_at,deleted_at,deleted_by_email,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const SONG_UPDATE_SQL = "UPDATE songs SET tj_number=?,title=?,title_reading_ko=?,artist=?,artist_reading_ko=?,country=?,recommended_key_json=?,performer_ids_json=?,memo=?,source_type=?,source_reference=?,updated_by_email=?,updated_by_name=?,updated_at=?,deleted_at=?,deleted_by_email=?,version=version+1 WHERE id=? AND version=?";

export function createSongRepository(sqlite: SqlExecutor, displayNameForEmail: (email: string) => string = () => ""): SongRepository {
  const select = SONG_SELECT;
  const map = (row: RawSong) => songFromRow(row, displayNameForEmail);
  return {
    list: async (options = {}) => (await sqlite.prepare(select + " " + (options.includeDeleted ? "" : "WHERE s.deleted_at IS NULL ") + "ORDER BY s.updated_at DESC").all<RawSong>()).map(map),
    get: async (id) => { const row = await sqlite.prepare(select + " WHERE s.id=?").get<RawSong>(id); return row ? map(row) : null; },
    getByTjNumber: async (tjNumber) => { const row = await sqlite.prepare(select + " WHERE s.tj_number=?").get<RawSong>(tjNumber); return row ? map(row) : null; },
    findDuplicate: async (input, excludeId, options = {}) => {
      const values: unknown[] = [];
      const clauses: string[] = [];
      if (input.tjNumber) { clauses.push("s.tj_number=?"); values.push(input.tjNumber); }
      clauses.push("(lower(s.title)=lower(?) AND lower(s.artist)=lower(?))"); values.push(input.title, input.artist);
      const exclusion = excludeId ? " AND s.id<>?" : "";
      if (excludeId) values.push(excludeId);
      const deleted = options.includeDeleted ? "" : " AND s.deleted_at IS NULL";
      const row = await sqlite.prepare(select + " WHERE (" + clauses.join(" OR ") + ")" + exclusion + deleted + " LIMIT 1").get<RawSong>(...values);
      return row ? map(row) : null;
    },
    insert: async (song) => { await sqlite.prepare(SONG_INSERT_SQL).run(...songValues(song)); },
    update: async (song, expectedVersion) => {
      const result = await sqlite.prepare(SONG_UPDATE_SQL).run(song.tjNumber || null, song.title, song.titleReadingKo, song.artist, song.artistReadingKo, song.country, song.recommendedKey ? JSON.stringify(song.recommendedKey) : null, JSON.stringify(song.performerIds), song.memo, song.sourceType, song.sourceReference, song.updatedByEmail || "", song.updatedByName, song.updatedAt, song.deletedAt || null, song.deletedByEmail || null, song.id, expectedVersion);
      return result.changes === 1;
    },
    remove: async (id, expectedVersion) => (await sqlite.prepare("DELETE FROM songs WHERE id=? AND version=? AND deleted_at IS NULL").run(id, expectedVersion)).changes === 1
  };
}

function songValues(song: Song & { createdByEmail?: string; updatedByEmail?: string; deletedByEmail?: string | null }): unknown[] {
  return [song.id, song.tjNumber || null, song.title, song.titleReadingKo, song.artist, song.artistReadingKo, song.country, song.recommendedKey ? JSON.stringify(song.recommendedKey) : null, JSON.stringify(song.performerIds), song.memo, song.sourceType, song.sourceReference, song.createdByEmail || "", song.createdByName, song.createdAt, song.updatedByEmail || "", song.updatedByName, song.updatedAt, song.deletedAt || null, song.deletedByEmail || null, song.version];
}

export interface PerformanceRepository {
  get(id: string): Promise<Performance | null>;
  getByClientRequestId(id: string): Promise<Performance | null>;
  listForSong(songId: string, includeCancelled?: boolean): Promise<Performance[]>;
  insert(performance: Performance & { createdByEmail?: string }): Promise<void>;
  cancel(id: string, expectedVersion: number, cancelledAt: string, email: string): Promise<boolean>;
}

export function createPerformanceRepository(sqlite: SqlExecutor): PerformanceRepository {
  const map = (row: RawPerformance | undefined) => row ? performanceFromRow(row) : null;
  return {
    get: async (id) => map(await sqlite.prepare("SELECT * FROM performances WHERE id=?").get<RawPerformance>(id)),
    getByClientRequestId: async (id) => map(await sqlite.prepare("SELECT * FROM performances WHERE client_request_id=?").get<RawPerformance>(id)),
    listForSong: async (songId, includeCancelled = false) => (await sqlite.prepare("SELECT * FROM performances WHERE song_id=? " + (includeCancelled ? "" : "AND cancelled_at IS NULL ") + "ORDER BY performed_at DESC").all<RawPerformance>(songId)).map(performanceFromRow),
    insert: async (p) => { await sqlite.prepare("INSERT INTO performances (id,song_id,performed_at,key_selection_json,memo,created_by_email,created_by_name,created_at,cancelled_at,cancelled_by_email,client_request_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(p.id, p.songId, p.performedAt, p.keySelection ? JSON.stringify(p.keySelection) : null, p.memo, p.createdByEmail || "", p.createdByName, p.createdAt, p.cancelledAt || null, null, p.clientRequestId, p.version); },
    cancel: async (id, expectedVersion, cancelledAt, email) => (await sqlite.prepare("UPDATE performances SET cancelled_at=?,cancelled_by_email=?,version=version+1 WHERE id=? AND version=? AND cancelled_at IS NULL").run(cancelledAt, email, id, expectedVersion)).changes === 1
  };
}

export interface FavoriteRepository {
  listSongIds(subject: string): Promise<string[]>;
  has(subject: string, songId: string): Promise<boolean>;
  set(subject: string, songId: string, favorite: boolean, createdAt: string): Promise<void>;
}

export function createFavoriteRepository(sqlite: SqlExecutor): FavoriteRepository {
  return {
    listSongIds: async (subject) => (await sqlite.prepare("SELECT f.song_id FROM song_favorites f JOIN songs s ON s.id=f.song_id WHERE f.user_subject=? AND s.deleted_at IS NULL ORDER BY f.created_at DESC, f.song_id ASC").all<{ song_id: string }>(subject)).map((row) => row.song_id),
    has: async (subject, songId) => Boolean(await sqlite.prepare("SELECT 1 FROM song_favorites WHERE user_subject=? AND song_id=?").get(subject, songId)),
    set: async (subject, songId, favorite, createdAt) => {
      if (favorite) {
        await sqlite.prepare("INSERT OR IGNORE INTO song_favorites (user_subject,song_id,created_at) VALUES (?,?,?)").run(subject, songId, createdAt);
      } else {
        await sqlite.prepare("DELETE FROM song_favorites WHERE user_subject=? AND song_id=?").run(subject, songId);
      }
    }
  };
}

export interface AuditRepository {
  append(event: Omit<AuditEventRow, "id"> & { id?: string }): Promise<string>;
  list(entityType?: string, entityId?: string): Promise<AuditEventRow[]>;
}

export function createAuditRepository(sqlite: SqlExecutor): AuditRepository {
  return {
    append: async (event) => { const id = event.id || crypto.randomUUID(); await sqlite.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_email,actor_name,actor_role,created_at,client_request_id,entity_version_before,entity_version_after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, event.entityType, event.entityId, event.action, event.beforeJson, event.afterJson, event.actorEmail, event.actorName, event.actorRole, event.createdAt, event.clientRequestId, event.entityVersionBefore, event.entityVersionAfter); return id; },
    list: async (entityType, entityId) => sqlite.prepare("SELECT * FROM audit_events " + (entityType ? "WHERE entity_type=? " : "") + (entityId ? (entityType ? "AND entity_id=? " : "WHERE entity_id=? ") : "") + "ORDER BY created_at ASC").all<AuditEventRow>(...([entityType, entityId].filter((v): v is string => Boolean(v))))
  };
}
