# RSH-20260813-001: Songbook Refactor Options

Opened: 2026-08-13 03-55-01 KST
Recorded by agent: codex-orchestrator

## Question

How should Songbook add TJ-assisted discovery and entry, improve login continuity, adopt or reject Better Auth, simplify filtering, and consolidate Settings without treating unresolved architecture choices as current truth?

## Current State Corrections

- Saved-song search is local. The web app has no TJ lookup, TJ result type, or external-search UI.
- The add form accepts a TJ number, title, and artist manually. It has no exact-number autofill or row-level one-click add.
- The Google ID credential is held in memory. `sessionStorage` remembers only email and display name for the current tab; on restoration, the app reports `reauthRequired`, not `authenticated`.
- Better Auth is not installed or approved. The existing Cloudflare Worker serves the separate ChatGPT Action OAuth flow, not browser sessions.
- Filter chips partly exist: selected filters are removable chips on the main page, and performer choices are toggle chips in the filter sheet. Country and genre still use selects; has-key, favorite, and practicing use checkboxes.
- There is no Settings route. `/admin` has a `settings` query tab labeled `고급 설정`; its CSV import/export and JSON backup buttons have no handlers. Theme is already on the main page.

## Seven Requested Outcomes

### 1. Live TJ Website Search Query

**Current behavior:** Songbook searches only stored songs through `packages/shared/src/search.ts`. TJ's inspected public form submits a GET to `/song/accompaniment_search` and returns server-rendered HTML. The response did not allow the GitHub Pages origin through CORS and cannot be embedded because of frame restrictions.

**Proposed direction:** After an automated-use decision and a deployed spike, add an authenticated server-side TJ adapter. Apps Script is the recommended first host because it already owns the web API boundary, has `UrlFetchApp`, and can apply the current allowlist and permissions. Return bounded normalized JSON; never return raw TJ HTML to the browser.

**Constraints:** Use a fixed TJ host and path, explicit submit or conservative debounce, query/page limits, short caching, throttling, structured upstream/parser errors, and a manual/TJ-link fallback. The GitHub Pages client must not fetch or iframe TJ directly.

**Gate:** No documented public search API or explicit reuse permission was found. TJ markup, access behavior, and query parameters may change. Run a live Apps Script spike against exact number, broad Unicode search, and no-result cases before accepting the adapter.

### 2. One-Click Add From a TJ Search Result

**Current behavior:** `upsertSong` already performs authenticated, audited writes with `clientRequestId` replay safety and exact TJ-number duplicate protection. There is no external result row or one-click control, and title-plus-artist duplicate handling is not part of the generic add flow.

**Proposed direction:** Add only from a server-normalized TJ candidate and reuse the existing `upsertSong` authority. Preserve one request ID across retries, disable a pending row, refresh local song state after success, store `sourceType: "tjmedia"` plus a bounded source reference, and offer immediate editing for Songbook-only metadata.

**Defaults:** Use `active` status, no guessed country, and no implicit performers. Exact TJ number blocks creation; normalized title-plus-artist warns and opens the existing song. Never overwrite or merge automatically.

**Gate:** Confirm whether “one click” means immediate publication, consistent with DEC-20260701-007, or candidate fill followed by Save. Also choose behavior for a match to a deleted song.

### 3. Autofill Title and Artist From a TJ Karaoke Number

**Current behavior:** The TJ number input is plain text. Title and artist remain required manual fields.

**Proposed direction:** Make exact-number lookup the first TJ user workflow. A small shared candidate contract should carry number, title, artist, optional lyricist/composer, and source URL. One authenticated Apps Script action should use TJ's exact-number query, parse one row, and fill number/title/artist without saving.

**Defaults:** Preserve external Unicode text, keep the candidate editable, do not infer country from query context, and do not silently replace non-empty draft fields. Not-found, multiple, blocked, timed-out, and markup-changed responses need distinct outcomes.

**Dependency:** This uses the same parser and normalized contract as broad search and must land before one-click add.

### 4. Login State Persistence

**Current behavior:** One app-wide `AuthProvider` shares live auth between routes. Its Google ID token is memory-only. Only display identity is stored in `sessionStorage`, so it survives reload in the same tab but normally not tab/browser closure; it never authorizes a write. Missing or expired credentials invoke GIS or require explicit login.

**Proposed direction:** First define the promise: reload restoration, browser-restart restoration, a fixed multi-day session, or independence from the Google browser session. Keep tokens out of `localStorage`, IndexedDB, URLs, logs, and service-worker caches.

**Recommended default:** If best-effort return while Google is still signed in is enough, restore by asking GIS for a fresh credential at startup, validate it through the existing server check, preserve an explicit fallback button, and suppress auto-selection after logout. This remains best effort under FedCM/browser prompt rules.

**Dependency:** The account surface should consume an auth-provider interface after the architecture gate rather than rendering Google-specific internals directly.

### 5. Better Auth

**Current behavior:** The static PWA sends short-lived Google ID tokens directly to Apps Script for protected web actions. There is no Songbook user/account/session store. The ChatGPT OAuth Worker is separate and has process-memory replay tracking that is not a browser-session database.

**Feasibility:** Better Auth is viable on a Cloudflare Worker. A durable design would use its server handler, a dedicated Google OAuth client, D1 for users/accounts/sessions, secure HTTP-only cookies, exact trusted origins, and a protected Worker-to-Apps-Script gateway. Apps Script should keep deriving current roles from `ALLOWED_USERS_JSON` during an initial migration.

