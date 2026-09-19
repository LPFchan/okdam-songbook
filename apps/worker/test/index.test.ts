import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "@songbook/server-core";
import worker, { type Env } from "../src/index.js";

const schemaSql = readFileSync(fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)), "utf8");
const origin = "https://okdam.example";

/**
 * The Worker entry driven end to end with the same fakes the D1 service suite
 * uses: better-sqlite3 behind the D1 binding shape, and an Assets fetcher
 * that knows the built files by name. What is under test is the glue the
 * Node server never had — asset fallback, header attachment, path ownership.
 */
function fakeD1(): D1DatabaseLike {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(schemaSql);
  const statement = (sql: string): D1PreparedStatementLike => {
    let bound: unknown[] = [];
    const self: D1PreparedStatementLike = {
      bind(...values: unknown[]) { bound = values; return self; },
      async first<T>() { return (db.prepare(sql).get(...(bound as never[])) ?? null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...(bound as never[])) as T[] }; },
      async run() { const r = db.prepare(sql).run(...(bound as never[])); return { meta: { changes: Number(r.changes) } }; }
    };
    return self;
  };
  return { prepare: statement };
}

function fakeAssets(files: Record<string, string>): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = files[url.pathname];
      if (body === undefined) return new Response("asset not found", { status: 404 });
      const type = url.pathname.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript";
      return new Response(body, { status: 200, headers: { "Content-Type": type, "Cache-Control": "public, max-age=0, must-revalidate" } });
    }
  } as unknown as Fetcher;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    SONGBOOK_DB: fakeD1() as unknown as D1Database,
    ASSETS: fakeAssets({ "/index.html": "<!doctype html><title>shell</title>", "/app.js": "console.log(1)" }),
    ORIGIN: origin,
    ...overrides
  };
}

const identity = {
  "X-Lost-Plus-Encoding": "percent-utf8",
  "X-Lost-Plus-Sub": "42",
  "X-Lost-Plus-Email": "allowed%40example.com",
  "X-Lost-Plus-Name": "%EC%97%AC%EC%9A%B8",
  "X-Lost-Plus-Role": "user"
};

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}${path}`, { headers });
}

async function fetchWorker(request: Request, workerEnv: Env): Promise<Response> {
  return worker.fetch(request, workerEnv);
}

async function envelopeData<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

describe("okdam-songbook Worker", () => {
  it("serves the SPA shell for deep links and denies framing on every HTML response", async () => {
    const workerEnv = env();
    for (const path of ["/", "/index.html", "/admin", "/songs/abc"]) {
      const response = await fetchWorker(get(path), workerEnv);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toContain("shell");
      expect(response.headers.get("X-Frame-Options"), path).toBe("DENY");
      expect(response.headers.get("Content-Security-Policy"), path).toContain("frame-ancestors 'none'");
    }
    const script = await fetchWorker(get("/app.js"), workerEnv);
    expect(script.status).toBe(200);
    expect(script.headers.get("X-Frame-Options")).toBeNull();
  });

  it("keeps server-owned paths and missing files out of the SPA fallback", async () => {
    const workerEnv = env();
    for (const path of ["/api/nope", "/api", "/mcp/extra", "/.well-known/anything"]) {
      const response = await fetchWorker(get(path), workerEnv);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("shell");
    }
    expect((await fetchWorker(get("/missing.png"), workerEnv)).status).toBe(404);
  });

  it("answers the public catalog and health check from D1", async () => {
    const workerEnv = env();
    const health = await fetchWorker(get("/healthz"), workerEnv);
    expect(await health.json()).toEqual({ ok: true });
    const catalog = await fetchWorker(get("/api/catalog"), workerEnv);
    expect(catalog.status).toBe(200);
    expect((await envelopeData<{ songs: unknown[] }>(catalog)).songs).toEqual([]);
  });

  it("reads identity only from the gateway headers", async () => {
    const workerEnv = env();
    expect((await fetchWorker(get("/api/me"), workerEnv)).status).toBe(401);
    expect((await fetchWorker(get("/api/me", { Authorization: "Bearer anything" }), workerEnv)).status).toBe(401);
    expect((await fetchWorker(get("/api/me", { ...identity, "X-Lost-Plus-Encoding": "raw" }), workerEnv)).status).toBe(401);
    const me = await fetchWorker(get("/api/me", identity), workerEnv);
    expect(me.status).toBe(200);
    expect(await envelopeData(me)).toMatchObject({ subject: "auth.lost.plus:42", email: "allowed@example.com", displayName: "여울" });

    const mcpChallenge = await fetchWorker(new Request(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), workerEnv);
    expect(mcpChallenge.status).toBe(401);
    expect(mcpChallenge.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("writes through the D1 executor with the same-origin browser rules", async () => {
    const workerEnv = env();
    const headers = { ...identity, Origin: origin, "Content-Type": "application/json", "X-Songbook-Owner-Subject": "auth.lost.plus:42" };
    const created = await fetchWorker(new Request(`${origin}/api/songs`, {
      method: "POST", headers, body: JSON.stringify({ title: "Worker song", artist: "Artist", clientRequestId: crypto.randomUUID() })
    }), workerEnv);
    expect(created.status).toBe(200);
    const crossOrigin = await fetchWorker(new Request(`${origin}/api/songs`, {
      method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: JSON.stringify({ title: "Nope", artist: "Artist", clientRequestId: crypto.randomUUID() })
    }), workerEnv);
    expect(crossOrigin.status).toBe(403);
    const catalog = await fetchWorker(get("/api/catalog"), workerEnv);
    expect((await envelopeData<{ songs: { title: string }[] }>(catalog)).songs.map((song) => song.title)).toEqual(["Worker song"]);
  });

  it("refuses to start without ORIGIN", async () => {
    const response = await fetchWorker(get("/healthz"), env({ ORIGIN: "" }));
    expect(response.status).toBe(500);
  });
});
