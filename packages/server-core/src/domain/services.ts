import type { FavoriteSetResult, Performance, Song, TjAddResult, TjSongCandidate } from "@songbook/shared";
import { can, detectSongCountry, filterSongs, normalizePerformerIds, searchSongs, sortSongs, type PermissionAction, type SongFilters, type SortKey } from "@songbook/shared";
import type { SongbookDatabase } from "../db/connection.js";
import { createAuditRepository, createFavoriteRepository, createIdempotencyRepository, createPerformanceRepository, createSongRepository, IdempotencyMismatchError, type AuditRepository, type FavoriteRepository, type IdempotencyRepository, type PerformanceRepository, type SongRepository } from "../db/repositories.js";
import { DomainError } from "./errors.js";
import { requestHash } from "./hash.js";
import { denyAllRoleResolver, type RequestActor, type ResolvedActor, type RoleResolver } from "./auth.js";

export interface ServiceOptions {
  roleResolver?: RoleResolver;
  now?: () => string;
  idFactory?: () => string;
  songRepository?: SongRepository;
  performanceRepository?: PerformanceRepository;
  favoriteRepository?: FavoriteRepository;
  auditRepository?: AuditRepository;
  idempotencyRepository?: IdempotencyRepository;
}

export interface SongMutation extends Omit<Song, "id" | "createdAt" | "updatedAt" | "deletedAt" | "version" | "lastPerformedAt" | "lastPerformedByName" | "performanceCount"> {
  clientRequestId: string;
}

export interface SongUpdate extends Partial<Omit<SongMutation, "clientRequestId">> {
  id: string;
  expectedVersion: number;
  clientRequestId: string;
}

export interface PerformanceCreate {
  songId: string;
  performedAt?: string;
  keySelection: Performance["keySelection"];
  memo: string;
  clientRequestId: string;
}

export interface PerformanceCancel {
  performanceId: string;
  expectedVersion: number;
  clientRequestId: string;
}

export interface PerformanceStats {
  count: number;
  lastPerformedAt: string;
}

export interface SongCreateOutcome {
  outcome: "created" | "duplicate" | "deleted";
  song: Song | null;
  existing: Song | null;
  duplicateKind: "tjNumber" | "titleArtist" | null;
  canRestore: boolean;
  canOpen: boolean;
}

export interface SongbookService {
  catalog(): Song[];
  getSong(id: string): Song | null;
  search(query: string, filters?: SongFilters, sortKey?: SortKey): Song[];
  createSong(actor: RequestActor, input: SongMutation): Song;
  createSongOutcome(actor: RequestActor, input: SongMutation): SongCreateOutcome;
  createTjSong(actor: RequestActor, candidate: TjSongCandidate, clientRequestId: string): TjAddResult;
  updateSong(actor: RequestActor, input: SongUpdate): Song;
  deleteSong(actor: RequestActor, input: { id: string; expectedVersion: number; clientRequestId: string }): Song;
  createPerformance(actor: RequestActor, input: PerformanceCreate): Performance;
  cancelPerformance(actor: RequestActor, input: PerformanceCancel): Performance;
  favoriteSongIds(actor: RequestActor): string[];
  setFavorite(actor: RequestActor, input: { songId: string; favorite: boolean; clientRequestId: string }): FavoriteSetResult;
  performanceStats(songId: string): PerformanceStats;
  checkDuplicate(input: { tjNumber?: string | null; title: string; artist: string }, excludeId?: string): Song | null;
}

function json<T>(value: T): string { return JSON.stringify(value); }

function stripSongMutationFields<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const clean = { ...(value as Record<string, unknown>) };
  delete clean.clientRequestId;
  delete clean.expectedVersion;
  return clean as T;
}

function normalizeMutationResult<T>(operation: string, value: T): T {
  return operation.startsWith("song.") ? stripSongMutationFields(value) : value;
}

