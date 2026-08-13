import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createTjAdapter } from "@songbook/server-core";
import { createConfiguredServer } from "./api.js";

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

function allowedUsers(): Record<string, "owner" | "editor"> {
  const raw = required("ALLOWED_USERS_JSON");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("ALLOWED_USERS_JSON must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) throw new Error("ALLOWED_USERS_JSON must be a non-empty email-to-role object");
  for (const [email, role] of Object.entries(parsed)) {
    if (!email.includes("@") || (role !== "owner" && role !== "editor")) throw new Error("ALLOWED_USERS_JSON entries must map email addresses to owner/editor roles");
  }
  return parsed as Record<string, "owner" | "editor">;
}

export async function startFromEnvironment() {
  const origin = required("ORIGIN").replace(/\/$/, "");
  const secret = required("BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  const dbPath = resolve(process.env.DATABASE_PATH?.trim() || "/var/lib/songbook/songbook.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const users = allowedUsers();
  const database = (await import("@songbook/server-core")).openDatabase({ filename: dbPath });
  const server = await createConfiguredServer({
    database,
    origin,
    tj: createTjAdapter(),
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
