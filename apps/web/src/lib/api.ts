import {
  apiFailureSchema,
  currentUserSchema,
  damAddResultSchema,
  damSearchResultSchema,
  damSongUrl,
  isDamNumberQuery,
  normalizeDamNumber,
  favoriteListSchema,
  favoriteSetResultSchema,
  publicDataSchema,
  readingGenerateResultSchema,
  recommendationGroupSchema,
  recommendationResultSchema,
  sampleSongs,
  songSchema,
  tjAddResultSchema,
  tjLookupResultSchema,
  tjSearchResultSchema,
  type CurrentUser,
  type DamAddResult,
  type DamSearchRequest,
  type DamSearchResult,
  type DamSongCandidate,
  type FavoriteList,
  type FavoriteSetResult,
  type PublicData,
  type RecommendationResult,
  type RecommendationRequest,
  type Song,
  type TjAddResult,
  type TjSongCandidate,
  type TjLookupRequest,
  type TjLookupResult,
  type TjSearchRequest,
  type TjSearchResult
} from "@songbook/shared";

const mockTjAdds = new Map<string, TjAddResult>();
const mockDamAdds = new Map<string, DamAddResult>();
const mockFavoriteSongIds = new Set<string>();

function normalizeTjDuplicateText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Mock data is intended for local tests only; production sets this to false. */
export function mockMode(): boolean {
  return (import.meta.env.VITE_ENABLE_MOCK_API ?? "false") === "true";
}

export class ParsedApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly payload?: unknown) {
    super(message);
    this.name = "ParsedApiError";
  }
}

function isUnauthorizedError(code: string): boolean {
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
}

export function isApiAuthError(error: unknown): error is ParsedApiError {
  return Boolean(error && typeof error === "object" && "code" in (error as Record<string, unknown>))
    && isUnauthorizedError(String((error as ParsedApiError).code));
}

function apiError(code: string, message: string, status: number, payload?: unknown): ParsedApiError {
  return new ParsedApiError(code, message, status, payload);
}

async function parseResponse<T>(response: Response, parser: (value: unknown) => T): Promise<T> {
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    throw apiError("INTERNAL_ERROR", "요청에 실패했어요.", response.status);
  }

  const isSuccess = response.ok && json && typeof json === "object" && "ok" in json && (json as { ok?: unknown }).ok === true;
  if (!isSuccess) {
    const failure = apiFailureSchema.safeParse(json);
    const error = failure.success ? failure.data.error : null;
    throw apiError(error?.code ?? "INTERNAL_ERROR", error?.message ?? "요청에 실패했어요.", response.status, json);
  }

  return parser((json as { data?: unknown }).data);
}

async function request<T>(path: string, init: globalThis.RequestInit, parser: (value: unknown) => T): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers
  });
  return parseResponse(response, parser);
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function fetchPublicData(): Promise<PublicData> {
  if (mockMode()) {
    return publicDataSchema.parse({
      songs: sampleSongs,
      serverVersion: "mock-1",
      updatedAt: nowIso()
    });
  }
  return request("/api/catalog", { method: "GET" }, (data) => publicDataSchema.parse(data));
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  if (mockMode()) return currentUserSchema.parse({ subject: "auth.lost.plus:mock", email: "allowed@example.com", displayName: "마리", role: "allowed" });
  return request("/api/me", { method: "GET" }, (data) => currentUserSchema.parse(data));
}

export async function fetchFavoriteSongIds(ownerSubject: string): Promise<FavoriteList> {
  if (mockMode()) return favoriteListSchema.parse({ ownerSubject, songIds: [...mockFavoriteSongIds] });
  return request("/api/favorites", {
    method: "GET",
    headers: { "X-Songbook-Owner-Subject": ownerSubject }
  }, (data) => favoriteListSchema.parse(data));
}

