import type Database from "better-sqlite3";
import type { Song, Performance, KeyCandidate, SongStatus } from "@songbook/shared";
import type { AuditEventRow, IdempotencyKeyRow } from "./schema.js";

type RawSong = Record<string, unknown>;
type RawPerformance = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export function songFromRow(row: RawSong): Song {
  const performances = Number(row.performance_count ?? 0);
  return {
    id: String(row.id), tjNumber: nullableString(row.tj_number) ?? "", title: String(row.title),
    titleReadingKo: String(row.title_reading_ko ?? ""), titleRomanized: String(row.title_romanized ?? ""),
    titleAliases: parseJson<string[]>(row.title_aliases_json, []), artist: String(row.artist),
    artistReadingKo: String(row.artist_reading_ko ?? ""), artistAliases: parseJson<string[]>(row.artist_aliases_json, []),
    country: String(row.country ?? ""), genres: parseJson<string[]>(row.genres_json, []), originalWork: String(row.original_work ?? ""),
    keyCandidates: parseJson<KeyCandidate[]>(row.key_candidates_json, []), performerIds: parseJson<Song["performerIds"]>(row.performer_ids_json, []),
    memo: String(row.memo ?? ""), status: String(row.status) as SongStatus, youtubeUrl: String(row.youtube_url ?? ""),
    youtubeVideoId: String(row.youtube_video_id ?? ""), isOfficialTjVideo: row.is_official_tj_video === null ? null : Boolean(row.is_official_tj_video),
    sourceType: String(row.source_type ?? ""), sourceReference: String(row.source_reference ?? ""),
    createdByName: String(row.created_by_name ?? ""), createdAt: String(row.created_at), updatedByName: String(row.updated_by_name ?? ""),
    updatedAt: String(row.updated_at), deletedAt: String(row.deleted_at ?? ""), version: Number(row.version),
    lastPerformedAt: String(row.last_performed_at ?? ""), performanceCount: performances
  };
}

export function performanceFromRow(row: RawPerformance): Performance {
  return {
    id: String(row.id), songId: String(row.song_id), performedAt: String(row.performed_at),
    keySelection: parseJson<KeyCandidate | null>(row.key_selection_json, null), memo: String(row.memo ?? ""),
    createdByName: String(row.created_by_name ?? ""), createdAt: String(row.created_at), cancelledAt: String(row.cancelled_at ?? ""),
    clientRequestId: String(row.client_request_id), version: Number(row.version)
  };
}

export interface SongRepository {
  list(options?: { includeDeleted?: boolean }): Song[];
  get(id: string): Song | null;
  getByTjNumber(tjNumber: string): Song | null;
  findDuplicate(input: { tjNumber?: string | null; title: string; artist: string }, excludeId?: string): Song | null;
  insert(song: Song & { createdByEmail?: string; updatedByEmail?: string; deletedByEmail?: string | null }): void;
  update(song: Song & { createdByEmail?: string; updatedByEmail?: string; deletedByEmail?: string | null }, expectedVersion: number): boolean;
  remove(id: string, expectedVersion: number, deletedAt: string, email: string): boolean;
  restore(id: string, expectedVersion: number, updatedAt: string, email: string): boolean;
}