function songFromCreate(input: SongMutation, id: string, timestamp: string): Song {
  return {
    id, tjNumber: input.tjNumber, title: input.title, titleReadingKo: input.titleReadingKo, titleRomanized: input.titleRomanized,
    titleAliases: input.titleAliases, artist: input.artist, artistReadingKo: input.artistReadingKo, artistAliases: input.artistAliases,
    country: input.country, originalWork: input.originalWork, keyCandidates: input.keyCandidates,
    performerIds: input.performerIds, memo: input.memo, status: input.status, youtubeUrl: input.youtubeUrl,
    youtubeVideoId: input.youtubeVideoId, isOfficialTjVideo: input.isOfficialTjVideo, sourceType: input.sourceType,
    sourceReference: input.sourceReference, createdByName: input.createdByName, createdAt: timestamp,
    updatedByName: input.updatedByName, updatedAt: timestamp, deletedAt: "", version: 1, lastPerformedAt: "", lastPerformedByName: "", performanceCount: 0
  };
}

function songFromUpdate(before: Song, input: SongUpdate, timestamp: string): Song {
  return {
    ...before, tjNumber: input.tjNumber ?? before.tjNumber, title: input.title ?? before.title,
    titleReadingKo: input.titleReadingKo ?? before.titleReadingKo, titleRomanized: input.titleRomanized ?? before.titleRomanized,
    titleAliases: input.titleAliases ?? before.titleAliases, artist: input.artist ?? before.artist,
    artistReadingKo: input.artistReadingKo ?? before.artistReadingKo, artistAliases: input.artistAliases ?? before.artistAliases,
    country: input.country ?? before.country, originalWork: input.originalWork ?? before.originalWork,
    keyCandidates: input.keyCandidates ?? before.keyCandidates, performerIds: input.performerIds ?? before.performerIds,
    memo: input.memo ?? before.memo, status: input.status ?? before.status, youtubeUrl: input.youtubeUrl ?? before.youtubeUrl,
    youtubeVideoId: input.youtubeVideoId ?? before.youtubeVideoId, isOfficialTjVideo: input.isOfficialTjVideo ?? before.isOfficialTjVideo,
    sourceType: input.sourceType ?? before.sourceType, sourceReference: input.sourceReference ?? before.sourceReference,
    createdByName: input.createdByName ?? before.createdByName, updatedByName: input.updatedByName ?? before.updatedByName,
    updatedAt: timestamp, version: before.version
  };
}

function duplicateKind(input: { tjNumber?: string | null }, duplicate: Song): "tjNumber" | "titleArtist" {
  return input.tjNumber && duplicate.tjNumber === input.tjNumber ? "tjNumber" : "titleArtist";
}

function isDeletedSong(song: Song): boolean {
  return Boolean(song.deletedAt) || song.status === "deleted";
}

function isUniqueConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT"));
}

