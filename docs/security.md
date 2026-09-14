# Security

## Trust boundaries

- Public catalog reads do not require login. `robots.txt`, `noindex`, and
  unlisted URLs reduce discovery only; they are not authentication.
- `auth.lost.plus` is the identity, session, revocation, and service-admission
  authority. The Common Auth gateway validates every protected request and
  removes browser-supplied identity fields before forwarding.
- The OCI server remains the authorization authority for Songbook actions.
  Every admitted identity receives the existing `allowed` role.
- The retired GitHub Pages, Apps Script, and ChatGPT Action sources retain their
  historical boundaries but are not part of the live OCI path.

## Shared browser sessions

- Browsers authenticate with the HTTP-only `lp_auth` cookie scoped to
  `.lost.plus`. Login redirects to
  `https://auth.lost.plus/login?to=<current-songbook-url>` and returns to the
  original Songbook path after authentication.
- The gateway asks auth.lost.plus to admit the `okdam` audience. Auth checks
  the account visibility list for browser sessions and machine tokens, then
  the gateway strips the credential before forwarding verified identity
  headers to Songbook.
- Rejected, revoked, expired, malformed, or unavailable validation fails closed
  at the gateway.
- Browser API routes reject bearer credentials. Mutations also require JSON and
  the exact configured `ORIGIN`.
- `GET /_auth/logout` is owned by the gateway and redirects through the shared
  logout endpoint.

## MCP bearer authentication

- MCP public catalog/search/lookup calls may be anonymous. Protected MCP tools
  require a bearer token minted at `auth.lost.plus`; browser cookies alone never
  grant MCP identity.
- A request without gateway identity is anonymous. Any explicit machine
  credential is authenticated input and cannot downgrade to anonymous when
  Common Auth rejects it.
- Every admitted shared token receives Songbook's `songbook:read` and
  `songbook:write` capabilities because Songbook has one equal-permission role.
  Token minting, lifetime, scope, and revocation remain owned by
  `auth.lost.plus`; Songbook MCP uses the `okdam-mcp` token scope.
- Anonymous MCP routing is derived from the JSON-RPC body. It explicitly admits
  discovery, listings, notifications, ping, and public tool calls while
  rejecting unknown methods, malformed bodies, ambiguous calls, and batches.

## Stored identity data

- Private favorites and idempotency ownership use the immutable, namespaced
  Common Auth subject (`auth.lost.plus:<sub>`), not email.
- Domain rows and audit events retain the email and public-name snapshot that
  was current when a write happened. These fields are historical attribution,
  never live ownership or authorization keys.
- Public song data never exposes email. The latest singer name comes from the
  public-name snapshot stored on the performance when it was created.
- Migration `0107_immutable_account_ownership` converts older favorite owners
  to explicit `legacy-email:<normalized-email>` placeholders. Deployment maps
  those placeholders to Auth subjects while both databases are backed up and
  offline; runtime requests never claim legacy data merely by presenting the
  old address.

## TJ boundary

- The browser never fetches or embeds TJ directly.
- The server fetches only the fixed TJ host/path, with bounded query/page size,
  persistent query snapshots, and throttling.
- Only normalized candidates cross the server boundary. Candidates remain
  editable and cannot overwrite an existing song.
- Upstream outage or parser drift leaves saved-song browsing and manual add
  usable.

## Secrets

The frontend never bundles:

- account emails or service membership
- `lp_auth` cookie values or shared bearer tokens
- Apps Script internal proxy secrets
- Sheet IDs as an authorization mechanism
- AI, YouTube, or other provider keys

Secrets belong in the operator's credential store and host-only runtime files.
Values must never be committed.

## AI and images

The live OCI server calls the configured AI reading endpoint with a server-only
bearer credential. The browser route requires an admitted same-origin session,
input and output are bounded and schema-validated, and provider error bodies are
not returned to the browser. AI output remains an editable candidate and is
never saved automatically. Images are not stored in GitHub or SQLite by default.
