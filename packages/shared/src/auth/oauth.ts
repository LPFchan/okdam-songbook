// Lightweight OAuth and session-token helpers shared between the Cloudflare
// Worker and the test suite. The Worker signs short-lived session tokens
// (HS256) using INTERNAL_PROXY_SECRET; the secret never leaves the
// Worker boundary, and the Apps Script side only trusts the upstream
// proxy's INTERNAL_PROXY_SECRET header.

export interface OAuthSessionClaims {
  sub: string;
  email: string;
  name: string;
  iat: number;
  exp: number;
}

export interface SignedToken {
  token: string;
  expiresAt: number;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i];
    if (value !== undefined) binary += String.fromCharCode(value);
  }
  const b64 = typeof btoa === "function" ? btoa(binary) : "";
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(input: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(input));
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const binary = typeof atob === "function" ? atob(padded) : "";
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(sig);
}

function bytesToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i];
    if (value !== undefined) s += String.fromCharCode(value);
  }
  return s;
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function normalizeEmail(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function buildAllowlist(values: Array<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  values.forEach((value) => {
    const normalized = normalizeEmail(value);
    if (normalized) set.add(normalized);
  });
  return set;
}

export function generateState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

export interface CreateSessionOptions {
  secret: string;
  sub: string;
  email: string;
  name: string;
  ttlSeconds: number;
  nowMs?: number;
  extraClaims?: Record<string, unknown>;
}

export async function createSessionToken(options: CreateSessionOptions): Promise<SignedToken> {
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const exp = now + Math.max(60, options.ttlSeconds);
  const payload: OAuthSessionClaims & Record<string, unknown> = {
    sub: options.sub,
    email: normalizeEmail(options.email),
    name: String(options.name || ""),
    iat: now,
    exp,
    ...(options.extraClaims || {})
  };
  const headerEncoded = base64UrlEncodeString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadEncoded = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const sig = await hmacSha256(options.secret, signingInput);
  return { token: `${signingInput}.${base64UrlEncodeBytes(sig)}`, expiresAt: exp * 1000 };
}

export async function verifySessionToken(token: string, secret: string, nowMs?: number): Promise<OAuthSessionClaims | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const headerEncoded = String(parts[0] || "");
  const payloadEncoded = String(parts[1] || "");
  const signature = String(parts[2] || "");
  const expectedSig = await hmacSha256(secret, `${headerEncoded}.${payloadEncoded}`);
  const providedSig = base64UrlDecode(signature || "");
  if (providedSig.length !== expectedSig.length) return null;
  if (!constantTimeEquals(bytesToString(expectedSig), bytesToString(providedSig))) return null;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadEncoded));
    const payload = JSON.parse(payloadJson) as OAuthSessionClaims;
    const nowSeconds = Math.floor((nowMs ?? Date.now()) / 1000);
    if (!payload.exp || payload.exp <= nowSeconds) return null;
    if (!payload.email || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseAuthorizationHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = String(value).match(/^Bearer[ \t]+([^\s]+)$/i);
  const captured = match ? match[1] : null;
  return captured ? captured.trim() : null;
}
