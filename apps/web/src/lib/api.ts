import {
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
import { betterAuthApiUrl, betterAuthConfigured, getBetterAuthSession } from "./auth/client";

const apiUrl = import.meta.env.VITE_APPS_SCRIPT_API_URL as string | undefined;
const mockTjAdds = new Map<string, TjAddResult>();

function normalizeTjDuplicateText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
function readMockMode(): boolean {
  return (import.meta.env.VITE_ENABLE_MOCK_API ?? "true") === "true";
}
// Mock is local-dev only. Production must explicitly disable mock and point at
// the real Apps Script /exec URL. An empty API URL must fail loudly.
export function mockMode(): boolean {
  return readMockMode();
}
export function productionMisconfigured(): boolean {
  return !readMockMode() && !apiUrl && !betterAuthConfigured();
}

function missingApiUrl(): never {
  throw new Error("VITE_APPS_SCRIPT_API_URL이 설정되지 않았어. Apps Script webapp /exec URL을 GitHub Actions Variable에 등록해.");
}

function nowIso(): string {
  return new Date().toISOString();
}

interface ParsedApiError {
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

async function readApiError(response: Response): Promise<ParsedApiError> {
  try {
    const body = (await response.json()) as { ok?: boolean; error?: { code?: string; message?: string; details?: unknown } };
    const code = body?.error?.code ?? "INTERNAL_ERROR";
    const message = body?.error?.message ?? "요청에 실패했어.";
    return { code, message, status: response.status, payload: body };
  } catch {
    return { code: "INTERNAL_ERROR", message: "요청에 실패했어.", status: response.status };
  }
}

async function parseResponse<T>(response: Response, parser: (value: unknown) => T): Promise<T> {
  const json = await response.json();
  if (!json.ok) {
    const code = json.error?.code ?? "INTERNAL_ERROR";
    const message = json.error?.message ?? "요청에 실패했어.";
    const err = new Error(message) as Error & { code?: string; status?: number; payload?: unknown };
    err.code = code;
    err.status = response.status;
    err.payload = json;
    throw err;
  }
  return parser(json.data);
}

export async function fetchPublicData(): Promise<PublicData> {
  if (productionMisconfigured()) missingApiUrl();
  if (mockMode()) {
    return publicDataSchema.parse({
      songs: sampleSongs,
      serverVersion: "mock-1",
      updatedAt: nowIso()
    });
  }
  const response = await fetch(`${apiUrl}?action=publicData`, { method: "GET" });
  return parseResponse(response, (data) => publicDataSchema.parse(data));
}

// All write/read API surfaces are now credential-agnostic: callers must pass a
// valid, non-expired Google ID token obtained from the AuthProvider. This keeps
// the API surface thin and prevents ad-hoc tokens from sneaking through.

function unauthorizedError(code: string, message: string, status: number, payload: unknown): Error {
  const err = new Error(message) as Error & { code?: string; status?: number; payload?: unknown };
  err.code = code;
  err.status = status;
  err.payload = payload;
  return err;
}

async function parseWriteResponse<T>(response: Response, parser: (value: unknown) => T): Promise<T> {
  if (!response.ok) {
    const error = await readApiError(response);
    if (isUnauthorizedError(error.code)) {
      throw unauthorizedError(error.code, error.message, error.status, error.payload);
    }
    throw unauthorizedError("INTERNAL_ERROR", error.message, error.status, error.payload);
  }
  const json = (await response.json()) as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; details?: unknown } };
  if (!json.ok) {
    const code = json.error?.code ?? "INTERNAL_ERROR";
    const message = json.error?.message ?? "요청에 실패했어.";
    if (isUnauthorizedError(code)) {
      throw unauthorizedError(code, message, response.status, json);
    }
    const err = new Error(message) as Error & { code?: string; status?: number; payload?: unknown };
    err.code = code;
    err.status = response.status;
    err.payload = json;
    throw err;
  }
  return parser(json.data);
}

function encodeClientRequestId(requestId: string): string {
  return requestId;
}

