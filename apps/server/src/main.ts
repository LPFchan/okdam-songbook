import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createTjAdapter, createTjSearchMirror } from "@songbook/server-core";
import { normalizeEmail } from "@songbook/shared";
import { z } from "zod";
import { createConfiguredServer } from "./api.js";
import { createAiReadingGenerator, type ReadingGenerator } from "./reading.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function port(): number {
  const value = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("PORT must be an integer between 0 and 65535");
  return value;
}

const allowedUsersSchema = z.record(z.string(), z.string().trim().min(1).max(80));

export function parseAllowedUsers(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) throw new Error("ALLOWED_USERS_JSON is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("ALLOWED_USERS_JSON must be valid JSON"); }
  const result = allowedUsersSchema.safeParse(parsed);
  const entries = result.success ? Object.entries(result.data) : [];
  if (!result.success || entries.length === 0 || entries.some(([email]) => !z.string().trim().email().safeParse(email).success)) {
    throw new Error("ALLOWED_USERS_JSON must be a non-empty JSON object mapping valid email addresses to display names");
  }
  const normalized = entries.map(([email, displayName]) => [normalizeEmail(email), displayName] as const);
  if (new Set(normalized.map(([email]) => email)).size !== normalized.length) throw new Error("ALLOWED_USERS_JSON must not contain duplicate email addresses");
  return Object.fromEntries(normalized);
}

export function readingGeneratorFromEnvironment(environment: NodeJS.ProcessEnv): ReadingGenerator | undefined {
  const endpoint = environment.AI_ENDPOINT?.trim();
  const apiKey = environment.AI_API_KEY?.trim();
  const model = environment.AI_MODEL?.trim();
  if (!endpoint && !apiKey && !model) return undefined;
  if (!endpoint || !apiKey || !model) throw new Error("AI_ENDPOINT, AI_API_KEY, and AI_MODEL must be set together");
  return createAiReadingGenerator({ endpoint, apiKey, model });
}

export async function startFromEnvironment() {
  const origin = required("ORIGIN").replace(/\/$/, "");
  const secret = required("BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  const dbPath = resolve(process.env.DATABASE_PATH?.trim() || "/var/lib/songbook/songbook.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const users = parseAllowedUsers(process.env.ALLOWED_USERS_JSON);
  const database = (await import("@songbook/server-core")).openDatabase({ filename: dbPath });
  const server = await createConfiguredServer({
    database,
    origin,
    tj: createTjAdapter({
      mirror: createTjSearchMirror(database.sqlite),
      onWarn: (warning) => console.warn(JSON.stringify({ event: "tj_adapter_warning", ...warning }))
    }),
    readingGenerator: readingGeneratorFromEnvironment(process.env),
    assetsRoot: process.env.ASSETS_ROOT?.trim() || resolve(process.cwd(), "apps/web/dist"),
    auth: {
      database,
      origin,
      secret,
      allowedUsers: users,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      production: process.env.NODE_ENV === "production"
    }
  });
  const listener = serve({ fetch: server.app.fetch, hostname: process.env.HOST?.trim() || "0.0.0.0", port: port() }, (info) => {
    console.log(`songbook listening on http://${info.address}:${info.port}`);
  });
  const shutdown = () => {
    listener.close();
    database.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { ...server, listener, shutdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startFromEnvironment().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