export function createSongbookService(database: SongbookDatabase, options: ServiceOptions = {}): SongbookService {
  const roleResolver = options.roleResolver ?? denyAllRoleResolver;
  const songs = options.songRepository ?? createSongRepository(database.sqlite, (email) => roleResolver.resolve({ email })?.displayName ?? "");
  const performances = options.performanceRepository ?? createPerformanceRepository(database.sqlite);
  const favorites = options.favoriteRepository ?? createFavoriteRepository(database.sqlite);
  const audit = options.auditRepository ?? createAuditRepository(database.sqlite);
  const idempotency = options.idempotencyRepository ?? createIdempotencyRepository(database.sqlite);
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());

  const actorFor = (actor: RequestActor): ResolvedActor => {
    const resolved = roleResolver.resolve(actor);
    if (!resolved) throw new DomainError("UNAUTHORIZED", "로그인 또는 허용된 계정이 필요해.");
    return resolved;
  };

  const requireAction = (actor: RequestActor, action: PermissionAction): ResolvedActor => {
    const resolved = actorFor(actor);
    if (!can(resolved.role, action)) throw new DomainError("FORBIDDEN", "이 작업을 할 권한이 없어.", { action, role: resolved.role });
    return resolved;
  };

  const withMutation = <T>(actor: RequestActor, action: PermissionAction, operation: string, clientRequestId: string, payload: unknown, work: (resolved: ResolvedActor) => T): T => {
    const resolved = requireAction(actor, action);
    try {
      return database.sqlite.transaction(() => {
        const claim = idempotency.reserve({ key: clientRequestId, actorEmail: resolved.email, operation, requestHash: requestHash(payload), createdAt: now(), expiresAt: new Date(Date.parse(now()) + 86_400_000).toISOString() });
        if (claim.kind === "replay") {
          if (!claim.record.responseJson) throw new DomainError("CONFLICT", "요청이 아직 처리 중이야.");
          return normalizeMutationResult(operation, JSON.parse(claim.record.responseJson) as T);
        }
        const result = normalizeMutationResult(operation, work(resolved));
        idempotency.complete(clientRequestId, json(result));
        return result;
      })();
    } catch (error) {
      if (error instanceof IdempotencyMismatchError) throw new DomainError("IDEMPOTENCY_MISMATCH", error.message, { key: clientRequestId });
      throw error;
    }
  };

  const appendAudit = (resolved: ResolvedActor, entityType: string, entityId: string, action: string, before: unknown, after: unknown, clientRequestId: string, beforeVersion: number | null, afterVersion: number | null) => {
    audit.append({ entityType, entityId, action, beforeJson: before === null ? null : json(before), afterJson: after === null ? null : json(after), actorEmail: resolved.email, actorName: resolved.displayName, actorRole: resolved.role, createdAt: now(), clientRequestId, entityVersionBefore: beforeVersion, entityVersionAfter: afterVersion });
  };

  const ensureDuplicateFree = (input: { tjNumber?: string | null; title: string; artist: string }, excludeId?: string) => {
    const duplicate = songs.findDuplicate(input, excludeId);
    if (duplicate) throw new DomainError(input.tjNumber && duplicate.tjNumber === input.tjNumber ? "DUPLICATE_TJ_NUMBER" : "CONFLICT", "같은 TJ 번호 또는 곡명/아티스트가 이미 등록되어 있어.", { duplicateId: duplicate.id });
  };

  const createSongOutcome = (actor: RequestActor, input: SongMutation): SongCreateOutcome => withMutation(actor, "song:create", "song.create", input.clientRequestId, input, (resolved) => {
    const duplicate = songs.findDuplicate(input, undefined, { includeDeleted: true });
    if (duplicate) {
      return {
        outcome: isDeletedSong(duplicate) ? "deleted" : "duplicate",
        song: null,
        existing: duplicate,
        duplicateKind: duplicateKind(input, duplicate),
        canRestore: false,
        canOpen: !isDeletedSong(duplicate)
      } satisfies SongCreateOutcome;
    }
    try {
      const timestamp = now();
      const created = songFromCreate(input, idFactory(), timestamp);
      songs.insert({ ...created, createdByEmail: resolved.email, updatedByEmail: resolved.email });
      const after = songs.get(created.id)!;
      appendAudit(resolved, "song", created.id, "create", null, after, input.clientRequestId, null, after.version);
      return { outcome: "created", song: after, existing: null, duplicateKind: null, canRestore: false, canOpen: true } satisfies SongCreateOutcome;
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const raced = songs.findDuplicate(input, undefined, { includeDeleted: true });
      if (!raced) throw error;
      return {
        outcome: isDeletedSong(raced) ? "deleted" : "duplicate",
        song: null,
        existing: raced,
        duplicateKind: duplicateKind(input, raced),
        canRestore: false,
        canOpen: !isDeletedSong(raced)
      } satisfies SongCreateOutcome;
    }
  });

  return {
    catalog: () => filterSongs(songs.list(), {}, false),
    getSong: (id) => {
      const song = songs.get(id);
      return song && !isDeletedSong(song) && song.status !== "deletion_candidate" ? song : null;
    },
    search: (query, filters = {}, sortKey = "title") => sortSongs(filterSongs(searchSongs(songs.list(), query), filters, false), sortKey),
    checkDuplicate: (input, excludeId) => songs.findDuplicate(input, excludeId),
    createSong: (actor, input) => withMutation(actor, "song:create", "song.create", input.clientRequestId, input, (resolved) => {
      ensureDuplicateFree(input);
      const timestamp = now();
      const created = songFromCreate(input, idFactory(), timestamp);
      songs.insert({ ...created, createdByEmail: resolved.email, updatedByEmail: resolved.email });
      const after = songs.get(created.id)!;
      appendAudit(resolved, "song", created.id, "create", null, after, input.clientRequestId, null, after.version);
      return after;
    }),
    createSongOutcome,
    createTjSong: (actor, candidate, clientRequestId) => {
      const resolved = actorFor(actor);
      const input: SongMutation = {
        tjNumber: candidate.tjNumber,
        title: candidate.title,
        titleReadingKo: "",
        titleRomanized: "",
        titleAliases: [],
        artist: candidate.artist,
        artistReadingKo: "",
        artistAliases: [],
        country: detectSongCountry(candidate.title, candidate.artist, songs.list()),
        originalWork: "",
        keyCandidates: [],
        performerIds: normalizePerformerIds([resolved.displayName]).ids,
        memo: "",
        status: "active",
        youtubeUrl: "",
        youtubeVideoId: "",
        isOfficialTjVideo: null,
        sourceType: "tjmedia",
        sourceReference: candidate.sourceUrl,
        createdByName: resolved.displayName,
        updatedByName: resolved.displayName,
        clientRequestId
      };
      const outcome = createSongOutcome(actor, input);
      return {
        outcome: outcome.outcome,
        song: outcome.song,
        existing: outcome.existing,
        duplicateKind: outcome.duplicateKind,
        canRestore: outcome.canRestore,
        canOpen: outcome.canOpen
      };
    },
    updateSong: (actor, input) => withMutation(actor, "song:update", "song.update", input.clientRequestId, input, (resolved) => {
      const before = songs.get(input.id);
      if (!before || before.deletedAt) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      const next = songFromUpdate(before, input, now());
      ensureDuplicateFree(next, before.id);
      if (!songs.update({ ...next, updatedByEmail: resolved.email }, input.expectedVersion)) throw new DomainError("VERSION_MISMATCH", "곡이 다른 곳에서 바뀌었어.", { currentVersion: songs.get(input.id)?.version, requestVersion: input.expectedVersion });
      const after = songs.get(input.id)!;
      appendAudit(resolved, "song", input.id, "update", before, after, input.clientRequestId, before.version, after.version);
      return after;
    }),
    deleteSong: (actor, input) => withMutation(actor, "song:delete", "song.delete", input.clientRequestId, input, (resolved) => {
      const before = songs.get(input.id);
      if (!before || before.deletedAt) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      if (!songs.remove(input.id, input.expectedVersion)) throw new DomainError("VERSION_MISMATCH", "곡이 다른 곳에서 바뀌었어.");
      appendAudit(resolved, "song", input.id, "delete", before, null, input.clientRequestId, before.version, null);
      return before;
    }),
    createPerformance: (actor, input) => withMutation(actor, "performance:create", "performance.create", input.clientRequestId, input, (resolved) => {
      const song = songs.get(input.songId);
      if (!song || song.deletedAt) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      const created: Performance = { id: idFactory(), songId: input.songId, performedAt: input.performedAt ?? now(), keySelection: input.keySelection, memo: input.memo, createdByName: resolved.displayName, createdAt: now(), cancelledAt: "", clientRequestId: input.clientRequestId, version: 1 };
      performances.insert({ ...created, createdByEmail: resolved.email });
      appendAudit(resolved, "performance", created.id, "create", null, created, input.clientRequestId, null, 1);
      return performances.get(created.id)!;
    }),
    cancelPerformance: (actor, input) => withMutation(actor, "performance:cancel", "performance.cancel", input.clientRequestId, input, (resolved) => {
      const before = performances.get(input.performanceId);
      if (!before || before.cancelledAt) throw new DomainError("NOT_FOUND", "기록을 찾을 수 없어.");
      if (!performances.cancel(input.performanceId, input.expectedVersion, now(), resolved.email)) throw new DomainError("VERSION_MISMATCH", "기록이 다른 곳에서 바뀌었어.");
      const after = performances.get(input.performanceId)!;
      appendAudit(resolved, "performance", input.performanceId, "cancel", before, after, input.clientRequestId, before.version, after.version);
      return after;
    }),
    favoriteSongIds: (actor) => favorites.listSongIds(actorFor(actor).email),
    setFavorite: (actor, input) => withMutation(actor, "favorite:update", "favorite.set", input.clientRequestId, input, (resolved) => {
      const song = songs.get(input.songId);
      if (!song || isDeletedSong(song) || song.status === "deletion_candidate") throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      const before = favorites.has(resolved.email, input.songId);
      favorites.set(resolved.email, input.songId, input.favorite, now());
      appendAudit(resolved, "favorite", input.songId, input.favorite ? "add" : "remove", { favorite: before }, { favorite: input.favorite }, input.clientRequestId, null, null);
      return { songId: input.songId, favorite: input.favorite };
    }),
    performanceStats: (songId) => {
      const song = songs.get(songId);
      if (!song) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      return { count: song.performanceCount, lastPerformedAt: song.lastPerformedAt };
    }
  };
}
