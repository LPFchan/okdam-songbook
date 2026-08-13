// Cloudflare Worker entrypoint. All OAuth and Action traffic flows
// through this single Worker:
//
//   GET  /authorize         — ChatGPT hands the user off to Google OAuth
//   GET  /oauth/callback    — Google returns an authorization code, we
//                              verify the state cookie, exchange the code
//                              with Google, and re-redirect the user to
//                              ChatGPT with our own short-lived code.
//   POST /token             — ChatGPT exchanges our code (or refresh
//                              token) for an access token (HS256 JWT).
//   POST /api/:action       — Action handlers, Bearer access token.
//
// The single shared state store is `CodeStore` which holds pending
// authorization codes and refresh tokens for the configured TTL. State is
// kept in-process; for a single-operator internal tool this is enough.

import { ALLOWED_ACTIONS, isAllowedAction, readConfig, type WorkerConfig } from "./config";
import { CodeStore, type PendingCode, type RefreshTokenRecord } from "./store";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
  mintAuthorizationCode,
  mintAccessToken,
  mintRefreshToken,
  signStateCookie,
  verifyAuthorizationCode,
  verifyAccessToken,
  verifyPkce,
  verifyRefreshToken,
  verifyStateCookie
} from "./oauth";
import { buildAllowlist, generateState, normalizeEmail, parseAuthorizationHeader } from "@songbook/shared";
import { createBrowserAuth } from "./auth";
import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPS_SCRIPT_URL?: string;
  INTERNAL_PROXY_SECRET?: string;
  GPT_OAUTH_CLIENT_ID?: string;
  GPT_OAUTH_CLIENT_SECRET?: string;
  MARIE_EMAIL?: string;
  SEONGWOOK_EMAIL?: string;
  YEOWOOL_EMAIL?: string;
  COOKIE_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
  CALLBACK_BASE_URL?: string;
  CHATGPT_REDIRECT_URI?: string;
  CHATGPT_REDIRECT_URI_ALLOWLIST?: string;
  CODE_STORE_TTL_MS?: string;
  REFRESH_TOKEN_TTL_SECONDS?: string;
  AUTH_DB?: D1Database;
  BETTER_AUTH_ENABLED?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_TRUSTED_ORIGINS?: string;
  AUTH_SESSION_EXPIRES_IN_SECONDS?: string;
  AUTH_SESSION_UPDATE_AGE_SECONDS?: string;
}

export interface ForwardedActor {
  actorId: string;
  actorEmail: string;
  actorName: string;
  actorRole: "member";
  source: "chatgpt-action" | "browser-session";
}