export async function fetchCurrentUser(idToken?: string): Promise<CurrentUser> {
  if (mockMode()) return { email: "owner@example.com", displayName: "마리", role: "owner" };
  if (betterAuthConfigured()) {
    const session = await getBetterAuthSession();
    if (!session) throw unauthorizedError("UNAUTHORIZED", "로그인이 필요해.", 401, null);
    return {
      email: session.user.email,
      displayName: session.user.name,
      role: session.user.role
    };
  }
  const response = await fetch(`${apiUrl}?action=currentUser`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken })
  });
  return parseWriteResponse(response, (data) => data as CurrentUser);
}

export async function createPerformance(songId: string, idToken: string, clientRequestId: string): Promise<{ id: string; duplicate?: boolean }> {
  if (mockMode()) return { id: `mock-${encodeClientRequestId(clientRequestId)}` };
  if (betterAuthConfigured()) return protectedBrowserAction("createPerformance", { songId, clientRequestId: encodeClientRequestId(clientRequestId), performedAt: nowIso() }) as Promise<{ id: string; duplicate?: boolean }>;
  const response = await fetch(`${apiUrl}?action=createPerformance`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, songId, clientRequestId: encodeClientRequestId(clientRequestId), performedAt: nowIso() })
  });
  return parseWriteResponse(response, (data) => data as { id: string; duplicate?: boolean });
}

export async function cancelPerformance(performanceId: string, idToken: string, clientRequestId: string): Promise<void> {
  if (mockMode()) return;
  if (betterAuthConfigured()) {
    await protectedBrowserAction("cancelPerformance", { performanceId, clientRequestId: encodeClientRequestId(clientRequestId) });
    return;
  }
  const response = await fetch(`${apiUrl}?action=cancelPerformance`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, performanceId, clientRequestId: encodeClientRequestId(clientRequestId) })
  });
  await parseWriteResponse(response, () => null);
}

export async function upsertSong(song: Partial<Song>, idToken: string, clientRequestId: string): Promise<Song> {
  if (mockMode()) {
    return { ...sampleSongs[0], ...song, id: song.id || crypto.randomUUID(), version: (song.version ?? 0) + 1 } as Song;
  }
  if (betterAuthConfigured()) return protectedBrowserAction("upsertSong", { song, clientRequestId: encodeClientRequestId(clientRequestId) }) as Promise<Song>;
  const response = await fetch(`${apiUrl}?action=upsertSong`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, song, clientRequestId: encodeClientRequestId(clientRequestId) })
  });
  return parseWriteResponse(response, (data) => songSchema.parse(data));
}

export async function lookupTjSong(input: TjLookupRequest, idToken: string): Promise<TjLookupResult> {
  if (mockMode()) {
    const candidate = sampleSongs.find((song) => song.tjNumber === input.tjNumber);
    return tjLookupResultSchema.parse({
      query: input.tjNumber,
      candidate: candidate ? { tjNumber: candidate.tjNumber, title: candidate.title, artist: candidate.artist, lyricist: "", composer: "", sourceUrl: `https://www.tjmedia.com/song/accompaniment_search?searchTxt=${candidate.tjNumber}` } : null,
      candidates: candidate ? [{ tjNumber: candidate.tjNumber, title: candidate.title, artist: candidate.artist, lyricist: "", composer: "", sourceUrl: `https://www.tjmedia.com/song/accompaniment_search?searchTxt=${candidate.tjNumber}` }] : [],
      sourceUrl: "https://www.tjmedia.com/song/accompaniment_search"
    });
  }
  if (betterAuthConfigured()) return protectedBrowserAction("lookupTjSong", input) as Promise<TjLookupResult>;
  if (productionMisconfigured()) missingApiUrl();
  const response = await fetch(`${apiUrl}?action=lookupTjSong`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, ...input })
  });
  return parseWriteResponse(response, (data) => tjLookupResultSchema.parse(data));
}

