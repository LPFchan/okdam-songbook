# Product

## Register

product

## Users

Songbook is for a small private karaoke circle using phones inside a karaoke room, often with unstable network and mixed Korean, Japanese, and English text. The primary user needs to find the TJ number, artist, recommended key, and recent singing history in seconds.

## Product Purpose

Songbook keeps the catalog in a Cloudflare D1 database behind one Worker at `okdam.lost.plus`, serving a public PWA for fast read access and an authenticated management surface for trusted editors signed in through `auth.lost.plus`. Success means the list is searchable offline after first sync, safe to edit by allowed users, and deployable without a paid server.

## Brand Personality

Calm, quick, exact. The product should feel like a compact working tool for a noisy room, not like a flashy karaoke machine.

## Anti-references

Avoid nightclub neon, album-art grids, oversized landing-page heroes, decorative dashboards, or admin screens that hide the real work behind empty cards.

## Design Principles

- Put the TJ number and search task first.
- Keep dense information readable on one hand-held screen.
- Treat offline and sync states as first-class product states.
- Make write access server-verified and visibly constrained by role.
- Prefer familiar controls over novelty.

## Accessibility & Inclusion

Target WCAG AA contrast, visible focus, keyboard support, safe-area-aware mobile layout, reduced motion, and mixed Korean/Japanese/Latin system font support.

