# RSH-20261008-001: TJ Serves a Maintenance Page to Workers Requests

Opened: 2026-10-08 11-15-00 KST
Recorded by agent: claude-code

## Symptom

TJ search on `https://okdam.lost.plus` showed "TJ 검색을 불러오지 못했어요."
for every query. The D1 mirror had no TJ fetch recorded after the 2026-09-18
cutover to Cloudflare Workers.

## Cause

TJ (`www.tjmedia.com`, itself behind Cloudflare) answers requests that carry
no browser `User-Agent` with HTTP 200 and a "서비스 점검중입니다" maintenance
page instead of results. A Worker `fetch` sends no browser `User-Agent`; the
old OCI Node container passed TJ's check.

The client hid the server's message because `apiError` returned a plain
object, not an `Error`, so `TjOmnibar` fell back to its generic copy.

## Evidence

Probed with a throwaway Worker (`tj-probe-tmp`, deleted afterwards):

- Default `fetch` from `NRT`/`HKG`: maintenance page, no result rows.
- `placement.region = "aws:ap-northeast-2"` (ran in `ICN`, TJ edge `ICN`):
  still the maintenance page. Not a country block; rejected.
- Browser `User-Agent` alone, default placement (`HKG`, `NRT`): real results
  with result rows.
- The same query from a Korean residential IP with Node's `fetch` returned
  real results and parsed cleanly, so the parser was not at fault.

## Outcome

The adapter sends a browser `User-Agent` on every TJ request, and API errors
are `Error` instances that keep the server's message. If TJ tightens its
filter again, the next step is a request header audit before any proxy.
