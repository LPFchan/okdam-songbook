import { publicDataSchema, sampleSongs, type CurrentUser, type PublicData, type Song } from "@songbook/shared";
import { betterAuthApiUrl, betterAuthConfigured, getBetterAuthSession } from "./auth/client";

const apiUrl = import.meta.env.VITE_APPS_SCRIPT_API_URL as string | undefined;
function readMockMode(): boolean {
  return (import.meta.env.VITE_ENABLE_MOCK_API ?? "true") === "true";
}
// Mock is local-dev only. Production must explicitly disable mock and point at
// the real Apps Script /exec URL. An empty API URL must fail loudly.
export function mockMode(): boolean {
  return readMockMode();
}
export function productionMisconfigured(): boolean {
  return !readMockMode() && !apiUrl;
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
