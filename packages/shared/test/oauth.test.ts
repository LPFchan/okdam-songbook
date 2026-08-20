import { describe, expect, it } from "vitest";
import {
  buildAllowlist,
  constantTimeEquals,
  createSessionToken,
  generateState,
  normalizeEmail,
  parseAuthorizationHeader,
  verifySessionToken
} from "../src/auth/oauth";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Example.COM  ")).toBe("foo@example.com");
  });
  it("handles empty / nullish", () => {
    expect(normalizeEmail("")).toBe("");
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
  });
});

describe("buildAllowlist", () => {
  it("lowercases and dedupes", () => {
    const set = buildAllowlist(["a@example.com", " A@Example.com ", "", "B@example.com"]);
    expect([...set].sort()).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("constantTimeEquals", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
  });
  it("returns false for different strings of equal length", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false);
  });
  it("returns false for different lengths", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });
});

describe("generateState", () => {
  it("generates a non-empty base64url string", () => {
    const s = generateState();
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("generates distinct values", () => {
    const set = new Set([generateState(), generateState(), generateState()]);
    expect(set.size).toBe(3);
  });
});

describe("createSessionToken / verifySessionToken", () => {
  it("round-trips valid claims", async () => {
    const session = await createSessionToken({
      secret: "secret-1",
      sub: "user-1",
      email: "Marie@Example.com",
      name: "Marie",
      ttlSeconds: 60
    });
    const claims = await verifySessionToken(session.token, "secret-1");
    expect(claims).toMatchObject({ sub: "user-1", email: "marie@example.com", name: "Marie" });
    expect(claims?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns null for tampered signature", async () => {
    const session = await createSessionToken({
      secret: "secret-1",
      sub: "user-1",
      email: "marie@example.com",
      name: "Marie",
      ttlSeconds: 60
    });
    const [h, p] = session.token.split(".");
    const tampered = `${h}.${p}.AAAA`;
    expect(await verifySessionToken(tampered, "secret-1")).toBeNull();
  });

  it("returns null when secret differs", async () => {
    const session = await createSessionToken({
      secret: "secret-1",
      sub: "user-1",
      email: "marie@example.com",
      name: "Marie",
      ttlSeconds: 60
    });
    expect(await verifySessionToken(session.token, "other-secret")).toBeNull();
  });

  it("returns null for expired tokens", async () => {
    const past = Date.now() - 60_000;
    const session = await createSessionToken({
      secret: "secret-1",
      sub: "user-1",
      email: "marie@example.com",
      name: "Marie",
      ttlSeconds: 60,
      nowMs: past
    });
    expect(await verifySessionToken(session.token, "secret-1")).toBeNull();
  });

  it("supports extraClaims", async () => {
    const session = await createSessionToken({
      secret: "secret-1",
      sub: "user-1",
      email: "marie@example.com",
      name: "Marie",
      ttlSeconds: 60,
      extraClaims: { state: "abc", returnTo: "https://chatgpt.com" }
    });
    const decoded = await verifySessionToken(session.token, "secret-1");
    expect((decoded as unknown as { state?: string })?.state).toBe("abc");
    expect((decoded as unknown as { returnTo?: string })?.returnTo).toBe("https://chatgpt.com");
  });
});

describe("parseAuthorizationHeader", () => {
  it("extracts bearer token", () => {
    expect(parseAuthorizationHeader("Bearer abc123")).toBe("abc123");
  });
  it("returns null when missing", () => {
    expect(parseAuthorizationHeader(null)).toBeNull();
    expect(parseAuthorizationHeader("")).toBeNull();
    expect(parseAuthorizationHeader("Basic abc")).toBeNull();
    expect(parseAuthorizationHeader("Bearer")).toBeNull();
    expect(parseAuthorizationHeader("Bearer ")).toBeNull();
    expect(parseAuthorizationHeader("Bearer abc def")).toBeNull();
  });
});