export async function setSongFavorite(songId: string, favorite: boolean, clientRequestId: string, ownerSubject: string): Promise<FavoriteSetResult> {
  if (mockMode()) {
    if (favorite) mockFavoriteSongIds.add(songId);
    else mockFavoriteSongIds.delete(songId);
    return favoriteSetResultSchema.parse({ ownerSubject, songId, favorite });
  }
  return request(`/api/favorites/${encodeURIComponent(songId)}`, {
    method: "POST",
    headers: { "X-Songbook-Owner-Subject": ownerSubject },
    body: JSON.stringify({ favorite, clientRequestId })
  }, (data) => favoriteSetResultSchema.parse(data));
}

export async function createPerformance(songId: string, clientRequestId: string, ownerSubject: string, performedAt = nowIso()): Promise<{ id: string; duplicate?: boolean }> {
  if (mockMode()) return { id: `mock-${clientRequestId}` };
  return request("/api/performances", {
    method: "POST",
    headers: { "X-Songbook-Owner-Subject": ownerSubject },
    body: JSON.stringify({ songId, performedAt, clientRequestId })
  }, (data) => data as { id: string; duplicate?: boolean });
}

export async function cancelPerformance(performanceId: string, clientRequestId: string, ownerSubject: string): Promise<void> {
  if (mockMode()) return;
  await request(`/api/performances/${encodeURIComponent(performanceId)}`, {
    method: "DELETE",
    headers: { "X-Songbook-Owner-Subject": ownerSubject },
    body: JSON.stringify({ performanceId, clientRequestId })
  }, () => null);
}

export async function upsertSong(song: Partial<Song>, clientRequestId: string, ownerSubject: string): Promise<Song> {
  if (mockMode()) {
    return songSchema.parse({
      ...sampleSongs[0],
      ...song,
      id: song.id || crypto.randomUUID(),
      version: (song.version ?? 0) + 1
    });
  }

  if (song.id) {
    return request(`/api/songs/${encodeURIComponent(song.id)}`, {
      method: "PATCH",
      headers: { "X-Songbook-Owner-Subject": ownerSubject },
      body: JSON.stringify({ ...song, id: song.id, expectedVersion: song.version ?? 0, clientRequestId })
    }, (data) => songSchema.parse(data));
  }

  return request("/api/songs", {
    method: "POST",
    headers: { "X-Songbook-Owner-Subject": ownerSubject },
    body: JSON.stringify({ ...song, clientRequestId })
  }, (data) => songSchema.parse(data));
}

export async function lookupTjSong(input: TjLookupRequest): Promise<TjLookupResult> {
  if (mockMode()) {
    const candidate = sampleSongs.find((song) => song.tjNumber === input.tjNumber);
    return tjLookupResultSchema.parse({
      query: input.tjNumber,
      candidate: candidate ? {
        tjNumber: candidate.tjNumber,
        title: candidate.title,
        artist: candidate.artist,
        lyricist: "",
        composer: "",
        sourceUrl: `https://www.tjmedia.com/song/accompaniment_search?searchTxt=${candidate.tjNumber}`
      } : null,
      candidates: candidate ? [{
        tjNumber: candidate.tjNumber,
        title: candidate.title,
        artist: candidate.artist,
        lyricist: "",
        composer: "",
        sourceUrl: `https://www.tjmedia.com/song/accompaniment_search?searchTxt=${candidate.tjNumber}`
      }] : [],
      sourceUrl: "https://www.tjmedia.com/song/accompaniment_search"
    });
  }
  return request("/api/tj/lookup", {
    method: "POST",
    body: JSON.stringify(input)
  }, (data) => tjLookupResultSchema.parse(data));
}

