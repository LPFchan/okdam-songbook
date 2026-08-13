import {
  apiFailureSchema,
  currentUserSchema,
  publicDataSchema,
  sampleSongs,
  songSchema,
  tjAddResultSchema,
  tjLookupResultSchema,
  tjSearchResultSchema,
  type CurrentUser,
  type PublicData,
  type Song,
  type TjAddResult,
  type TjSongCandidate,
  type TjLookupRequest,
  type TjLookupResult,
  type TjSearchRequest,
  type TjSearchResult
} from "@songbook/shared";

const mockTjAdds = new Map<string, TjAddResult>();

function normalizeTjDuplicateText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Mock data is intended for local tests only; production sets this to false. */
export function mockMode(): boolean {
  return (import.meta.env.VITE_ENABLE_MOCK_API ?? "false") === "true";
}

export interface ParsedApiError {
  code: string;
  message: string;
  status: number;
  payload?: unknown;
}

function isUnauthorizedError(code: string): boolean {
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
}

export function isApiAuthError(error: unknown): error is ParsedApiError {
  return Boolean(error && typeof error === "object" && "code" in (error as Record<string, unknown>))
    && isUnauthorizedError(String((error as ParsedApiError).code));
}

function apiError(code: string, message: string, status: number, payload?: unknown): ParsedApiError {
  return { code, message, status, payload };
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
  if (mockMode()) return currentUserSchema.parse({ email: "owner@example.com", displayName: "마리", role: "owner" });
  return request("/api/me", { method: "GET" }, (data) => currentUserSchema.parse(data));
}

export async function createPerformance(songId: string, clientRequestId: string, performedAt = nowIso()): Promise<{ id: string; duplicate?: boolean }> {
  if (mockMode()) return { id: `mock-${clientRequestId}` };
  return request("/api/performances", {
    method: "POST",
    body: JSON.stringify({ songId, performedAt, clientRequestId })
  }, (data) => data as { id: string; duplicate?: boolean });
}

export async function cancelPerformance(performanceId: string, clientRequestId: string): Promise<void> {
  if (mockMode()) return;
  await request(`/api/performances/${encodeURIComponent(performanceId)}`, {
    method: "DELETE",
    body: JSON.stringify({ performanceId, clientRequestId })
  }, () => null);
}

export async function upsertSong(song: Partial<Song>, clientRequestId: string): Promise<Song> {
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
      body: JSON.stringify({ ...song, id: song.id, expectedVersion: song.version ?? 0, clientRequestId })
    }, (data) => songSchema.parse(data));
  }

  return request("/api/songs", {
    method: "POST",
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

export async function addTjSong(candidate: TjSongCandidate, clientRequestId: string): Promise<TjAddResult> {
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
      status: "active",
      country: "",
      performerIds: [],
      sourceType: "tjmedia",
      sourceReference: candidate.sourceUrl
    }, clientRequestId);
    const result = tjAddResultSchema.parse({ outcome: "created", song, existing: null, duplicateKind: null, canRestore: false, canOpen: true });
    mockTjAdds.set(clientRequestId, result);
    return result;
  }
  return request("/api/tj/add", {
    method: "POST",
    body: JSON.stringify({ candidate, clientRequestId })
  }, (data) => tjAddResultSchema.parse(data));
}

export async function deleteSong(song: Pick<Song, "id" | "version">, clientRequestId: string): Promise<Song> {
  if (mockMode()) {
    const index = sampleSongs.findIndex((item) => item.id === song.id);
    if (index < 0) throw new Error("삭제할 곡을 찾지 못했어요.");
    const [removed] = sampleSongs.splice(index, 1);
    return songSchema.parse(removed);
  }
  return request(`/api/songs/${encodeURIComponent(song.id)}/delete`, {
    method: "DELETE",
    body: JSON.stringify({ songId: song.id, expectedVersion: song.version, clientRequestId })
  }, (data) => songSchema.parse(data));
}

/** These older helpers have no route in the shared single-origin contract yet. */
export async function analyzeYouTube(url: string): Promise<Partial<Song>> {
  if (mockMode()) return { youtubeUrl: url, sourceType: "youtube", sourceReference: url };
  throw new Error("YouTube 분석은 아직 서버에서 제공되지 않아요.");
}

export async function generateReading(input: { title: string; artist: string }): Promise<{ titleReadingKo: string; artistReadingKo: string }> {
  if (mockMode()) return { titleReadingKo: input.title, artistReadingKo: input.artist };
  throw new Error("독음 생성은 아직 서버에서 제공되지 않아요.");
}
