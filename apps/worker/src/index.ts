import { Hono } from "hono";
import {
  createTjAdapter,
  createTjSearchMirror,
  openD1Database
} from "@songbook/server-core";
import { createConfiguredServer, createAiReadingGenerator, type ReadingGenerator } from "@songbook/server";

export interface Env {
  SONGBOOK_DB: D1Database;
  ASSETS: Fetcher;
  ORIGIN: string;
  AI_ENDPOINT?: string;
  CLOUDFLARE_AI_API_TOKEN?: string;
  AI_MODEL?: string;
}

function readingGenerator(env: Env): ReadingGenerator | undefined {
  const endpoint = env.AI_ENDPOINT?.trim();
  const apiKey = env.CLOUDFLARE_AI_API_TOKEN?.trim();
  const model = env.AI_MODEL?.trim();
  if (!endpoint && !apiKey && !model) return undefined;
  if (!endpoint || !apiKey || !model) throw new Error("AI_ENDPOINT, CLOUDFLARE_AI_API_TOKEN, and AI_MODEL must be set together");
  return createAiReadingGenerator({ endpoint, apiKey, model });
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
 * SPA, mirroring the Node server's staticResponse behavior.
 */
async function serveAsset(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const direct = await env.ASSETS.fetch(new Request(url.toString(), request));
  const pathname = url.pathname;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = (env.ORIGIN ?? "").replace(/\/$/, "");
    if (!origin) return new Response("ORIGIN is not configured", { status: 500 });

    const database = openD1Database(env.SONGBOOK_DB);
    const server = createConfiguredServer({
      database,
      origin,
      tj: createTjAdapter({
        mirror: createTjSearchMirror(database.sqlite),
        onWarn: (warning) => console.warn(JSON.stringify({ event: "tj_adapter_warning", ...warning }))
      }),
      readingGenerator: readingGenerator(env)
      // assetsRoot intentionally omitted: the Worker serves statics itself.
    });

    const app = new Hono();
    app.route("/", server.app);
    app.all("*", (c) => serveAsset(env, c.req.raw));
    return app.fetch(request, env);
  }
} satisfies ExportedHandler<Env>;
