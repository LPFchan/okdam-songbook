# gateway-echo

A backend that answers **what it received**, for probing the Common Auth
gateway. It lives here because Songbook's Workers cutover is gated on a staging
pass that needs one; it is offered to `LPFchan/auth` to sit beside the gateway,
since every future probe of that gateway wants it and none of them should have
to find it in a songbook repo.

Not deployed. Route-less by config (`workers_dev = false`, no routes), so it is
reachable only through a gateway service binding — which is the point. What it
reports has to be what the *gateway* forwards, not what a direct caller sent.

## Why it exists

Three kinds of observation, in increasing order of what they prove:

1. **A status code.** Can be right for the wrong reason.
2. **`curl -w '%{size_upload} %{http_version}'`.** The instrument reporting on
   itself. Catches "curl did not send it"; blind to anything the path alters.
3. **An echo from the far side.** The only one that answers what arrived.

The second looks like the third and is not. A probe of a WebSocket route
elsewhere on the fleet reported `200` and a clean `upload=5B` while curl's
HTTP/2 negotiation had silently dropped the `Upgrade` header the probe existed
to test — a perfect reading of the wrong request, with no contradiction visible
anywhere in it. Only a backend echoing `upgrade: null` caught it.

## What it reports

- `method`, `path`, `query` — `query` stays a string, because parsing it would
  silently collapse repeated keys
- `httpProtocol` from `request.cf`, so the protocol is observed server-side
  rather than taken from the client that may have changed it
- `bodyPresent` (`request.body !== null`) separately from `bodyBytes`. The
  gateway's GET-with-body 502 is thrown by *constructing* a request with a body
  on a GET, so whether the stream is attached is the question, and it sits
  upstream of whether it has bytes
- `identity` — every `x-lost-plus-*` header, raw **and** `decodeURIComponent`'d,
  so a non-ASCII display name either round-trips visibly or does not
- `forwarded` — `x-forwarded-*`, `host`, `upgrade`
- `credentialLeak` — `authorization`, `x-api-key`, `cookie`, if any arrive
- `headers` — every pair verbatim in arrival order, because a count says
  something changed and never what

Duplicates are not preserved and cannot be: the Headers API joins repeated
request headers into one comma-separated value before any Worker sees them.
What is recorded is what arrived after that normalization, which is also what
an application would act on.

## The check that matters beyond this cutover

`credentialLeak` is not a probe anyone requested. `gateway/src/requestRewrite.ts`
strips `authorization`, `x-api-key` and `cookie` before forwarding, and that
stripping is the whole property `DEC-20260918-002` chose a gateway for over a
shared auth library: an application never sees a raw credential. Songbook,
coverse and awa all inherit their safety from it, and it has only ever been
asserted by reading the source — never observed from the far side.

If it ever returns non-empty, that decision is wrong, and so is every service
behind the gateway.