export async function searchTjSongs(input: TjSearchRequest): Promise<TjSearchResult> {
  if (mockMode()) {
    const query = input.query.toLocaleLowerCase();
    const candidates = sampleSongs
      .filter((song) => `${song.title} ${song.artist}`.toLocaleLowerCase().includes(query))
      .map((song) => ({
        tjNumber: song.tjNumber,
        title: song.title,
        artist: song.artist,
        lyricist: "",
        composer: "",
        sourceUrl: `https://www.tjmedia.com/song/accompaniment_search?searchTxt=${encodeURIComponent(input.query)}`
      }));
    return tjSearchResultSchema.parse({
      query: input.query,
      searchType: input.searchType ?? "all",
      nation: input.nation ?? "",
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 15,
      hasMore: false,
      candidates,
      sourceUrl: "https://www.tjmedia.com/song/accompaniment_search"
    });
  }
  return request("/api/tj/search", {
    method: "POST",
    body: JSON.stringify(input)
  }, (data) => tjSearchResultSchema.parse(data));
}

export async function addTjSong(candidate: TjSongCandidate, clientRequestId: string, ownerSubject: string): Promise<TjAddResult> {
  if (mockMode()) {
    const replay = mockTjAdds.get(clientRequestId);
    if (replay) return replay;
    const duplicate = sampleSongs.find((song) => song.tjNumber === candidate.tjNumber || (
      normalizeTjDuplicateText(song.title) === normalizeTjDuplicateText(candidate.title)
      && normalizeTjDuplicateText(song.artist) === normalizeTjDuplicateText(candidate.artist)
    ));
    if (duplicate) {
      const result = tjAddResultSchema.parse({
        outcome: "duplicate",
        song: null,
        existing: duplicate,
        duplicateKind: duplicate.tjNumber === candidate.tjNumber ? "tjNumber" : "titleArtist",
        canRestore: false,
        canOpen: true
      });
      mockTjAdds.set(clientRequestId, result);
      return result;
    }
    const song = await upsertSong({
      tjNumber: candidate.tjNumber,
      title: candidate.title,
      artist: candidate.artist,
      country: "",
      performerIds: [],
      sourceType: "tjmedia",
      sourceReference: candidate.sourceUrl
    }, clientRequestId, ownerSubject);
    const result = tjAddResultSchema.parse({ outcome: "created", song, existing: null, duplicateKind: null, canRestore: false, canOpen: true });
    mockTjAdds.set(clientRequestId, result);
    return result;
  }
  return request("/api/tj/add", {
    method: "POST",
    headers: { "X-Songbook-Owner-Subject": ownerSubject },
    body: JSON.stringify({ candidate, clientRequestId })
  }, (data) => tjAddResultSchema.parse(data));
}

/** Mock-mode DAM songs that are not in the sample catalog, so "바로 추가" has something to add. */
const mockDamExtras: DamSongCandidate[] = [
  ["1278-49", "アイドル", "YOASOBI"],
  ["1278-53", "アイドル(【推しの子】アニメバージョン)", "YOASOBI"],
  ["1278-68", "Adventure", "YOASOBI"]
].map(([damNumber, title, artist]) => ({ damNumber: damNumber!, title: title!, artist: artist!, titleYomi: "", artistYomi: "", sourceUrl: damSongUrl(damNumber!) }));

export async function searchDamSongs(input: DamSearchRequest): Promise<DamSearchResult> {
  if (mockMode()) {
    const number = isDamNumberQuery(input.query) ? normalizeDamNumber(input.query) : null;
    const query = normalizeTjDuplicateText(input.query);
    const fromSamples = sampleSongs
      .filter((song) => song.damNumber)
      .map((song) => ({ damNumber: song.damNumber, title: song.title, artist: song.artist, titleYomi: "", artistYomi: "", sourceUrl: damSongUrl(song.damNumber) }));
    const candidates = [...mockDamExtras, ...fromSamples].filter((candidate) => number
      ? candidate.damNumber === number
      : normalizeTjDuplicateText(`${candidate.title}${candidate.artist}`).includes(query));
    return damSearchResultSchema.parse({ query: input.query, searchType: number ? "number" : "all", page: input.page ?? 1, pageSize: input.pageSize ?? 15, hasMore: false, candidates });
  }
  return request("/api/dam/search", {
    method: "POST",
    body: JSON.stringify(input)
  }, (data) => damSearchResultSchema.parse(data));
}