export function createSongRepository(sqlite: Database.Database): SongRepository {
  const select = `SELECT s.*, (SELECT COUNT(*) FROM performances p WHERE p.song_id=s.id AND p.cancelled_at IS NULL) AS performance_count, (SELECT MAX(p.performed_at) FROM performances p WHERE p.song_id=s.id AND p.cancelled_at IS NULL) AS last_performed_at FROM songs s`;
  return {
    list: (options = {}) => (sqlite.prepare(`${select} ${options.includeDeleted ? "" : "WHERE s.deleted_at IS NULL"} ORDER BY s.updated_at DESC`).all() as RawSong[]).map(songFromRow),
    get: (id) => { const row = sqlite.prepare(`${select} WHERE s.id=?`).get(id) as RawSong | undefined; return row ? songFromRow(row) : null; },
    getByTjNumber: (tjNumber) => { const row = sqlite.prepare(`${select} WHERE s.tj_number=?`).get(tjNumber) as RawSong | undefined; return row ? songFromRow(row) : null; },
    findDuplicate: (input, excludeId) => {
      const values: unknown[] = [];
      const clauses: string[] = [];
      if (input.tjNumber) { clauses.push("s.tj_number=?"); values.push(input.tjNumber); }
      clauses.push("(lower(s.title)=lower(?) AND lower(s.artist)=lower(?))"); values.push(input.title, input.artist);
      const exclusion = excludeId ? " AND s.id<>?" : "";
      if (excludeId) values.push(excludeId);
      const row = sqlite.prepare(`${select} WHERE (${clauses.join(" OR ")})${exclusion} LIMIT 1`).get(...values) as RawSong | undefined;
      return row ? songFromRow(row) : null;
    },
    insert: (song) => { sqlite.prepare(`INSERT INTO songs (id,tj_number,title,title_reading_ko,title_romanized,title_aliases_json,artist,artist_reading_ko,artist_aliases_json,country,genres_json,original_work,key_candidates_json,performer_ids_json,memo,status,youtube_url,youtube_video_id,is_official_tj_video,source_type,source_reference,created_by_email,created_by_name,created_at,updated_by_email,updated_by_name,updated_at,deleted_at,deleted_by_email,version) VALUES (${Array.from({ length: 30 }, () => "?").join(",")})`).run(...songValues(song)); },
    update: (song, expectedVersion) => {
      const result = sqlite.prepare(`UPDATE songs SET tj_number=?,title=?,title_reading_ko=?,title_romanized=?,title_aliases_json=?,artist=?,artist_reading_ko=?,artist_aliases_json=?,country=?,genres_json=?,original_work=?,key_candidates_json=?,performer_ids_json=?,memo=?,status=?,youtube_url=?,youtube_video_id=?,is_official_tj_video=?,source_type=?,source_reference=?,updated_by_email=?,updated_by_name=?,updated_at=?,deleted_at=?,deleted_by_email=?,version=version+1 WHERE id=? AND version=?`).run(song.tjNumber || null,song.title,song.titleReadingKo,song.titleRomanized,JSON.stringify(song.titleAliases),song.artist,song.artistReadingKo,JSON.stringify(song.artistAliases),song.country,JSON.stringify(song.genres),song.originalWork,JSON.stringify(song.keyCandidates),JSON.stringify(song.performerIds),song.memo,song.status,song.youtubeUrl,song.youtubeVideoId,song.isOfficialTjVideo,song.sourceType,song.sourceReference,song.updatedByEmail || "",song.updatedByName,song.updatedAt,song.deletedAt || null,song.deletedByEmail || null,song.id,expectedVersion); return result.changes === 1; },
    remove: (id, expectedVersion, deletedAt, email) => sqlite.prepare("UPDATE songs SET status='deleted',deleted_at=?,deleted_by_email=?,updated_at=?,updated_by_email=?,version=version+1 WHERE id=? AND version=? AND deleted_at IS NULL").run(deletedAt,email,deletedAt,email,id,expectedVersion).changes === 1,
    restore: (id, expectedVersion, updatedAt, email) => sqlite.prepare("UPDATE songs SET status='active',deleted_at=NULL,deleted_by_email=NULL,updated_at=?,updated_by_email=?,version=version+1 WHERE id=? AND version=? AND deleted_at IS NOT NULL").run(updatedAt,email,id,expectedVersion).changes === 1
  };
}

function songValues(song: Song & { createdByEmail?: string; updatedByEmail?: string; deletedByEmail?: string | null }): unknown[] {
  return [song.id,song.tjNumber || null,song.title,song.titleReadingKo,song.titleRomanized,JSON.stringify(song.titleAliases),song.artist,song.artistReadingKo,JSON.stringify(song.artistAliases),song.country,JSON.stringify(song.genres),song.originalWork,JSON.stringify(song.keyCandidates),JSON.stringify(song.performerIds),song.memo,song.status,song.youtubeUrl,song.youtubeVideoId,song.isOfficialTjVideo,song.sourceType,song.sourceReference,song.createdByEmail || "",song.createdByName,song.createdAt,song.updatedByEmail || "",song.updatedByName,song.updatedAt,song.deletedAt || null,song.deletedByEmail || null,song.version];
}

export interface PerformanceRepository {
  get(id: string): Performance | null;
  getByClientRequestId(id: string): Performance | null;
  listForSong(songId: string, includeCancelled?: boolean): Performance[];
  insert(performance: Performance & { createdByEmail?: string }): void;
  cancel(id: string, expectedVersion: number, cancelledAt: string, email: string): boolean;
}