**Cost:** This adds an auth server, database migrations, secrets, cookie/CORS/CSRF policy, session expiry and revocation, Worker availability, browser/PWA cache rules, monitoring, and rollback. A `github.io` frontend calling `workers.dev` is cross-site and carries Safari cookie risk; same-site custom hostnames are the recommended production posture.

**Conclusion:** Better Auth is a viable option, not approved architecture. Choose it only if Songbook needs an owned, revocable, multi-day session. Keep the current GIS path as rollback during rollout and leave ChatGPT OAuth unchanged in the first web-auth migration.

### 6. Filters With Chips

**Current behavior:** Main-page active filters and performer controls already use chips. The sheet exposes single-value country/genre selects, multi-select performer OR matching, and independent has-key/favorite/practicing checkboxes. Filters reset on reload, while query and sort persist.

**Proposed direction:** Use a one-line horizontally scrollable quick-filter row plus a complete responsive sheet/modal of labeled chip groups. Keep sort separate. Country and genre remain zero-or-one selections; performers preserve OR matching; booleans remain independently combinable.

**Recommended default:** Quick chips are the three performers, favorite, and practicing; country, genre, and has-key stay in the full sheet. Do not persist filters until users confirm that expectation. Dynamic vocabularies need a threshold for falling back to searchable/select presentation.

**Accessibility:** Use semantic buttons with `aria-pressed`, named groups, at least 44-pixel touch targets, keyboard operation, focus restoration/containment, readable selected states, and bounded mobile/desktop layouts.

### 7. Remove Settings and Absorb Controls Into the Main Page

**Current behavior:** The only Settings-like surface is the no-op `고급 설정` tab under `/admin`. Theme, online/last-sync status, auth summary, search, filters, and sort already appear on the public main page. Login/logout remain in admin. Physics mode is a temporary hidden gesture, not a persisted preference.

**Proposed direction:** Remove the no-op tab. Keep high-frequency catalog controls visible; place account, login/re-login/logout, explicit theme choice, and sync details in a contextual main-page account/overflow sheet. Do not move placeholder CSV/backup/diagnostic controls as dead buttons. Future permission-sensitive operations belong in an authenticated owner operations surface with real handlers and recovery rules.

**Gate:** The narrow removal above preserves DEC-20260701-003. A full merger of add/manage/history into the main page would supersede that public/admin separation and needs a new decision, role-aware navigation, deep-link behavior, and unsaved-form handling.

## Cross-Cutting Boundaries

- The Sheet remains song/performance truth. External TJ rows are editable candidates until an authenticated write succeeds.
- Apps Script remains the final write-permission authority unless a later decision deliberately replaces that boundary.
- Exact TJ uniqueness and idempotency are server-authoritative; browser duplicate checks are advisory.
- TJ outage or parser drift must never break saved-song browsing or manual add.
- Auth UI depends on neutral session capabilities; it must not lock the page structure to GIS or Better Auth before the gate.
- Filter and account work both affect the public header. Shared primitives should land before parallel page composition, or one layout owner should serialize the final integration.
- `BottomSheet` currently reuses a dialog heading ID and lacks a focus trap; additional dialogs should include an accessibility hardening pass.

## Open Decisions

1. Accept low-volume parsing of TJ public HTML, seek permission/official access, or stop; then verify whether deployed Apps Script can fetch it reliably.
2. Choose immediate publication or review-before-save for a TJ result; choose deleted-row and title-plus-artist duplicate behavior.
3. Define the login persistence promise, then choose improved GIS or Better Auth.
4. If Better Auth is chosen, approve Worker + D1, same-site domains, session policy, dedicated OAuth client, allowlist authority, and rollback.
5. Confirm the default quick chips and whether filters should persist.
6. Remove only the no-op Settings tab, or deliberately supersede the public/admin separation with a full merger.
7. Decide whether CSV import/export, backup, diagnostics, cache reset, and physics mode remain future work, move elsewhere, or are removed.

## Primary Sources

- [TJ accompaniment search](https://www.tjmedia.com/song/accompaniment)
- [Observed TJ exact-number result](https://www.tjmedia.com/song/accompaniment_search?nationType=&strType=16&searchTxt=68058&strWord=Y)
- [TJ robots.txt](https://www.tjmedia.com/robots.txt)
- [Apps Script UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Google ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Google automatic sign-in and sign-out](https://developers.google.com/identity/gsi/web/guides/automatic-sign-in-sign-out)
- [Google FedCM migration](https://developers.google.com/identity/gsi/web/guides/fedcm-migration)
- [Better Auth installation](https://better-auth.com/docs/installation)
- [Better Auth session management](https://better-auth.com/docs/concepts/session-management)
- [Better Auth database model](https://better-auth.com/docs/concepts/database)
- [Better Auth Hono integration](https://better-auth.com/docs/integrations/hono)
- [Better Auth cookie guidance](https://better-auth.com/docs/concepts/cookies)

## Repo Evidence

- TJ destination schema and search/filter semantics: `packages/shared/src/schemas.ts`, `packages/shared/src/search.ts`.
- Existing write, duplicate, permission, and external-fetch boundaries: `apps-script/src/Code.js`, `apps/web/src/lib/api.ts`.
- Current add form and no-op Settings tab: `apps/web/src/routes/AdminPage.tsx`.
- Current filter, theme, status, and auth-summary UI: `apps/web/src/routes/PublicPage.tsx`, `apps/web/src/hooks/useTheme.ts`.
- Current auth storage and transitions: `apps/web/src/lib/auth/AuthContext.tsx`, `apps/web/src/test/AuthContext.test.tsx`.
- Existing architecture boundaries: DEC-20260701-001, DEC-20260701-003, DEC-20260701-004, DEC-20260701-006, DEC-20260701-007.
