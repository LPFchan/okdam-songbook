import type { DamAddResult, DamSongCandidate, FavoriteSetResult, Performance, Song, SongCountry, TjAddResult, TjSongCandidate } from "@songbook/shared";
import { can, filterSongs, normalizePerformerIds, searchSongs, sortSongs, type PermissionAction, type SongFilters, type SortKey } from "@songbook/shared";
import type { SongbookDatabaseBase } from "../db/sql.js";
import { createAuditRepository, createFavoriteRepository, createPerformanceRepository, createSongRepository, type AuditRepository, type FavoriteRepository, type PerformanceRepository, type SongRepository } from "../db/repositories.js";
import { createIdempotencyRepository, IdempotencyMismatchError, type IdempotencyRepository } from "../db/idempotency.js";
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
  /** Fills in the country of songs added from TJ or DAM, after the add returns. */
  countryClassifier?: CountryClassifier;
  /** Keeps background work alive after the response is sent, e.g. Workers' waitUntil. */
  defer?: (task: Promise<unknown>) => void;
  onWarn?: (warning: Record<string, unknown>) => void;
}

export interface CountryClassifier {
  classify(song: { title: string; artist: string }): Promise<SongCountry>;
}

export interface SongMutation extends Omit<Song, "id" | "damNumber" | "createdAt" | "updatedAt" | "deletedAt" | "version" | "lastPerformedAt" | "lastPerformedByName" | "performanceCount"> {
  damNumber?: string;
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
  duplicateKind: "tjNumber" | "damNumber" | "titleArtist" | null;
  canRestore: boolean;
  canOpen: boolean;
}

export interface SongbookService {
  catalog(): Promise<Song[]>;
  getSong(id: string): Promise<Song | null>;
  search(query: string, filters?: SongFilters, sortKey?: SortKey): Promise<Song[]>;
  createSong(actor: RequestActor, input: SongMutation): Promise<Song>;
  createSongOutcome(actor: RequestActor, input: SongMutation): Promise<SongCreateOutcome>;
  createTjSong(actor: RequestActor, candidate: TjSongCandidate, clientRequestId: string): Promise<TjAddResult>;
  createDamSong(actor: RequestActor, candidate: DamSongCandidate, clientRequestId: string): Promise<DamAddResult>;
  updateSong(actor: RequestActor, input: SongUpdate): Promise<Song>;
  deleteSong(actor: RequestActor, input: { id: string; expectedVersion: number; clientRequestId: string }): Promise<Song>;
  createPerformance(actor: RequestActor, input: PerformanceCreate): Promise<Performance>;
  cancelPerformance(actor: RequestActor, input: PerformanceCancel): Promise<Performance>;
  favoriteSongIds(actor: RequestActor): Promise<string[]>;
  setFavorite(actor: RequestActor, input: { songId: string; favorite: boolean; clientRequestId: string }): Promise<FavoriteSetResult>;
  performanceStats(songId: string): Promise<PerformanceStats>;
  checkDuplicate(input: { tjNumber?: string | null; damNumber?: string | null; title: string; artist: string }, excludeId?: string): Promise<Song | null>;
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
    id, tjNumber: input.tjNumber, damNumber: input.damNumber ?? "", title: input.title, titleReadingKo: input.titleReadingKo,
    artist: input.artist, artistReadingKo: input.artistReadingKo, country: input.country,
    recommendedKey: input.recommendedKey, performerIds: input.performerIds, memo: input.memo, sourceType: input.sourceType,
    sourceReference: input.sourceReference, createdByName: input.createdByName, createdAt: timestamp,
    updatedByName: input.updatedByName, updatedAt: timestamp, deletedAt: "", version: 1, lastPerformedAt: "", lastPerformedByName: "", performanceCount: 0
  };
}