export async function addDamSong(candidate: DamSongCandidate, clientRequestId: string, ownerSubject: string): Promise<DamAddResult> {
  if (mockMode()) {
    const replay = mockDamAdds.get(clientRequestId);
    if (replay) return replay;
    const duplicate = sampleSongs.find((song) => song.damNumber === candidate.damNumber);
    const song = duplicate ? null : await upsertSong({
      damNumber: candidate.damNumber,
      tjNumber: "",
      title: candidate.title,
      artist: candidate.artist,
      country: "일본",
      performerIds: [],
      sourceType: "clubdam",
      sourceReference: candidate.sourceUrl
    }, clientRequestId, ownerSubject);
    const result = damAddResultSchema.parse(duplicate
      ? { outcome: "duplicate", song: null, existing: duplicate, duplicateKind: "damNumber", canRestore: false, canOpen: true }
      : { outcome: "created", song, existing: null, duplicateKind: null, canRestore: false, canOpen: true });
    mockDamAdds.set(clientRequestId, result);
    return result;
  }
  return request("/api/dam/add", {
    method: "POST",
    headers: { "X-Songbook-Owner-Subject": ownerSubject },
    body: JSON.stringify({ candidate, clientRequestId })
  }, (data) => damAddResultSchema.parse(data));
}

export async function deleteSong(song: Pick<Song, "id" | "version">, clientRequestId: string, ownerSubject: string): Promise<Song> {
  if (mockMode()) {
    const index = sampleSongs.findIndex((item) => item.id === song.id);
    if (index < 0) throw new Error("삭제할 곡을 찾지 못했어요.");
    const [removed] = sampleSongs.splice(index, 1);
    return songSchema.parse(removed);
  }
  return request(`/api/songs/${encodeURIComponent(song.id)}/delete`, {
    method: "DELETE",
    headers: { "X-Songbook-Owner-Subject": ownerSubject },
    body: JSON.stringify({ songId: song.id, expectedVersion: song.version, clientRequestId })
  }, (data) => songSchema.parse(data));
}

export async function generateReading(input: { title: string; artist: string }, ownerSubject: string): Promise<{ titleReadingKo: string; artistReadingKo: string }> {
  if (mockMode()) return { titleReadingKo: input.title, artistReadingKo: input.artist };
  return request("/api/readings/generate", {
    method: "POST",
    headers: { "X-Songbook-Owner-Subject": ownerSubject },
    body: JSON.stringify(input)
  }, (data) => readingGenerateResultSchema.parse(data));
}

export async function fetchRecommendations(input: RecommendationRequest): Promise<RecommendationResult> {
  if (mockMode()) {
    const artists = [...new Set(sampleSongs.filter((song) => song.performerIds.some((id) => input.performerIds.includes(id))).map((song) => song.artist))];
    const remaining = artists.filter((artist) => !input.exclude?.includes(artist));
    const groups = remaining.slice(0, 5).map((artist) => {
      const index = artists.indexOf(artist);
      return recommendationGroupSchema.parse({
        name: artist,
        songCount: Math.max(1, 20 - index),
        candidates: [1, 2, 3].map((n) => input.system === "dam"
          ? { damNumber: `${9000 + index}-0${n}`, title: `${artist} 추천곡 ${n}`, artist, titleYomi: "", artistYomi: "", sourceUrl: damSongUrl(`${9000 + index}-0${n}`) }
          : { tjNumber: `${90000 + index * 10 + n}`, title: `${artist} 추천곡 ${n}`, artist, lyricist: "", composer: "", sourceUrl: "https://www.tjmedia.com/song/accompaniment_search" }),
        error: null
      });
    });
    return { groups, hasMore: remaining.length > 5 };
  }
  return request("/api/recommendations", {
    method: "POST",
    body: JSON.stringify(input)
  }, (data) => recommendationResultSchema.parse(data));
}