export function createPerformanceRepository(sqlite: Database.Database): PerformanceRepository {
  const map = (row: RawPerformance | undefined) => row ? performanceFromRow(row) : null;
  return {
    get: (id) => map(sqlite.prepare("SELECT * FROM performances WHERE id=?").get(id) as RawPerformance | undefined),
    getByClientRequestId: (id) => map(sqlite.prepare("SELECT * FROM performances WHERE client_request_id=?").get(id) as RawPerformance | undefined),
    listForSong: (songId, includeCancelled = false) => (sqlite.prepare(`SELECT * FROM performances WHERE song_id=? ${includeCancelled ? "" : "AND cancelled_at IS NULL"} ORDER BY performed_at DESC`).all(songId) as RawPerformance[]).map(performanceFromRow),
    insert: (p) => sqlite.prepare("INSERT INTO performances (id,song_id,performed_at,key_selection_json,memo,created_by_email,created_by_name,created_at,cancelled_at,cancelled_by_email,client_request_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(p.id,p.songId,p.performedAt,p.keySelection ? JSON.stringify(p.keySelection) : null,p.memo,p.createdByEmail || "",p.createdByName,p.createdAt,p.cancelledAt || null,null,p.clientRequestId,p.version),
    cancel: (id, expectedVersion, cancelledAt, email) => sqlite.prepare("UPDATE performances SET cancelled_at=?,cancelled_by_email=?,version=version+1 WHERE id=? AND version=? AND cancelled_at IS NULL").run(cancelledAt,email,id,expectedVersion).changes === 1
  };
}

export interface AuditRepository {
  append(event: Omit<AuditEventRow, "id"> & { id?: string }): string;
  list(entityType?: string, entityId?: string): AuditEventRow[];
}

export function createAuditRepository(sqlite: Database.Database): AuditRepository {
  return {
    append: (event) => { const id = event.id || crypto.randomUUID(); sqlite.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_email,actor_name,actor_role,created_at,client_request_id,entity_version_before,entity_version_after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,event.entityType,event.entityId,event.action,event.beforeJson,event.afterJson,event.actorEmail,event.actorName,event.actorRole,event.createdAt,event.clientRequestId,event.entityVersionBefore,event.entityVersionAfter); return id; },
    list: (entityType, entityId) => sqlite.prepare(`SELECT * FROM audit_events ${entityType ? "WHERE entity_type=?" : ""}${entityId ? entityType ? " AND entity_id=?" : "WHERE entity_id=?" : ""} ORDER BY created_at ASC`).all(...([entityType,entityId].filter((v): v is string => Boolean(v)))) as AuditEventRow[]
  };
}

export interface IdempotencyRepository {
  get(key: string): IdempotencyKeyRow | null;
  reserve(input: IdempotencyClaimInput): IdempotencyClaim;
  put(input: Omit<IdempotencyKeyRow, "responseJson"> & { responseJson?: string | null }): void;
  complete(key: string, responseJson: string): void;
  prune(now: string): number;
}

export interface IdempotencyClaimInput {
  key: string;
  actorEmail: string;
  operation: string;
  requestHash: string;
  createdAt: string;
  expiresAt: string;
}

export type IdempotencyClaim =
  | { kind: "new"; record: IdempotencyKeyRow }
  | { kind: "replay"; record: IdempotencyKeyRow };

export class IdempotencyMismatchError extends Error {
  readonly code = "IDEMPOTENCY_MISMATCH" as const;
  readonly existing: IdempotencyKeyRow;

  constructor(existing: IdempotencyKeyRow) {
    super("Idempotency key was already used for a different request.");
    this.name = "IdempotencyMismatchError";
    this.existing = existing;
  }
}

export function createIdempotencyRepository(sqlite: Database.Database): IdempotencyRepository {
  const rowForKey = (key: string): IdempotencyKeyRow | null => {
    const row = sqlite.prepare("SELECT * FROM idempotency_keys WHERE key=?").get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { key: String(row.key), actorEmail: String(row.actor_email ?? ""), operation: String(row.operation), requestHash: String(row.request_hash), responseJson: row.response_json === null ? null : String(row.response_json), createdAt: String(row.created_at), expiresAt: String(row.expires_at) } as IdempotencyKeyRow;
  };
  return {
    get: rowForKey,
    reserve: (input) => sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM idempotency_keys WHERE key=? AND expires_at<=?").run(input.key, input.createdAt);
      const result = sqlite.prepare("INSERT OR IGNORE INTO idempotency_keys (key,actor_email,operation,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,NULL,?,?)").run(input.key,input.actorEmail,input.operation,input.requestHash,input.createdAt,input.expiresAt);
      if (result.changes === 1) return { kind: "new", record: rowForKey(input.key)! };
      const existing = rowForKey(input.key);
      if (!existing) throw new Error("Idempotency claim disappeared during reservation.");
      if (existing.actorEmail !== input.actorEmail || existing.operation !== input.operation || existing.requestHash !== input.requestHash) throw new IdempotencyMismatchError(existing);
      return { kind: "replay", record: existing };
    })() as IdempotencyClaim,
    put: (input) => sqlite.prepare("INSERT INTO idempotency_keys (key,actor_email,operation,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").run(input.key,input.actorEmail,input.operation,input.requestHash,input.responseJson ?? null,input.createdAt,input.expiresAt),
    complete: (key, responseJson) => sqlite.prepare("UPDATE idempotency_keys SET response_json=? WHERE key=?").run(responseJson,key),
    prune: (now) => sqlite.prepare("DELETE FROM idempotency_keys WHERE expires_at<=?").run(now).changes
  };
}