function songFromUpdate(before: Song, input: SongUpdate, timestamp: string): Song {
  return {
    ...before, tjNumber: input.tjNumber ?? before.tjNumber, damNumber: input.damNumber ?? before.damNumber, title: input.title ?? before.title,
    titleReadingKo: input.titleReadingKo ?? before.titleReadingKo, artist: input.artist ?? before.artist,
    artistReadingKo: input.artistReadingKo ?? before.artistReadingKo, country: input.country ?? before.country,
    recommendedKey: input.recommendedKey === undefined ? before.recommendedKey : input.recommendedKey,
    performerIds: input.performerIds ?? before.performerIds, memo: input.memo ?? before.memo,
    sourceType: input.sourceType ?? before.sourceType, sourceReference: input.sourceReference ?? before.sourceReference,
    createdByName: input.createdByName ?? before.createdByName, updatedByName: input.updatedByName ?? before.updatedByName,
    updatedAt: timestamp, version: before.version
  };
}

function duplicateKind(input: { tjNumber?: string | null; damNumber?: string | null }, duplicate: Song): "tjNumber" | "damNumber" | "titleArtist" {
  if (input.tjNumber && duplicate.tjNumber === input.tjNumber) return "tjNumber";
  if (input.damNumber && duplicate.damNumber === input.damNumber) return "damNumber";
  return "titleArtist";
}

const COUNTRY_FILL_BATCH = 10;

const COUNTRY_CLASSIFIER_ACTOR: ResolvedActor = { subject: "songbook:country-classifier", email: "", displayName: "국가 자동 분류", role: "allowed" };

function isDeletedSong(song: Song): boolean {
  return Boolean(song.deletedAt);
}

function isUniqueConstraint(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = "message" in error ? String((error as { message?: unknown }).message) : "";
  return code.startsWith("SQLITE_CONSTRAINT") || /UNIQUE constraint failed/i.test(message) || code === "D1_ERROR" && /constraint/i.test(message);
}

