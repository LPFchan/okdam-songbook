import { Hono } from "hono";
import {
  createTjAdapter,
  createTjSearchMirror,
  openD1Database
} from "@songbook/server-core";
import { createConfiguredServer, isServerPath, readingGeneratorFromEnvironment } from "@songbook/server";

export interface Env {
  SONGBOOK_DB: D1Database;
  ASSETS: Fetcher;
  ORIGIN: string;
  AI_ENDPOINT?: string;
  CLOUDFLARE_AI_API_TOKEN?: string;
  AI_MODEL?: string;
}

function assetHeaders(pathname: string): Record<string, string> {
  const lower = pathname.toLowerCase();
  const isHtml = lower.endsWith(".html") || lower === "/" || !lower.includes(".");
  if (!isHtml) return {};
  return {
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY"
  };
}

/**
 * The Workers runtime cannot read the filesystem, so static assets come from
 * the Workers Assets binding. API and MCP paths are handled by the Hono app;
 * everything else is proxied to Assets with an index.html fallback for the
 * SPA, mirroring the Node server's staticResponse behavior. A path the server
 * owns that reached this point is unknown to it, and stays a 404 rather than
 * becoming the app shell.
 */
async function serveAsset(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (isServerPath(pathname)) return new Response("Not Found", { status: 404 });
  const direct = await env.ASSETS.fetch(new Request(url.toString(), request));
  const looksLikeFile = /\.[a-z0-9]+$/i.test(pathname);
  if (direct.status !== 404 || looksLikeFile) return withAssetHeaders(direct, pathname);
  const fallbackUrl = new URL("/index.html", url);
  const fallback = await env.ASSETS.fetch(new Request(fallbackUrl.toString(), request));
  return withAssetHeaders(fallback, "/index.html");
}

function withAssetHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(assetHeaders(pathname))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createWorkerApp(env: Env): Hono {
  const origin = (env.ORIGIN ?? "").replace(/\/$/, "");
  if (!origin) throw new Error("ORIGIN is not configured");

  const database = openD1Database(env.SONGBOOK_DB);
  const server = createConfiguredServer({
    database,
    origin,
    tj: createTjAdapter({
      mirror: createTjSearchMirror(database.sqlite),
      onWarn: (warning) => console.warn(JSON.stringify({ event: "tj_adapter_warning", ...warning }))
    }),
    readingGenerator: readingGeneratorFromEnvironment({ AI_ENDPOINT: env.AI_ENDPOINT, CLOUDFLARE_AI_API_TOKEN: env.CLOUDFLARE_AI_API_TOKEN, AI_MODEL: env.AI_MODEL })
    // assetsRoot intentionally omitted: the Worker serves statics itself.
  });

  const app = new Hono();
  app.route("/", server.app);
  app.all("*", (c) => serveAsset(env, c.req.raw));
  return app;
}

/**
 * Built once per isolate and reused across the requests it serves, keyed on
 * the D1 binding so a different env (tests, a future second binding) gets its
 * own app. The MCP body gate and the TJ throttle live inside the app; built
 * per request they would reset on every call and limit nothing.
 */
const apps = new WeakMap<object, Hono>();

function workerApp(env: Env): Hono {
  let app = apps.get(env.SONGBOOK_DB);
  if (!app) {
    app = createWorkerApp(env);
    apps.set(env.SONGBOOK_DB, app);
  }
  return app;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let app: Hono;
    try {
      app = workerApp(env);
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "Worker is not configured", { status: 500 });
    }
    return app.fetch(request, env);
  }
} satisfies ExportedHandler<Env>;
