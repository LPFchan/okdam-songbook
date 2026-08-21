import { createHash } from "node:crypto";
import {
  importSongsFromCsv,
  songSchema,
  songStatusSchema,
  type CsvRowInput,
  type KeyCandidate,
  type Performance,
  type Song,
} from "@songbook/shared";
import type { SongbookDatabase } from "./db/connection.js";
import { songFromRow } from "./db/repositories.js";
import { requestHash } from "./domain/hash.js";

/** A row which is safe to import into the SQLite representation of Songs. */
export type ImportedSong = Song & {
  createdByEmail: string;
  updatedByEmail: string;
  deletedByEmail: string;
};

export type ImportedPerformance = Performance & {
  createdByEmail: string;
  cancelledByEmail: string;
};

export type ImportedAuditEvent = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  beforeJson: string | null;
  afterJson: string | null;
  actorEmail: string;
  actorName: string;
  actorRole: string | null;
  createdAt: string;
  clientRequestId: string | null;
  entityVersionBefore: number | null;
  entityVersionAfter: number | null;
};

export interface ImportSnapshot {
  songs: ImportedSong[];
  performances: ImportedPerformance[];
  changeLog: ImportedAuditEvent[];
}

export type ImportSource = string | ImportSnapshot | { songs?: unknown[]; performances?: unknown[]; changeLog?: unknown[]; ChangeLog?: unknown[]; auditEvents?: unknown[] } | unknown[];

export interface ImportOptions {
  sourceName?: string;
  generatedAt?: string;
}

export interface ImportPlan {
  snapshot: ImportSnapshot;
  sourceCounts: { songs: number; performances: number; auditEvents: number };
  destinationCounts: { songs: number; performances: number; auditEvents: number };
  songs: ImportItemPlan[];
  performances: ImportItemPlan[];
  auditEvents: ImportItemPlan[];
  warnings: string[];
  errors: string[];
  valid: boolean;
}

export interface ImportItemPlan {
  id: string;
  action: "insert" | "update" | "unchanged";
  sourceHash: string;
  destinationHash?: string;
}

export interface ImportResult {
  plan: ImportPlan;
  applied: boolean;
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface ReconciliationReport {
  sourceCounts: { songs: number; performances: number; auditEvents: number };
  destinationCounts: { songs: number; performances: number; auditEvents: number };
  songs: ReconciliationItem[];
  performances: ReconciliationItem[];
  auditEvents: ReconciliationItem[];
  auditCompleteness: { source: number; destination: number; missing: string[]; extra: string[] };
  unexplainedDiffs: string[];
  zeroDiff: boolean;
}

export interface ReconciliationItem {
  id: string;
  sourceHash?: string;
  destinationHash?: string;
  version?: { source?: number; destination?: number };
  deleted?: { source?: boolean; destination?: boolean };
  status: "equal" | "missing" | "extra" | "changed";
}

export type SheetName = "Songs" | "Performances" | "ChangeLog";

export const sheetHeaders: Record<SheetName, readonly string[]> = {
  Songs: ["id", "tjNumber", "title", "titleReadingKo", "titleRomanized", "titleAliasesJson", "artist", "artistReadingKo", "artistAliasesJson", "country", "genresJson", "originalWork", "keyCandidatesJson", "performerIdsJson", "memo", "status", "youtubeUrl", "youtubeVideoId", "isOfficialTjVideo", "sourceType", "sourceReference", "createdByEmail", "createdByName", "createdAt", "updatedByEmail", "updatedByName", "updatedAt", "deletedAt", "deletedByEmail", "version"],
  Performances: ["id", "songId", "performedAt", "keySelectionJson", "memo", "createdByEmail", "createdByName", "createdAt", "cancelledAt", "cancelledByEmail", "clientRequestId", "version"],
  ChangeLog: ["id", "entityType", "entityId", "action", "beforeJson", "afterJson", "actorEmail", "actorName", "actorRole", "createdAt", "clientRequestId", "entityVersionBefore", "entityVersionAfter"]
};

export class ImportValidationError extends Error {
  readonly code = "IMPORT_INVALID" as const;
  constructor(message: string, readonly details: unknown = null) {
    super(message);
    this.name = "ImportValidationError";
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value).trim();
}

function jsonValue<T>(value: unknown, fallback: T, field: string): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { throw new ImportValidationError(`Invalid JSON in ${field}.`); }
}

