# Security

## Trust boundaries

- The GitHub Pages app is public. `robots.txt`, `noindex`, and unlisted URLs
  reduce discovery only; they are not authentication.
- Public catalog reads do not require login.
- Apps Script remains the final allowlist and role authority for Sheet writes.
- The Better Auth Worker authenticates the browser session and derives an
  actor, but it does not accept a browser-supplied role or email as authority.
- ChatGPT Action OAuth is a separate Worker protocol and keeps its own redirect
  allowlist and bearer-token contract.

## Better Auth browser sessions

- Better Auth stores users, accounts, and sessions in D1.
- Sessions use renewable 14-day HTTP-only cookies. The browser never stores a
  Google ID token or session bearer in `localStorage`, IndexedDB, URLs, logs,
  or service-worker caches.
- Better Auth is mounted only under `/api/auth/*`. Current-user and protected
  browser writes use credentialed requests to the Worker.
- `AUTH_TRUSTED_ORIGINS` is an exact origin list. Production must verify the
  final Pages/custom-domain and Worker origin posture before enabling cookies.
- CORS allows credentials only for an exact configured origin. Untrusted
  origins receive no allow-origin header.
- The Worker forwards a Worker-generated request id, internal secret, and
  session-derived actor metadata to Apps Script. Apps Script independently
  resolves the email and role from `ALLOWED_USERS_JSON`.
- `BETTER_AUTH_ENABLED=false` is the safe default until D1, OAuth, origin,
  migration, and browser smoke checks pass.

## GIS rollback

The legacy GIS direct-token transport remains available during migration. Apps
Script verifies Google ID tokens by audience, issuer, expiration, and
`email_verified`, then resolves the verified email against its allowlist. The
frontend does not decide write authorization.

## TJ boundary

- The browser never fetches or embeds TJ directly.
- Apps Script fetches only the fixed TJ host/path, with bounded query/page size,
  short caching, and a global throttle.
- Only normalized candidates cross the Apps Script boundary. Raw HTML is not
  returned to the browser.
- Candidates are editable, carry source provenance, and cannot overwrite an
  existing song. Duplicate and deleted-row outcomes are server-authoritative.
- Upstream outage or parser drift leaves saved-song browsing and manual add
  usable.

## Apps Script and secrets

The frontend never bundles:

- allowed emails or roles
- Google OAuth client secrets
- Better Auth secret or D1 identifiers
- Apps Script internal proxy secret
- Sheet ID as an authorization mechanism
- AI, YouTube, or other provider keys

Secrets belong in Cloudflare secrets, GitHub Actions secrets/variables where
appropriate, and Apps Script Script Properties. Values must never be committed.

## AI and images

AI providers are called only from Apps Script. AI output is an editable
candidate and must pass schema validation before save. Images are not stored in
GitHub or Sheets by default.
