import { betterAuth } from "better-auth";
import type { Env } from "./index";

const DEFAULT_SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 14;
const DEFAULT_SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

function csvOrigins(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function seconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Better Auth is created per request because Cloudflare bindings are only
 * available inside the request handler. No D1 handle or secret is captured at
 * module evaluation time.
 */
export function createBrowserAuth(env: Env) {
  if (!env.AUTH_DB) throw new Error("AUTH_DB binding is required for Better Auth");
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is required for Better Auth");
  if (!env.BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is required for Better Auth");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Better Auth");
  }

  const allowed = new Set([
    env.MARIE_EMAIL,
    env.SEONGWOOK_EMAIL,
    env.YEOWOOL_EMAIL
  ].map((email) => String(email || "").trim().toLowerCase()).filter(Boolean));

  return betterAuth({
    database: env.AUTH_DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: csvOrigins(env.AUTH_TRUSTED_ORIGINS),
    defaultCookieAttributes: {
      // GitHub Pages and the Worker are separate origins. The production
      // deployment must therefore use credentialed cross-site cookies.
      sameSite: "none",
      secure: true,
      httpOnly: true
    },
    session: {
      expiresIn: seconds(env.AUTH_SESSION_EXPIRES_IN_SECONDS, DEFAULT_SESSION_EXPIRES_IN_SECONDS),
      updateAge: seconds(env.AUTH_SESSION_UPDATE_AGE_SECONDS, DEFAULT_SESSION_UPDATE_AGE_SECONDS)
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        disableSignUp: false
      }
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => allowed.has(String(user.email || "").trim().toLowerCase()) || false
        }
      }
    }
  });
}

export type BrowserAuth = ReturnType<typeof createBrowserAuth>;