function jsonText(value: unknown, fallback: unknown = null): string | null {
  if (value === null || value === undefined || value === "") return fallback === null ? null : JSON.stringify(fallback);
  const parsed = typeof value === "string" ? jsonValue(value, null, "audit JSON") : value;
  return stableJson(parsed);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function canonicalHash(value: unknown): string {
  return requestHash(value);
}

function canonicalId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24)}`;
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const cells: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell); cells.push(row); row = []; cell = ""; }
    else if (character !== "\r") cell += character;
  }
  if (quoted) throw new ImportValidationError("CSV contains an unterminated quoted field.");
  if (cell.length || row.length) { row.push(cell); cells.push(row); }
  if (!cells.length) return { headers: [], rows: [] };
  const aliases: Record<string, string> = { "곡명": "title", "번호": "tjNumber", "아티스트": "artist", "원작": "originalWork", "장르": "genres", "국가": "country", "추천인": "recommender", "키": "key", "생성 일시": "createdAt", "메모": "memo" };
  const firstRow = cells[0] ?? [];
  const headers = firstRow.map((header) => aliases[header.replace(/^\uFEFF/, "").trim()] ?? header.replace(/^\uFEFF/, "").trim());
  const rows = cells.slice(1).filter((values) => values.some((value) => value.trim())).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""] as const)));
  return { headers, rows };
}

function asRecord(value: unknown, index: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ImportValidationError(`Import row ${index + 1} is not an object.`);
  return value as Record<string, unknown>;
}

function field(raw: Record<string, unknown>, camel: string, sheet: string): unknown {
  return raw[camel] ?? raw[sheet] ?? raw[camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
}

function normalizeSong(raw: Record<string, unknown>, index: number, generatedAt: string): ImportedSong {
  const songInput = {
    id: stringValue(field(raw, "id", "id"), canonicalId("import-song", { index, title: field(raw, "title", "title"), artist: field(raw, "artist", "artist"), tjNumber: field(raw, "tjNumber", "tjNumber") })),
    tjNumber: stringValue(field(raw, "tjNumber", "tjNumber")),
    title: stringValue(field(raw, "title", "title")),
    titleReadingKo: stringValue(field(raw, "titleReadingKo", "titleReadingKo")),
    titleRomanized: stringValue(field(raw, "titleRomanized", "titleRomanized")),
    titleAliases: jsonValue(field(raw, "titleAliases", "titleAliasesJson"), [], "titleAliasesJson"),
    artist: stringValue(field(raw, "artist", "artist")),
    artistReadingKo: stringValue(field(raw, "artistReadingKo", "artistReadingKo")),
    artistAliases: jsonValue(field(raw, "artistAliases", "artistAliasesJson"), [], "artistAliasesJson"),
    country: stringValue(field(raw, "country", "country")),
    genres: jsonValue(field(raw, "genres", "genresJson"), [], "genresJson"),
    originalWork: stringValue(field(raw, "originalWork", "originalWork")),
    keyCandidates: jsonValue(field(raw, "keyCandidates", "keyCandidatesJson"), [], "keyCandidatesJson"),
    performerIds: jsonValue(field(raw, "performerIds", "performerIdsJson"), [], "performerIdsJson"),
    memo: stringValue(field(raw, "memo", "memo")),
    status: stringValue(field(raw, "status", "status"), "active"),
    youtubeUrl: stringValue(field(raw, "youtubeUrl", "youtubeUrl")),
    youtubeVideoId: stringValue(field(raw, "youtubeVideoId", "youtubeVideoId")),
    isOfficialTjVideo: field(raw, "isOfficialTjVideo", "isOfficialTjVideo") === "" || field(raw, "isOfficialTjVideo", "isOfficialTjVideo") === undefined ? null : field(raw, "isOfficialTjVideo", "isOfficialTjVideo"),
    sourceType: stringValue(field(raw, "sourceType", "sourceType")),
    sourceReference: stringValue(field(raw, "sourceReference", "sourceReference")),
    createdByName: stringValue(field(raw, "createdByName", "createdByName")),
    createdAt: stringValue(field(raw, "createdAt", "createdAt"), generatedAt),
    updatedByName: stringValue(field(raw, "updatedByName", "updatedByName")),
    updatedAt: stringValue(field(raw, "updatedAt", "updatedAt"), generatedAt),
    deletedAt: stringValue(field(raw, "deletedAt", "deletedAt")),
    version: Number(field(raw, "version", "version") ?? 1),
    lastPerformedAt: "",
    performanceCount: 0
  };
  const parsed = songSchema.safeParse(songInput);
  if (!parsed.success) throw new ImportValidationError(`Invalid song row ${index + 1}.`, parsed.error.flatten());
  const value = parsed.data;
  if (!songStatusSchema.safeParse(value.status).success) throw new ImportValidationError(`Invalid song status on row ${index + 1}.`);
  const boolValue = songInput.isOfficialTjVideo === null ? null : typeof songInput.isOfficialTjVideo === "boolean" ? songInput.isOfficialTjVideo : /^(true|1|yes)$/i.test(String(songInput.isOfficialTjVideo));
  return { ...value, isOfficialTjVideo: boolValue, createdByEmail: stringValue(field(raw, "createdByEmail", "createdByEmail")), updatedByEmail: stringValue(field(raw, "updatedByEmail", "updatedByEmail")), deletedByEmail: stringValue(field(raw, "deletedByEmail", "deletedByEmail")) };
}

function normalizePerformance(raw: Record<string, unknown>, index: number, generatedAt: string): ImportedPerformance {
  const id = stringValue(field(raw, "id", "id"));
  const songId = stringValue(field(raw, "songId", "songId"));
  const performedAt = stringValue(field(raw, "performedAt", "performedAt"), generatedAt);
  const clientRequestId = stringValue(field(raw, "clientRequestId", "clientRequestId"), canonicalId("import-performance-request", { id, songId, performedAt, index }));
  if (!songId || !performedAt) throw new ImportValidationError(`Invalid performance row ${index + 1}.`);
  return {
    id: id || canonicalId("import-performance", { songId, performedAt, clientRequestId }), songId, performedAt,
    keySelection: jsonValue(field(raw, "keySelection", "keySelectionJson"), null, "keySelectionJson") as KeyCandidate | null,
    memo: stringValue(field(raw, "memo", "memo")), createdByName: stringValue(field(raw, "createdByName", "createdByName")), createdAt: stringValue(field(raw, "createdAt", "createdAt"), generatedAt), cancelledAt: stringValue(field(raw, "cancelledAt", "cancelledAt")), clientRequestId, version: Math.max(1, Number(field(raw, "version", "version") ?? 1)), createdByEmail: stringValue(field(raw, "createdByEmail", "createdByEmail")), cancelledByEmail: stringValue(field(raw, "cancelledByEmail", "cancelledByEmail"))
  };
}

function normalizeAudit(raw: Record<string, unknown>, index: number, generatedAt: string): ImportedAuditEvent {
  const entityType = stringValue(field(raw, "entityType", "entityType"));
  const entityId = stringValue(field(raw, "entityId", "entityId"));
  const action = stringValue(field(raw, "action", "action"));
  const createdAt = stringValue(field(raw, "createdAt", "createdAt"), generatedAt);
  const identity = { entityType, entityId, action, createdAt, clientRequestId: field(raw, "clientRequestId", "clientRequestId") };
  return {
    id: stringValue(field(raw, "id", "id"), canonicalId("import-audit", { ...identity, index })), entityType, entityId, action,
    beforeJson: jsonText(field(raw, "beforeJson", "beforeJson")), afterJson: jsonText(field(raw, "afterJson", "afterJson")), actorEmail: stringValue(field(raw, "actorEmail", "actorEmail")), actorName: stringValue(field(raw, "actorName", "actorName")), actorRole: stringValue(field(raw, "actorRole", "actorRole")) || null, createdAt, clientRequestId: stringValue(field(raw, "clientRequestId", "clientRequestId")) || null, entityVersionBefore: field(raw, "entityVersionBefore", "entityVersionBefore") === "" || field(raw, "entityVersionBefore", "entityVersionBefore") === undefined ? null : Number(field(raw, "entityVersionBefore", "entityVersionBefore")), entityVersionAfter: field(raw, "entityVersionAfter", "entityVersionAfter") === "" || field(raw, "entityVersionAfter", "entityVersionAfter") === undefined ? null : Number(field(raw, "entityVersionAfter", "entityVersionAfter"))
  };
}

export function parseImportSource(source: ImportSource, options: ImportOptions = {}): ImportSnapshot {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  let rawSongs: unknown[] = [];
  let rawPerformances: unknown[] = [];
  let rawAudit: unknown[] = [];
  if (typeof source === "string") {
    const parsed = source.trim().startsWith("{") || source.trim().startsWith("[") ? (() => { try { return JSON.parse(source) as unknown; } catch { throw new ImportValidationError("Import JSON could not be parsed."); } })() : source;
    if (parsed !== source) source = parsed as ImportSource;
    else {
      const csv = parseCsv(source);
      const legacy = csv.headers.includes("key") || csv.headers.includes("recommender");
      if (legacy) {
        const report = importSongsFromCsv(csv.rows as CsvRowInput[], { csvFileName: options.sourceName ?? "import.csv", generatedAt, idFactory: (() => { let n = 0; return () => `import-csv-${String(++n).padStart(6, "0")}`; })() });
        rawSongs = report.songs;
      } else rawSongs = csv.rows;
    }
  }
  if (typeof source !== "string") {
    if (Array.isArray(source)) rawSongs = source;
    else {
      const record = source as { songs?: unknown[]; performances?: unknown[]; changeLog?: unknown[]; ChangeLog?: unknown[]; auditEvents?: unknown[] };
      rawSongs = record.songs ?? [];
      rawPerformances = record.performances ?? [];
      rawAudit = record.changeLog ?? record.ChangeLog ?? record.auditEvents ?? [];
    }
  }
  const songs = rawSongs.map((value, index) => normalizeSong(asRecord(value, index), index, generatedAt));
  const performances = rawPerformances.map((value, index) => normalizePerformance(asRecord(value, index), index, generatedAt));
  const changeLog = rawAudit.map((value, index) => normalizeAudit(asRecord(value, index), index, generatedAt));
  const ids = new Set<string>();
  const tjNumbers = new Set<string>();
  for (const song of songs) {
    if (ids.has(song.id)) throw new ImportValidationError(`Duplicate song id ${song.id}.`);
    ids.add(song.id);
    if (song.tjNumber && tjNumbers.has(song.tjNumber)) throw new ImportValidationError(`Duplicate TJ number ${song.tjNumber}.`);
    if (song.tjNumber) tjNumbers.add(song.tjNumber);
  }
  return { songs, performances, changeLog };
}

function songCanonical(song: ImportedSong | Song): unknown {
  const value = Object.fromEntries(Object.entries(song).filter(([key]) => key !== "lastPerformedAt" && key !== "lastPerformedByName" && key !== "performanceCount"));
  return { ...value, tjNumber: value.tjNumber || "", deletedAt: value.deletedAt || "", deletedByEmail: "deletedByEmail" in value ? value.deletedByEmail || "" : "", createdByEmail: "createdByEmail" in value ? value.createdByEmail || "" : "", updatedByEmail: "updatedByEmail" in value ? value.updatedByEmail || "" : "" };
}

function performanceCanonical(performance: ImportedPerformance): unknown {
  return { ...performance, cancelledAt: performance.cancelledAt || "", cancelledByEmail: performance.cancelledByEmail || "" };
}

function auditCanonical(event: ImportedAuditEvent): unknown { return event; }

function destinationSnapshot(database: SongbookDatabase): ImportSnapshot {
  const rows = database.sqlite.prepare("SELECT * FROM songs ORDER BY id").all() as Record<string, unknown>[];
  const songs = rows.map((row) => ({ ...songFromRow(row), createdByEmail: stringValue(row.created_by_email), updatedByEmail: stringValue(row.updated_by_email), deletedByEmail: stringValue(row.deleted_by_email) }));
  const performanceRows = database.sqlite.prepare("SELECT * FROM performances ORDER BY id").all() as Record<string, unknown>[];
  const performances = performanceRows.map((row) => ({ id: stringValue(row.id), songId: stringValue(row.song_id), performedAt: stringValue(row.performed_at), keySelection: jsonValue(row.key_selection_json, null, "key_selection_json") as KeyCandidate | null, memo: stringValue(row.memo), createdByEmail: stringValue(row.created_by_email), createdByName: stringValue(row.created_by_name), createdAt: stringValue(row.created_at), cancelledAt: stringValue(row.cancelled_at), cancelledByEmail: stringValue(row.cancelled_by_email), clientRequestId: stringValue(row.client_request_id), version: Number(row.version) }));
  const auditRows = database.sqlite.prepare("SELECT * FROM audit_events ORDER BY id").all() as Record<string, unknown>[];
  const changeLog = auditRows.map((row) => ({ id: stringValue(row.id), entityType: stringValue(row.entity_type), entityId: stringValue(row.entity_id), action: stringValue(row.action), beforeJson: row.before_json === null ? null : stringValue(row.before_json), afterJson: row.after_json === null ? null : stringValue(row.after_json), actorEmail: stringValue(row.actor_email), actorName: stringValue(row.actor_name), actorRole: row.actor_role === null ? null : stringValue(row.actor_role), createdAt: stringValue(row.created_at), clientRequestId: row.client_request_id === null ? null : stringValue(row.client_request_id), entityVersionBefore: row.entity_version_before === null ? null : Number(row.entity_version_before), entityVersionAfter: row.entity_version_after === null ? null : Number(row.entity_version_after) }));
  return { songs, performances, changeLog };
}

function mapExisting(snapshot: ImportSnapshot, source: ImportSnapshot): { snapshot: ImportSnapshot; existing: ImportSnapshot; warnings: string[]; errors: string[] } {
  const existingById = new Map(snapshot.songs.map((song) => [song.id, song]));
  const existingByTj = new Map(snapshot.songs.filter((song) => song.tjNumber).map((song) => [song.tjNumber, song]));
  const existingByName = new Map(snapshot.songs.map((song) => [`${song.title.toLocaleLowerCase()}|${song.artist.toLocaleLowerCase()}`, song]));
  const warnings: string[] = [];
  const errors: string[] = [];
  const resolvedSongIds = new Map<string, string>();
  const mappedSongs = source.songs.map((original) => {
    const byId = existingById.get(original.id);
    const byTj = original.tjNumber ? existingByTj.get(original.tjNumber) : undefined;
    const byName = existingByName.get(`${original.title.toLocaleLowerCase()}|${original.artist.toLocaleLowerCase()}`);
    const match = byId ?? byTj ?? byName;
    if (match && match.id !== original.id) warnings.push(`Matched imported song ${original.id} to existing id ${match.id}.`);
    resolvedSongIds.set(original.id, match?.id ?? original.id);
    return match ? { ...original, id: match.id } : original;
  });
  const ids = new Set<string>();
  const tj = new Map<string, string>();
  for (const song of mappedSongs) {
    if (ids.has(song.id)) errors.push(`Duplicate destination song id ${song.id}.`);
    ids.add(song.id);
    if (song.tjNumber) {
      const prior = tj.get(song.tjNumber);
      if (prior && prior !== song.id) errors.push(`Duplicate destination TJ number ${song.tjNumber}.`);
      tj.set(song.tjNumber, song.id);
    }
  }
  const mappedPerformances = source.performances.map((performance) => ({
    ...performance,
    songId: resolvedSongIds.get(performance.songId) ?? performance.songId
  }));
  const mappedChangeLog = source.changeLog.map((event) => ({
    ...event,
    entityId: /^(song|songs)$/iu.test(event.entityType) ? resolvedSongIds.get(event.entityId) ?? event.entityId : event.entityId
  }));
  return { snapshot: { songs: mappedSongs, performances: mappedPerformances, changeLog: mappedChangeLog }, existing: snapshot, warnings, errors };
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return Array.from(duplicates);
}

function validateChildIdentities(snapshot: ImportSnapshot): void {
  const performanceIds = duplicateValues(snapshot.performances.map((performance) => performance.id));
  if (performanceIds.length) throw new ImportValidationError(`Duplicate performance id(s): ${performanceIds.join(", ")}.`);
  const requestIds = duplicateValues(snapshot.performances.map((performance) => performance.clientRequestId));
  if (requestIds.length) throw new ImportValidationError(`Duplicate performance clientRequestId(s): ${requestIds.join(", ")}.`);
  const auditIds = duplicateValues(snapshot.changeLog.map((event) => event.id));
  if (auditIds.length) throw new ImportValidationError(`Duplicate audit id(s): ${auditIds.join(", ")}.`);
}

function itemPlans<T extends { id: string }>(source: T[], destination: T[], canonical: (value: T) => unknown): ImportItemPlan[] {
  const byId = new Map(destination.map((item) => [item.id, item]));
  return source.map((item) => {
    const found = byId.get(item.id);
    const sourceHash = canonicalHash(canonical(item));
    const destinationHash = found ? canonicalHash(canonical(found)) : undefined;
    return { id: item.id, action: !found ? "insert" : sourceHash === destinationHash ? "unchanged" : "update", sourceHash, destinationHash };
  });
}

export function prepareImport(database: SongbookDatabase, source: ImportSource, options: ImportOptions = {}): ImportPlan {
  const imported = parseImportSource(source, options);
  validateChildIdentities(imported);
  const mapped = mapExisting(destinationSnapshot(database), imported);
  const sourceSnapshot = mapped.snapshot;
  const destination = mapped.existing;
  const errors = [...mapped.errors];
  const destinationPerformanceIds = new Set(destination.performances.map((performance) => performance.id));
  const destinationRequestIds = new Map(destination.performances.map((performance) => [performance.clientRequestId, performance.id]));
  for (const performance of sourceSnapshot.performances) {
    const existingId = destinationRequestIds.get(performance.clientRequestId);
    if (existingId && existingId !== performance.id) throw new ImportValidationError(`Performance clientRequestId ${performance.clientRequestId} already belongs to ${existingId}.`);
    if (destinationPerformanceIds.has(performance.id) && existingId && existingId !== performance.id) throw new ImportValidationError(`Performance id ${performance.id} conflicts with an existing clientRequestId.`);
  }
  const songIds = new Set(sourceSnapshot.songs.map((song) => song.id));
  for (const performance of sourceSnapshot.performances) if (!songIds.has(performance.songId) && !destination.songs.some((song) => song.id === performance.songId)) errors.push(`Performance ${performance.id} references missing song ${performance.songId}.`);
  return { snapshot: sourceSnapshot, sourceCounts: { songs: sourceSnapshot.songs.length, performances: sourceSnapshot.performances.length, auditEvents: sourceSnapshot.changeLog.length }, destinationCounts: { songs: destination.songs.length, performances: destination.performances.length, auditEvents: destination.changeLog.length }, songs: itemPlans(sourceSnapshot.songs, destination.songs, songCanonical), performances: itemPlans(sourceSnapshot.performances, destination.performances, performanceCanonical), auditEvents: itemPlans(sourceSnapshot.changeLog, destination.changeLog, auditCanonical), warnings: mapped.warnings, errors, valid: errors.length === 0 };
}

function upsertSnapshot(database: SongbookDatabase, snapshot: ImportSnapshot): void {
  const songSql = `INSERT INTO songs (id,tj_number,title,title_reading_ko,title_romanized,title_aliases_json,artist,artist_reading_ko,artist_aliases_json,country,genres_json,original_work,key_candidates_json,performer_ids_json,memo,status,youtube_url,youtube_video_id,is_official_tj_video,source_type,source_reference,created_by_email,created_by_name,created_at,updated_by_email,updated_by_name,updated_at,deleted_at,deleted_by_email,version) VALUES (${Array.from({ length: 30 }, () => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET tj_number=excluded.tj_number,title=excluded.title,title_reading_ko=excluded.title_reading_ko,title_romanized=excluded.title_romanized,title_aliases_json=excluded.title_aliases_json,artist=excluded.artist,artist_reading_ko=excluded.artist_reading_ko,artist_aliases_json=excluded.artist_aliases_json,country=excluded.country,genres_json=excluded.genres_json,original_work=excluded.original_work,key_candidates_json=excluded.key_candidates_json,performer_ids_json=excluded.performer_ids_json,memo=excluded.memo,status=excluded.status,youtube_url=excluded.youtube_url,youtube_video_id=excluded.youtube_video_id,is_official_tj_video=excluded.is_official_tj_video,source_type=excluded.source_type,source_reference=excluded.source_reference,created_by_email=excluded.created_by_email,created_by_name=excluded.created_by_name,created_at=excluded.created_at,updated_by_email=excluded.updated_by_email,updated_by_name=excluded.updated_by_name,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,deleted_by_email=excluded.deleted_by_email,version=excluded.version`;
  const insertSong = database.sqlite.prepare(songSql);
  for (const song of snapshot.songs) insertSong.run(song.id, song.tjNumber || null, song.title, song.titleReadingKo, song.titleRomanized, stableJson(song.titleAliases), song.artist, song.artistReadingKo, stableJson(song.artistAliases), song.country, stableJson(song.genres), song.originalWork, stableJson(song.keyCandidates), stableJson(song.performerIds), song.memo, song.status, song.youtubeUrl, song.youtubeVideoId, song.isOfficialTjVideo, song.sourceType, song.sourceReference, song.createdByEmail, song.createdByName, song.createdAt, song.updatedByEmail, song.updatedByName, song.updatedAt, song.deletedAt || null, song.deletedByEmail || null, Math.max(1, song.version));
  const insertPerformance = database.sqlite.prepare("INSERT INTO performances (id,song_id,performed_at,key_selection_json,memo,created_by_email,created_by_name,created_at,cancelled_at,cancelled_by_email,client_request_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET song_id=excluded.song_id,performed_at=excluded.performed_at,key_selection_json=excluded.key_selection_json,memo=excluded.memo,created_by_email=excluded.created_by_email,created_by_name=excluded.created_by_name,created_at=excluded.created_at,cancelled_at=excluded.cancelled_at,cancelled_by_email=excluded.cancelled_by_email,client_request_id=excluded.client_request_id,version=excluded.version");
  for (const performance of snapshot.performances) insertPerformance.run(performance.id, performance.songId, performance.performedAt, performance.keySelection === null ? null : stableJson(performance.keySelection), performance.memo, performance.createdByEmail, performance.createdByName, performance.createdAt, performance.cancelledAt || null, performance.cancelledByEmail || null, performance.clientRequestId, Math.max(1, performance.version));
  const insertAudit = database.sqlite.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_email,actor_name,actor_role,created_at,client_request_id,entity_version_before,entity_version_after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET entity_type=excluded.entity_type,entity_id=excluded.entity_id,action=excluded.action,before_json=excluded.before_json,after_json=excluded.after_json,actor_email=excluded.actor_email,actor_name=excluded.actor_name,actor_role=excluded.actor_role,created_at=excluded.created_at,client_request_id=excluded.client_request_id,entity_version_before=excluded.entity_version_before,entity_version_after=excluded.entity_version_after");
  for (const event of snapshot.changeLog) insertAudit.run(event.id, event.entityType, event.entityId, event.action, event.beforeJson, event.afterJson, event.actorEmail, event.actorName, event.actorRole, event.createdAt, event.clientRequestId, event.entityVersionBefore, event.entityVersionAfter);
}

export function applyImport(database: SongbookDatabase, source: ImportSource, options: ImportOptions = {}): ImportResult {
  const plan = prepareImport(database, source, options);
  if (!plan.valid) throw new ImportValidationError("Import validation failed.", plan.errors);
  const changed = [...plan.songs, ...plan.performances, ...plan.auditEvents];
  database.sqlite.transaction(() => upsertSnapshot(database, plan.snapshot))();
  return { plan, applied: true, inserted: changed.filter((item) => item.action === "insert").length, updated: changed.filter((item) => item.action === "update").length, unchanged: changed.filter((item) => item.action === "unchanged").length };
}

function reconcileItems<T extends { id: string }>(source: T[], destination: T[], canonical: (value: T) => unknown, extra: (source: T | undefined, destination: T | undefined) => Partial<ReconciliationItem> = () => ({})): ReconciliationItem[] {
  const sourceMap = new Map(source.map((item) => [item.id, item]));
  const destinationMap = new Map(destination.map((item) => [item.id, item]));
  const ids = new Set([...sourceMap.keys(), ...destinationMap.keys()]);
  return Array.from(ids).sort().map((id) => {
    const from = sourceMap.get(id); const to = destinationMap.get(id);
    if (!from) return { id, destinationHash: canonicalHash(canonical(to!)), status: "extra", ...extra(undefined, to) };
    if (!to) return { id, sourceHash: canonicalHash(canonical(from)), status: "missing", ...extra(from, undefined) };
    const sourceHash = canonicalHash(canonical(from)); const destinationHash = canonicalHash(canonical(to));
    return { id, sourceHash, destinationHash, status: sourceHash === destinationHash ? "equal" : "changed", ...extra(from, to), ...(sourceHash === destinationHash ? {} : { version: { source: "version" in from ? Number(from.version) : undefined, destination: "version" in to ? Number(to.version) : undefined } }) };
  });
}

export function reconcileImport(database: SongbookDatabase, source: ImportSource, options: ImportOptions = {}): ReconciliationReport {
  const plan = prepareImport(database, source, options);
  const destination = destinationSnapshot(database);
  const songs = reconcileItems(plan.snapshot.songs, destination.songs, songCanonical, (sourceSong, destinationSong) => ({ version: { source: sourceSong?.version, destination: destinationSong?.version }, deleted: { source: Boolean(sourceSong?.deletedAt), destination: Boolean(destinationSong?.deletedAt) } }));
  const performances = reconcileItems(plan.snapshot.performances, destination.performances, performanceCanonical);
  const auditEvents = reconcileItems(plan.snapshot.changeLog, destination.changeLog, auditCanonical);
  const unexplainedDiffs = [...plan.errors, ...songs.filter((item) => item.status !== "equal").map((item) => `song:${item.id}:${item.status}`), ...performances.filter((item) => item.status !== "equal").map((item) => `performance:${item.id}:${item.status}`), ...auditEvents.filter((item) => item.status !== "equal").map((item) => `audit:${item.id}:${item.status}`)];
  const missing = auditEvents.filter((item) => item.status === "missing").map((item) => item.id);
  const extra = auditEvents.filter((item) => item.status === "extra").map((item) => item.id);
  return { sourceCounts: plan.sourceCounts, destinationCounts: plan.destinationCounts, songs, performances, auditEvents, auditCompleteness: { source: plan.sourceCounts.auditEvents, destination: plan.destinationCounts.auditEvents, missing, extra }, unexplainedDiffs, zeroDiff: unexplainedDiffs.length === 0 };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportSheetCsv(database: SongbookDatabase, name: SheetName): string {
  const snapshot = destinationSnapshot(database);
  const rows: unknown[][] = name === "Songs" ? snapshot.songs.map((song) => [song.id, song.tjNumber, song.title, song.titleReadingKo, song.titleRomanized, stableJson(song.titleAliases), song.artist, song.artistReadingKo, stableJson(song.artistAliases), song.country, stableJson(song.genres), song.originalWork, stableJson(song.keyCandidates), stableJson(song.performerIds), song.memo, song.status, song.youtubeUrl, song.youtubeVideoId, song.isOfficialTjVideo, song.sourceType, song.sourceReference, song.createdByEmail, song.createdByName, song.createdAt, song.updatedByEmail, song.updatedByName, song.updatedAt, song.deletedAt, song.deletedByEmail, song.version]) : name === "Performances" ? snapshot.performances.map((performance) => [performance.id, performance.songId, performance.performedAt, performance.keySelection === null ? "" : stableJson(performance.keySelection), performance.memo, performance.createdByEmail, performance.createdByName, performance.createdAt, performance.cancelledAt, performance.cancelledByEmail, performance.clientRequestId, performance.version]) : snapshot.changeLog.map((event) => [event.id, event.entityType, event.entityId, event.action, event.beforeJson, event.afterJson, event.actorEmail, event.actorName, event.actorRole, event.createdAt, event.clientRequestId, event.entityVersionBefore, event.entityVersionAfter]);
  return [sheetHeaders[name].map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n") + "\n";
}

export function exportRollback(database: SongbookDatabase): { songs: string; performances: string; changeLog: string } {
  return { songs: exportSheetCsv(database, "Songs"), performances: exportSheetCsv(database, "Performances"), changeLog: exportSheetCsv(database, "ChangeLog") };
}

export function importedSnapshot(database: SongbookDatabase): ImportSnapshot { return destinationSnapshot(database); }