const COOKIE_NAME = "songbook_chatgpt_state";
const STATE_COOKIE_TTL_SECONDS = 600;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export default {
  async fetch(request: Request, env: Env, ctx?: { codeStore?: CodeStore }): Promise<Response> {
    const url = new URL(request.url);
    const codeStore = ctx?.codeStore ?? sharedCodeStore;
    try {
      if (isBrowserAuthEnabled(env) && request.method === "OPTIONS" && isBrowserRoute(url.pathname)) {
        return withAuthCors(new Response(null, { status: 204 }), request, env);
      }
      if (isBrowserAuthEnabled(env) && (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/"))) {
        return await handleBrowserAuth(request, env);
      }
      if (isBrowserAuthEnabled(env) && request.method === "GET" && url.pathname === "/api/session") {
        return await handleBrowserSession(request, env);
      }
      if (isBrowserAuthEnabled(env) && request.method === "POST" && url.pathname.startsWith("/api/browser/")) {
        return await handleBrowserGateway(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/authorize") return await handleAuthorize(request, env, url);
      if (request.method === "GET" && url.pathname === "/oauth/callback") return await handleCallback(request, env, url, codeStore);
      if (request.method === "POST" && url.pathname === "/token") return await handleToken(request, env, codeStore);
      if (request.method === "POST" && url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (request.method === "GET" && url.pathname === "/healthz") return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(500, "INTERNAL_ERROR", message);
    }
  }
};

const sharedCodeStore = new CodeStore();

async function handleAuthorize(request: Request, env: Env, url: URL): Promise<Response> {
  const config = mustConfig(env);
  const gptRedirectUri = String(url.searchParams.get("redirect_uri") || "");
  const gptClientId = String(url.searchParams.get("client_id") || "");
  const gptState = String(url.searchParams.get("state") || "");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const scope = String(url.searchParams.get("scope") || "openid email profile");
  const responseType = String(url.searchParams.get("response_type") || "code");
  if (responseType !== "code") {
    return errorResponse(400, "BAD_REQUEST", "response_type=code 만 지원해.");
  }
  if (!gptRedirectUri) return errorResponse(400, "BAD_REQUEST", "redirect_uri 필요");
  if (!gptClientId || gptClientId !== config.gptOAuthClientId) {
    return errorResponse(400, "BAD_REQUEST", "client_id 불일치");
  }
  if (!isAllowedRedirectUri(gptRedirectUri, config)) {
    return errorResponse(400, "BAD_REQUEST", "허용되지 않은 redirect_uri");
  }
  if (codeChallengeMethod && codeChallengeMethod !== "S256" && codeChallengeMethod !== "plain") {
    return errorResponse(400, "BAD_REQUEST", "code_challenge_method 는 S256 또는 plain 만 지원");
  }
  if (codeChallenge && !codeChallengeMethod) {
    return errorResponse(400, "BAD_REQUEST", "code_challenge_method 가 필요해");
  }
  if (codeChallenge && codeChallenge.length < 43) {
    return errorResponse(400, "BAD_REQUEST", "code_challenge 가 너무 짧아");
  }
  const state = generateState();
  const googleRedirectUri = `${config.callbackBaseUrl}/oauth/callback`;
  const cookieValue = await signStateCookie(
    {
      state,
      gptRedirectUri,
      codeChallenge: codeChallenge || undefined,
      codeChallengeMethod: (codeChallengeMethod as "S256" | "plain") || undefined,
      returnTo: gptState || undefined
    },
    { cookieSecret: config.cookieSecret, ttlSeconds: STATE_COOKIE_TTL_SECONDS }
  );
  const target = buildAuthorizationUrl({
    clientId: config.googleClientId,
    redirectUri: googleRedirectUri,
    state,
    scope
  });
  const headers = new Headers({ Location: target });
  appendStateCookie(headers, cookieValue, STATE_COOKIE_TTL_SECONDS);
  return new Response(null, { status: 302, headers });
}

async function handleCallback(request: Request, env: Env, url: URL, codeStore: CodeStore): Promise<Response> {
  const config = mustConfig(env);
  const code = String(url.searchParams.get("code") || "");
  const stateFromGoogle = String(url.searchParams.get("state") || "");
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return new Response(`Google OAuth error: ${errorParam}`, { status: 400 });
  }
  const cookie = readCookie(request.headers.get("Cookie"), COOKIE_NAME);
  if (!code) return errorResponse(400, "BAD_REQUEST", "code 누락");
  if (!stateFromGoogle) return errorResponse(400, "BAD_REQUEST", "state 누락");
  if (!cookie) return errorResponse(400, "BAD_REQUEST", "state 쿠키 없음");
  const stored = await verifyStateCookie(cookie, config.cookieSecret);
  if (!stored) return errorResponse(400, "BAD_REQUEST", "state 쿠키 검증 실패");
  if (stored.state !== stateFromGoogle) return errorResponse(400, "BAD_REQUEST", "state 불일치");
  const googleTokens = await exchangeCodeForTokens({
    code,
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: `${config.callbackBaseUrl}/oauth/callback`
  });
  const profile = await fetchGoogleUserInfo(googleTokens.access_token);
  const allowlist = buildAllowlist([
    config.allowedEmails.marie,
    config.allowedEmails.seongwook,
    config.allowedEmails.yeowool
  ]);
  const email = normalizeEmail(profile.email);
  if (!allowlist.has(email)) {
    return errorResponse(403, "FORBIDDEN", "이 Songbook에 등록할 권한이 없어.");
  }
  const pending: PendingCode = {
    sub: profile.sub,
    email,
    name: profile.name,
    codeChallenge: stored.codeChallenge,
    codeChallengeMethod: stored.codeChallengeMethod,
    redirectUri: stored.gptRedirectUri,
    issuedAt: Date.now()
  };
  const workerCode = (await mintAuthorizationCode({
    ...pending,
    signingSecret: config.cookieSecret,
    ttlSeconds: Math.max(60, Math.floor(config.codeStoreTtlMs / 1000))
  })).token;
  codeStore.storeCode(workerCode, pending, config.codeStoreTtlMs);
  const target = new URL(stored.gptRedirectUri);
  target.searchParams.set("code", workerCode);
  if (stored.returnTo) target.searchParams.set("state", stored.returnTo);
  const headers = new Headers({ Location: target.toString() });
  clearStateCookie(headers);
  return new Response(null, { status: 302, headers });
}

async function handleToken(request: Request, env: Env, codeStore: CodeStore): Promise<Response> {
  const config = mustConfig(env);
  const form = await readFormBody(request);
  const grantType = String(form.grant_type || "");
  const clientId = String(form.client_id || "");
  const clientSecret = String(form.client_secret || "");
  if (!clientId || clientId !== config.gptOAuthClientId) {
    return tokenError("invalid_client", "client_id 불일치");
  }
  if (!clientSecret || clientSecret !== config.gptOAuthClientSecret) {
    return tokenError("invalid_client", "client_secret 불일치");
  }
  if (grantType === "authorization_code") {
    return await handleAuthorizationCodeGrant(form, config, codeStore);
  }
  if (grantType === "refresh_token") {
    return await handleRefreshTokenGrant(form, config, codeStore);
  }
  return tokenError("unsupported_grant_type", "grant_type 은 authorization_code 또는 refresh_token 만 지원");
}

async function handleAuthorizationCodeGrant(form: FormDataLike, config: WorkerConfig, codeStore: CodeStore): Promise<Response> {
  const code = String(form.code || "");
  const redirectUri = String(form.redirect_uri || "");
  const codeVerifier = String(form.code_verifier || "");
  if (!code) return tokenError("invalid_request", "code 누락");
  if (!redirectUri) return tokenError("invalid_request", "redirect_uri 누락");
  if (codeStore.isCodeUsed(code)) return tokenError("invalid_grant", "code 만료 또는 이미 사용됨");
  const pending = codeStore.takeCode(code) ?? await verifyAuthorizationCode(code, config.cookieSecret);
  if (!pending) return tokenError("invalid_grant", "code 만료 또는 이미 사용됨");
  if (!redirectUrisMatch(pending.redirectUri, redirectUri)) {
    return tokenError("invalid_grant", "redirect_uri 불일치");
  }
  codeStore.markCodeUsed(code, config.codeStoreTtlMs);
  if (pending.codeChallenge) {
    if (!codeVerifier) return tokenError("invalid_grant", "code_verifier 누락");
    const method = pending.codeChallengeMethod || "plain";
    const ok = await verifyPkce({ codeVerifier, codeChallenge: pending.codeChallenge, method });
    if (!ok) return tokenError("invalid_grant", "PKCE 검증 실패");
  }
  return await mintTokenResponse(pending, config, codeStore);
}

async function handleRefreshTokenGrant(form: FormDataLike, config: WorkerConfig, codeStore: CodeStore): Promise<Response> {
  const refreshToken = String(form.refresh_token || "");
  if (!refreshToken) return tokenError("invalid_request", "refresh_token 누락");
  if (codeStore.isRefreshTokenUsed(refreshToken)) return tokenError("invalid_grant", "refresh_token 만료 또는 이미 사용됨");
  const record = codeStore.takeRefreshToken(refreshToken) ?? await verifyRefreshToken(refreshToken, config.cookieSecret);
  if (!record) return tokenError("invalid_grant", "refresh_token 만료 또는 이미 사용됨");
  codeStore.markRefreshTokenUsed(refreshToken, config.refreshTokenTtlSeconds * 1000);
  return await mintTokenResponse(record, config, codeStore);
}

async function mintTokenResponse(actor: PendingCode | RefreshTokenRecord, config: WorkerConfig, codeStore: CodeStore): Promise<Response> {
  const jti = crypto.randomUUID();
  const access = await mintAccessToken({
    signingSecret: config.cookieSecret,
    sub: actor.sub,
    email: actor.email,
    name: actor.name,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    jti
  });
  const refreshRecord = {
    sub: actor.sub,
    email: actor.email,
    name: actor.name,
    issuedAt: Date.now()
  };
  const refresh = (await mintRefreshToken({
    ...refreshRecord,
    signingSecret: config.cookieSecret,
    ttlSeconds: config.refreshTokenTtlSeconds
  })).token;
  codeStore.storeRefreshToken(refresh, refreshRecord, config.refreshTokenTtlSeconds);
  return jsonResponse(200, {
    access_token: access.token,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope: "openid email profile"
  });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const config = mustConfig(env);
  const bearer = parseAuthorizationHeader(request.headers.get("Authorization"));
  if (!bearer) return errorResponse(401, "UNAUTHORIZED", "Bearer token 필요");
  const session = await verifyAccessToken(bearer, config.cookieSecret);
  if (!session) return errorResponse(401, "UNAUTHORIZED", "세션이 만료됐거나 위조됐어.");
  const allowlist = buildAllowlist([
    config.allowedEmails.marie,
    config.allowedEmails.seongwook,
    config.allowedEmails.yeowool
  ]);
  if (!allowlist.has(normalizeEmail(session.email))) {
    return errorResponse(403, "FORBIDDEN", "이 Songbook에 등록할 권한이 없어.");
  }
  const action = url.pathname.slice("/api/".length);
  if (!action) return errorResponse(400, "BAD_REQUEST", "action 누락");
  if (!isAllowedAction(action)) return errorResponse(403, "FORBIDDEN", "허용되지 않은 action이야.");
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return errorResponse(400, "BAD_REQUEST", "JSON body 파싱 실패");
  }
  if (action === "gptAddSong") {
    if (body.confirmed !== true) return errorResponse(409, "CONFIRMATION_REQUIRED", "사용자 확인이 필요해.");
    const clientRequestId = String(body.clientRequestId || "").trim();
    if (!clientRequestId) return errorResponse(400, "BAD_REQUEST", "clientRequestId 필요");
  }
  const forwarded = await forwardToAppsScript(config, {
    action,
    body,
    actor: {
      actorId: session.sub,
      actorEmail: normalizeEmail(session.email),
      actorName: session.name,
      actorRole: "member",
      source: "chatgpt-action"
    },
    requestId: crypto.randomUUID(),
    sessionEmail: normalizeEmail(session.email)
  });
  return jsonResponse(forwarded.status, forwarded.body);
}

function isBrowserAuthEnabled(env: Env): boolean {
  return String(env.BETTER_AUTH_ENABLED || "false").toLowerCase() === "true";
}

function isBrowserRoute(pathname: string): boolean {
  return pathname === "/api/session" || pathname === "/api/auth" || pathname.startsWith("/api/auth/") || pathname.startsWith("/api/browser/");
}

function authOrigins(env: Env): string[] {
  return String(env.AUTH_TRUSTED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function withAuthCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  const allowed = origin && authOrigins(env).includes(origin) ? origin : "";
  if (!allowed) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowed);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleBrowserAuth(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return withAuthCors(new Response(null, { status: 204 }), request, env);
  const auth = createBrowserAuth(env);
  return withAuthCors(await auth.handler(request), request, env);
}

interface BrowserSession {
  session: { id: string; userId: string; expiresAt: Date };
  user: { id: string; email: string; name: string; emailVerified: boolean };
}

async function getBrowserSession(request: Request, env: Env): Promise<BrowserSession | null> {
  if (!isBrowserAuthEnabled(env)) return null;
  const auth = createBrowserAuth(env);
  return await auth.api.getSession({ headers: request.headers }) as BrowserSession | null;
}

function browserActor(session: BrowserSession): ForwardedActor {
  return {
    actorId: session.user.id,
    actorEmail: normalizeEmail(session.user.email),
    actorName: session.user.name,
    actorRole: "member",
    source: "browser-session"
  };
}

async function handleBrowserSession(request: Request, env: Env): Promise<Response> {
  const session = await getBrowserSession(request, env);
  if (!session) return withAuthCors(jsonResponse(401, { error: "UNAUTHORIZED", data: null }), request, env);
  const actor = browserActor(session);
  // Apps Script remains the allowlist/role authority. The Worker only attests
  // the Better Auth session and forwards an actor; it never chooses a role.
  const forwarded = await forwardToAppsScript(readConfigForForwarding(env), {
    action: "currentUser",
    body: {},
    actor,
    requestId: crypto.randomUUID(),
    sessionEmail: actor.actorEmail
  });
  if (forwarded.status >= 400) return withAuthCors(jsonResponse(forwarded.status, forwarded.body), request, env);
  const payload = forwarded.body as { ok?: boolean; data?: unknown };
  if (!payload?.ok) return withAuthCors(jsonResponse(403, payload), request, env);
  const current = payload.data as { email?: string; displayName?: string; role?: string };
  return withAuthCors(jsonResponse(200, {
    data: {
      user: {
        id: actor.actorId,
        email: String(current.email || actor.actorEmail),
        name: String(current.displayName || actor.actorName),
        role: String(current.role || "editor")
      },
      session: { id: session.session.id, expiresAt: session.session.expiresAt }
    },
  }), request, env);
}

const BROWSER_ACTIONS = new Set(["upsertSong", "createPerformance", "cancelPerformance", "generateReading", "analyzeYouTube"]);

async function handleBrowserGateway(request: Request, env: Env, url: URL): Promise<Response> {
  const action = url.pathname.slice("/api/browser/".length);
  if (!BROWSER_ACTIONS.has(action)) return withAuthCors(errorResponse(404, "NOT_FOUND", "허용되지 않은 browser action이야."), request, env);
  const session = await getBrowserSession(request, env);
  if (!session) return withAuthCors(errorResponse(401, "UNAUTHORIZED", "브라우저 세션이 필요해."), request, env);
  const actor = browserActor(session);
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return withAuthCors(errorResponse(400, "BAD_REQUEST", "JSON body 파싱 실패"), request, env);
  }
  const forwarded = await forwardToAppsScript(readConfigForForwarding(env), {
    action,
    body,
    actor,
    requestId: crypto.randomUUID(),
    sessionEmail: actor.actorEmail
  });
  return withAuthCors(jsonResponse(forwarded.status, forwarded.body), request, env);
}

function readConfigForForwarding(env: Env): WorkerConfig {
  return mustConfig(env);
}

interface ForwardRequest {
  action: string;
  body: Record<string, unknown>;
  actor: ForwardedActor;
  requestId: string;
  sessionEmail: string;
}

async function forwardToAppsScript(config: WorkerConfig, input: ForwardRequest): Promise<{ status: number; body: unknown }> {
  const target = new URL(config.appsScriptUrl);
  target.searchParams.set("action", input.action);
  const forwardedBody = {
    ...input.body,
    action: input.action,
    __proxy: {
      secret: config.internalProxySecret,
      actorId: input.actor.actorId,
      actorEmail: input.actor.actorEmail,
      actorName: input.actor.actorName,
      actorRole: input.actor.actorRole,
      source: input.actor.source,
      requestId: input.requestId
    }
  };
  const response = await fetch(target.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "X-Internal-Proxy-Secret": config.internalProxySecret,
      "X-ChatGpt-Actor-Id": input.actor.actorId,
      "X-ChatGpt-Actor-Email": input.actor.actorEmail,
      "X-ChatGpt-Actor-Name": input.actor.actorName,
      "X-ChatGpt-Actor-Role": input.actor.actorRole,
      "X-ChatGpt-Source": input.actor.source,
      "X-ChatGpt-Request-Id": input.requestId
    },
    body: JSON.stringify(forwardedBody)
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: response.status, body: parsed };
}

function isAllowedRedirectUri(uri: string, config: WorkerConfig): boolean {
  return config.chatgptRedirectUriAllowList.includes(uri);
}

function redirectUrisMatch(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  try {
    const expectedUrl = new URL(expected);
    const actualUrl = new URL(actual);
    const hosts = new Set(["chatgpt.com", "chat.openai.com"]);
    return hosts.has(expectedUrl.host) &&
      hosts.has(actualUrl.host) &&
      expectedUrl.pathname === actualUrl.pathname &&
      expectedUrl.search === actualUrl.search;
  } catch {
    return false;
  }
}

function mustConfig(env: Env): WorkerConfig {
  const envMap: Record<string, string | undefined> = {
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    APPS_SCRIPT_URL: env.APPS_SCRIPT_URL,
    INTERNAL_PROXY_SECRET: env.INTERNAL_PROXY_SECRET,
    GPT_OAUTH_CLIENT_ID: env.GPT_OAUTH_CLIENT_ID,
    GPT_OAUTH_CLIENT_SECRET: env.GPT_OAUTH_CLIENT_SECRET,
    MARIE_EMAIL: env.MARIE_EMAIL,
    SEONGWOOK_EMAIL: env.SEONGWOOK_EMAIL,
    YEOWOOL_EMAIL: env.YEOWOOL_EMAIL,
    COOKIE_SECRET: env.COOKIE_SECRET,
    SESSION_TTL_SECONDS: env.SESSION_TTL_SECONDS,
    CALLBACK_BASE_URL: env.CALLBACK_BASE_URL,
    CHATGPT_REDIRECT_URI: env.CHATGPT_REDIRECT_URI,
    CHATGPT_REDIRECT_URI_ALLOWLIST: env.CHATGPT_REDIRECT_URI_ALLOWLIST,
    CODE_STORE_TTL_MS: env.CODE_STORE_TTL_MS,
    REFRESH_TOKEN_TTL_SECONDS: env.REFRESH_TOKEN_TTL_SECONDS
  };
  return readConfig(envMap);
}

interface FormDataLike {
  [key: string]: string;
}

async function readFormBody(request: Request): Promise<FormDataLike> {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    try {
      const text = await request.text();
      return (text ? JSON.parse(text) : {}) as FormDataLike;
    } catch {
      return {};
    }
  }
  try {
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text).entries());
  } catch {
    return {};
  }
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, {
    ok: false,
    data: null,
    error: { code, message, details: null },
    requestId: crypto.randomUUID(),
    serverTime: new Date().toISOString()
  });
}

function tokenError(error: string, description: string): Response {
  return jsonResponse(400, { error, error_description: description });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function appendStateCookie(headers: Headers, value: string, ttl: number): void {
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`
  );
}

function clearStateCookie(headers: Headers): void {
  headers.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export const __internals = {
  ALLOWED_ACTIONS,
  mustConfig,
  isAllowedRedirectUri,
  appendStateCookie,
  readCookie,
  clearStateCookie,
  handleAuthorize,
  handleCallback,
  handleToken,
  handleApi,
  browserActor,
  CodeStore
};