export async function searchTjSongs(input: TjSearchRequest, idToken: string): Promise<TjSearchResult> {
  if (mockMode()) {
    const query = input.query.toLocaleLowerCase();
    const candidates = sampleSongs.filter((song) => `${song.title} ${song.artist}`.toLocaleLowerCase().includes(query)).map((song) => ({
      tjNumber: song.tjNumber,
      title: song.title,
      artist: song.artist,
      lyricist: "",
      composer: "",
      sourceUrl: `https://www.tjmedia.com/song/accompaniment_search?searchTxt=${encodeURIComponent(input.query)}`
    }));
    return tjSearchResultSchema.parse({ query: input.query, searchType: input.searchType ?? "all", nation: input.nation ?? "", page: input.page ?? 1, pageSize: input.pageSize ?? 15, hasMore: false, candidates, sourceUrl: "https://www.tjmedia.com/song/accompaniment_search" });
  }
  if (betterAuthConfigured()) return protectedBrowserAction("searchTjSongs", input) as Promise<TjSearchResult>;
  if (productionMisconfigured()) missingApiUrl();
  const response = await fetch(`${apiUrl}?action=searchTjSongs`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, ...input })
  });
  return parseWriteResponse(response, (data) => tjSearchResultSchema.parse(data));
}

export async function addTjSong(candidate: TjSongCandidate, idToken: string, clientRequestId: string): Promise<TjAddResult> {
  if (mockMode()) {
    const replay = mockTjAdds.get(clientRequestId);
    if (replay) return replay;
    const duplicate = sampleSongs.find((song) => song.tjNumber === candidate.tjNumber || (
      normalizeTjDuplicateText(song.title) === normalizeTjDuplicateText(candidate.title)
      && normalizeTjDuplicateText(song.artist) === normalizeTjDuplicateText(candidate.artist)
    ));
    if (duplicate) {
      const result = tjAddResultSchema.parse({ outcome: duplicate.status === "deleted" ? "deleted" : "duplicate", song: null, existing: duplicate, duplicateKind: duplicate.tjNumber === candidate.tjNumber ? "tjNumber" : "titleArtist", canRestore: false, canOpen: true });
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
    }, idToken, clientRequestId);
    const result = tjAddResultSchema.parse({ outcome: "created", song, existing: null, duplicateKind: null, canRestore: false, canOpen: true });
    mockTjAdds.set(clientRequestId, result);
    return result;
  }
  if (betterAuthConfigured()) return protectedBrowserAction("addTjSong", { candidate, clientRequestId: encodeClientRequestId(clientRequestId) }) as Promise<TjAddResult>;
  if (productionMisconfigured()) missingApiUrl();
  const response = await fetch(`${apiUrl}?action=addTjSong`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, candidate, clientRequestId: encodeClientRequestId(clientRequestId) })
  });
  return parseWriteResponse(response, (data) => tjAddResultSchema.parse(data));
}

export async function restoreSong(songId: string, idToken: string, clientRequestId: string): Promise<Song> {
  if (mockMode()) {
    const existing = sampleSongs.find((song) => song.id === songId);
    if (!existing) throw new Error("복구할 곡을 찾지 못했어.");
    return { ...existing, status: "active" };
  }
  if (betterAuthConfigured()) return protectedBrowserAction("restoreSong", { songId, clientRequestId: encodeClientRequestId(clientRequestId) }) as Promise<Song>;
  if (productionMisconfigured()) missingApiUrl();
  const response = await fetch(`${apiUrl}?action=restoreSong`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, songId, clientRequestId: encodeClientRequestId(clientRequestId) })
  });
  return parseWriteResponse(response, (data) => data as Song);
}

export async function analyzeYouTube(url: string, idToken: string): Promise<Partial<Song>> {
  if (mockMode()) return { youtubeUrl: url, sourceType: "youtube", sourceReference: url };
  if (betterAuthConfigured()) return protectedBrowserAction("analyzeYouTube", { url }) as Promise<Partial<Song>>;
  const response = await fetch(`${apiUrl}?action=analyzeYouTube`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, url })
  });
  return parseWriteResponse(response, (data) => data as Partial<Song>);
}

export async function generateReading(input: { title: string; artist: string }, idToken: string): Promise<{ titleReadingKo: string; artistReadingKo: string }> {
  if (mockMode()) return { titleReadingKo: input.title, artistReadingKo: input.artist };
  if (betterAuthConfigured()) return protectedBrowserAction("generateReading", { input }) as Promise<{ titleReadingKo: string; artistReadingKo: string }>;
  const response = await fetch(`${apiUrl}?action=generateReading`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, input })
  });
  return parseWriteResponse(response, (data) => data as { titleReadingKo: string; artistReadingKo: string });
}

async function protectedBrowserAction<T = unknown>(action: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(betterAuthApiUrl(action), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseWriteResponse(response, (data) => data as T);
}
