#!/usr/bin/env node
// Fill tj_mirror_songs for saved songs TJ search has never returned.
//
//   npx wrangler d1 execute okdam-songbook --remote --json --command \
//     "SELECT DISTINCT tj_number FROM songs WHERE tj_number<>'' AND tj_number NOT IN (SELECT tj_number FROM tj_mirror_songs)" \
//     > missing.json   (run from apps/worker)
//   node scripts/tj-credits-backfill.mjs missing.json > backfill.sql
//   npx wrangler d1 execute okdam-songbook --remote --file backfill.sql
//
// Saved songs keep only their TJ number; composer and lyricist live in the
// mirror, which grows only from searches. Recommendations rank composers and
// lyricists from it, so songs imported before the mirror existed need one
// number lookup each. Inserts never overwrite rows the mirror already has.
//
// Requires `npm run build -w @songbook/shared` first.
import { readFile } from "node:fs/promises";
import { buildTjSearchUrl, parseTjSearchHtml } from "../packages/shared/dist/index.js";

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const json = JSON.parse(await readFile(process.argv[2], "utf8"));
const numbers = (json[0]?.results ?? json).map((row) => String(row.tj_number ?? row));
const now = new Date().toISOString();
const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;

for (const tjNumber of numbers) {
  const url = buildTjSearchUrl({ query: tjNumber, searchType: "number", nation: "", page: 1, pageSize: 15 });
  try {
    const response = await fetch(url, { headers: { "User-Agent": userAgent } });
    if (!response.ok) throw new Error(`TJ HTTP ${response.status}`);
    const found = parseTjSearchHtml(await response.text(), url).find((candidate) => candidate.tjNumber === tjNumber);
    if (!found) {
      console.error(`${tjNumber}: not on TJ`);
    } else {
      console.log(`INSERT OR IGNORE INTO tj_mirror_songs (tj_number,title,artist,lyricist,composer,first_seen_at,last_seen_at) VALUES (${[found.tjNumber, found.title, found.artist, found.lyricist, found.composer, now, now].map(quote).join(",")});`);
    }
  } catch (error) {
    console.error(`${tjNumber}: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}