export function createSongbookService(database: SongbookDatabaseBase, options: ServiceOptions = {}): SongbookService {
  const roleResolver = options.roleResolver ?? denyAllRoleResolver;
  const songs = options.songRepository ?? createSongRepository(database.sqlite);
  const performances = options.performanceRepository ?? createPerformanceRepository(database.sqlite);
  const favorites = options.favoriteRepository ?? createFavoriteRepository(database.sqlite);
  const audit = options.auditRepository ?? createAuditRepository(database.sqlite);
  const idempotency = options.idempotencyRepository ?? createIdempotencyRepository(database.sqlite);
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());

  const defer = options.defer ?? ((task: Promise<unknown>) => { void task; });
  const warn = options.onWarn ?? (() => {});

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

  const withMutation = async <T>(actor: RequestActor, action: PermissionAction, operation: string, clientRequestId: string, payload: unknown, work: (resolved: ResolvedActor) => Promise<T> | T): Promise<T> => {
    const resolved = requireAction(actor, action);
    try {
      const hash = await requestHash(payload);
      return await database.sqlite.transaction(async () => {
        const claim = await idempotency.reserve({ key: clientRequestId, actorSubject: resolved.subject, operation, requestHash: hash, createdAt: now(), expiresAt: new Date(Date.parse(now()) + 86_400_000).toISOString() });
        if (claim.kind === "replay") {
          if (!claim.record.responseJson) throw new DomainError("CONFLICT", "요청이 아직 처리 중이야.");
          return normalizeMutationResult(operation, JSON.parse(claim.record.responseJson) as T);
        }
        // On Node the enclosing transaction rolls a failed claim back. D1 has
        // no transaction, so the claim is released by hand: left behind, it
        // would answer every retry of the same clientRequestId with CONFLICT
        // ("still processing") until it expired a day later.
        let result: T;
        try {
          result = normalizeMutationResult(operation, await work(resolved));
        } catch (error) {
          await idempotency.release(clientRequestId);
          throw error;
        }
        await idempotency.complete(clientRequestId, json(result));
        return result;
      });
    } catch (error) {
      if (error instanceof IdempotencyMismatchError) throw new DomainError("IDEMPOTENCY_MISMATCH", error.message, { key: clientRequestId });
      throw error;
    }
  };

  const appendAudit = (resolved: ResolvedActor, entityType: string, entityId: string, action: string, before: unknown, after: unknown, clientRequestId: string, beforeVersion: number | null, afterVersion: number | null) => {
    return audit.append({ entityType, entityId, action, beforeJson: before === null ? null : json(before), afterJson: after === null ? null : json(after), actorEmail: resolved.email, actorName: resolved.displayName, actorRole: resolved.role, createdAt: now(), clientRequestId, entityVersionBefore: beforeVersion, entityVersionAfter: afterVersion });
  };

  const ensureDuplicateFree = async (input: { tjNumber?: string | null; damNumber?: string | null; title: string; artist: string }, excludeId?: string) => {
    const duplicate = await songs.findDuplicate(input, excludeId);
    if (!duplicate) return;
    const kind = duplicateKind(input, duplicate);
    if (kind === "damNumber") throw new DomainError("DUPLICATE_DAM_NUMBER", "같은 DAM 번호가 이미 등록되어 있어.", { duplicateId: duplicate.id });
    throw new DomainError(kind === "tjNumber" ? "DUPLICATE_TJ_NUMBER" : "CONFLICT", "같은 TJ 번호 또는 곡명/아티스트가 이미 등록되어 있어.", { duplicateId: duplicate.id });
  };

  const createOutcome = async (resolved: ResolvedActor, input: SongMutation): Promise<SongCreateOutcome> => {
    const duplicate = await songs.findDuplicate(input, undefined, { includeDeleted: true });
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
      await songs.insert({ ...created, createdByEmail: resolved.email, updatedByEmail: resolved.email });
      const after = (await songs.get(created.id))!;
      await appendAudit(resolved, "song", created.id, "create", null, after, input.clientRequestId, null, after.version);
      return { outcome: "created", song: after, existing: null, duplicateKind: null, canRestore: false, canOpen: true } satisfies SongCreateOutcome;
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const raced = await songs.findDuplicate(input, undefined, { includeDeleted: true });
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
  };

  const createSongOutcome = (actor: RequestActor, input: SongMutation): Promise<SongCreateOutcome> =>
    withMutation(actor, "song:create", "song.create", input.clientRequestId, input, (resolved) => createOutcome(resolved, input));

  const applyUpdate = async (resolved: ResolvedActor, input: SongUpdate): Promise<Song> => {
    const before = await songs.get(input.id);
    if (!before || before.deletedAt) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
    const next = songFromUpdate(before, input, now());
    await ensureDuplicateFree(next, before.id);
    if (!(await songs.update({ ...next, updatedByEmail: resolved.email }, input.expectedVersion))) throw new DomainError("VERSION_MISMATCH", "곡이 다른 곳에서 바뀌었어.", { currentVersion: (await songs.get(input.id))?.version, requestVersion: input.expectedVersion });
    const after = (await songs.get(input.id))!;
    await appendAudit(resolved, "song", input.id, "update", before, after, input.clientRequestId, before.version, after.version);
    return after;
  };

  const updateSong = (actor: RequestActor, input: SongUpdate): Promise<Song> =>
    withMutation(actor, "song:update", "song.update", input.clientRequestId, input, (resolved) => applyUpdate(resolved, input));

  // A song added from TJ or DAM is saved with no country, and the classifier
  // fills it in after the add has answered, so the add never waits on a model.
  // A failed answer is asked for once more, and each pass also takes every
  // blank country, which retries any an earlier pass missed. The songs are
  // asked about at once: Workers stop background work 30 seconds after the
  // response, too soon for ten answers in a row. The answer is written only
  // if the country is still blank by then, so one set by hand meanwhile wins.
  // Adds in quick succession would each take the same blank songs, so a
  // song already being asked about is left to the pass that has it.
  const classifying = new Set<string>();
  const fillBlankCountries = async (classifier: CountryClassifier) => {
    const blank = (await songs.list()).filter((song) => !song.country && !isDeletedSong(song) && !classifying.has(song.id)).slice(0, COUNTRY_FILL_BATCH);
    const classify = (song: Song) => classifier.classify({ title: song.title, artist: song.artist });
    for (const song of blank) classifying.add(song.id);
    await Promise.all(blank.map(async (song) => {
      try {
        const country = await classify(song).catch(() => classify(song));
        const current = await songs.get(song.id);
        if (!current || current.country || isDeletedSong(current)) return;
        await applyUpdate(COUNTRY_CLASSIFIER_ACTOR, { id: song.id, expectedVersion: current.version, country, clientRequestId: idFactory() });
      } catch (error) {
        warn({ event: "country_fill_failed", songId: song.id, message: error instanceof Error ? error.message : String(error) });
      } finally {
        classifying.delete(song.id);
      }
    }));
  };

  const afterAdd = <T extends { outcome: string }>(result: T): T => {
    const classifier = options.countryClassifier;
    if (result.outcome === "created" && classifier) {
      defer(fillBlankCountries(classifier).catch((error: unknown) => warn({ event: "country_fill_failed", message: error instanceof Error ? error.message : String(error) })));
    }
    return result;
  };

  return {
    catalog: async () => filterSongs(await songs.list(), {}),
    getSong: async (id) => {
      const song = await songs.get(id);
      return song && !isDeletedSong(song) ? song : null;
    },
    search: async (query, filters = {}, sortKey = "title") => sortSongs(filterSongs(searchSongs(await songs.list(), query), filters), sortKey),
    checkDuplicate: (input, excludeId) => songs.findDuplicate(input, excludeId),
    createSong: (actor, input) => withMutation(actor, "song:create", "song.create", input.clientRequestId, input, async (resolved) => {
      await ensureDuplicateFree(input);
      const timestamp = now();
      const created = songFromCreate(input, idFactory(), timestamp);
      await songs.insert({ ...created, createdByEmail: resolved.email, updatedByEmail: resolved.email });
      const after = (await songs.get(created.id))!;
      await appendAudit(resolved, "song", created.id, "create", null, after, input.clientRequestId, null, after.version);
      return after;
    }),
    createSongOutcome,
    createTjSong: async (actor, candidate, clientRequestId) => {
      const resolved = actorFor(actor);
      const input: SongMutation = {
        tjNumber: candidate.tjNumber,
        title: candidate.title,
        titleReadingKo: "",
        artist: candidate.artist,
        artistReadingKo: "",
        country: "",
        recommendedKey: null,
        performerIds: normalizePerformerIds([resolved.displayName]).ids,
        memo: "",
        sourceType: "tjmedia",
        sourceReference: candidate.sourceUrl,
        createdByName: resolved.displayName,
        updatedByName: resolved.displayName,
        clientRequestId
      };
      const outcome = await createSongOutcome(actor, input);
      return afterAdd({
        outcome: outcome.outcome,
        song: outcome.song,
        existing: outcome.existing,
        // A TJ candidate carries no DAM number, so it can only collide by TJ number or name.
        duplicateKind: outcome.duplicateKind === "damNumber" ? "titleArtist" : outcome.duplicateKind,
        canRestore: outcome.canRestore,
        canOpen: outcome.canOpen
      });
    },
    // One idempotency key covers the whole add, so a retry replays the first
    // answer even though linking changed the song it would now look at.
    createDamSong: (actor, candidate, clientRequestId) => withMutation(actor, "song:create", "song.damAdd", clientRequestId, candidate, async (resolved): Promise<DamAddResult> => {
      // Most DAM picks are songs already saved from TJ. When the name matches a
      // saved song that has no DAM number yet, give it this one instead of
      // reporting a duplicate.
      const sameName = await songs.findDuplicate({ title: candidate.title, artist: candidate.artist });
      if (sameName && !sameName.damNumber && can(resolved.role, "song:update") && !(await songs.getByDamNumber(candidate.damNumber))) {
        const linked = await applyUpdate(resolved, { id: sameName.id, expectedVersion: sameName.version, damNumber: candidate.damNumber, updatedByName: resolved.displayName, clientRequestId });
        return { outcome: "linked", song: linked, existing: null, duplicateKind: null, canRestore: false, canOpen: true };
      }
      const outcome = await createOutcome(resolved, {
        tjNumber: "",
        damNumber: candidate.damNumber,
        title: candidate.title,
        titleReadingKo: "",
        artist: candidate.artist,
        artistReadingKo: "",
        country: "",
        recommendedKey: null,
        performerIds: normalizePerformerIds([resolved.displayName]).ids,
        memo: "",
        sourceType: "clubdam",
        sourceReference: candidate.sourceUrl,
        createdByName: resolved.displayName,
        updatedByName: resolved.displayName,
        clientRequestId
      });
      return {
        outcome: outcome.outcome,
        song: outcome.song,
        existing: outcome.existing,
        duplicateKind: outcome.duplicateKind === "tjNumber" ? "titleArtist" : outcome.duplicateKind,
        canRestore: outcome.canRestore,
        canOpen: outcome.canOpen
      };
    }).then(afterAdd),
    updateSong,
    deleteSong: (actor, input) => withMutation(actor, "song:delete", "song.delete", input.clientRequestId, input, async (resolved) => {
      const before = await songs.get(input.id);
      if (!before || before.deletedAt) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      if (!(await songs.remove(input.id, input.expectedVersion))) throw new DomainError("VERSION_MISMATCH", "곡이 다른 곳에서 바뀌었어.");
      await appendAudit(resolved, "song", input.id, "delete", before, null, input.clientRequestId, before.version, null);
      return before;
    }),
    createPerformance: (actor, input) => withMutation(actor, "performance:create", "performance.create", input.clientRequestId, input, async (resolved) => {
      const song = await songs.get(input.songId);
      if (!song || song.deletedAt) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      const created: Performance = { id: idFactory(), songId: input.songId, performedAt: input.performedAt ?? now(), keySelection: input.keySelection, memo: input.memo, createdByName: resolved.displayName, createdAt: now(), cancelledAt: "", clientRequestId: input.clientRequestId, version: 1 };
      await performances.insert({ ...created, createdByEmail: resolved.email });
      await appendAudit(resolved, "performance", created.id, "create", null, created, input.clientRequestId, null, 1);
      return (await performances.get(created.id))!;
    }),
    cancelPerformance: (actor, input) => withMutation(actor, "performance:cancel", "performance.cancel", input.clientRequestId, input, async (resolved) => {
      const before = await performances.get(input.performanceId);
      if (!before || before.cancelledAt) throw new DomainError("NOT_FOUND", "기록을 찾을 수 없어.");
      if (!(await performances.cancel(input.performanceId, input.expectedVersion, now(), resolved.email))) throw new DomainError("VERSION_MISMATCH", "기록이 다른 곳에서 바뀌었어.");
      const after = (await performances.get(input.performanceId))!;
      await appendAudit(resolved, "performance", input.performanceId, "cancel", before, after, input.clientRequestId, before.version, after.version);
      return after;
    }),
    favoriteSongIds: async (actor) => {
      const resolved = actorFor(actor);
      return favorites.listSongIds(resolved.subject);
    },
    setFavorite: (actor, input) => withMutation(actor, "favorite:update", "favorite.set", input.clientRequestId, input, async (resolved) => {
      const song = await songs.get(input.songId);
      if (!song || isDeletedSong(song)) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      const before = await favorites.has(resolved.subject, input.songId);
      await favorites.set(resolved.subject, input.songId, input.favorite, now());
      await appendAudit(resolved, "favorite", input.songId, input.favorite ? "add" : "remove", { favorite: before }, { favorite: input.favorite }, input.clientRequestId, null, null);
      return { ownerSubject: resolved.subject, songId: input.songId, favorite: input.favorite };
    }),
    performanceStats: async (songId) => {
      const song = await songs.get(songId);
      if (!song) throw new DomainError("NOT_FOUND", "곡을 찾을 수 없어.");
      return { count: song.performanceCount, lastPerformedAt: song.lastPerformedAt };
    }
  };
}
