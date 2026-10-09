#!/usr/bin/env node
// Suggest DAM numbers for saved songs that do not have one yet.
//
//   node scripts/dam-match.mjs [catalog-url-or-file] > dam-matches.json
//
// Reads the public catalog (default: production), searches DAM for every
// non-Korean song without a DAM number, and prints one suggestion per song for
// a human to review. It never writes to the catalog; apply reviewed numbers
// through the app, the API, or the MCP update_song tool.
//
// Requires `npm run build -w @songbook/shared` first.
import { readFile } from "node:fs/promises";
import { buildDamKeywordRequest, parseDamKeywordResponse } from "../packages/shared/dist/index.js";

const source = process.argv[2] ?? "https://okdam.lost.plus/api/catalog";
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function loadSongs() {
  const text = /^https?:/u.test(source) ? await (await fetch(source)).text() : await readFile(source, "utf8");
  const json = JSON.parse(text);
  return json.data?.songs ?? json.songs ?? json;
}

/** Compare titles the way people read them: ignore case, width, spacing, punctuation and DAM's "(…version)" suffixes. */
function canonical(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[(（【\[「][^)）】\]」]*[)）】\]」]/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

async function search(query) {
  const request = buildDamKeywordRequest({ query, page: 1, pageSize: 20 });
  const response = await fetch(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: request.body
  });
  if (!response.ok) throw new Error(`DAM HTTP ${response.status}`);
  return parseDamKeywordResponse(await response.json()).candidates;
}

function pick(song, candidates) {
  const title = canonical(song.title);
  const artist = canonical(song.artist);
  const titleHits = candidates.filter((candidate) => canonical(candidate.title) === title);
  const artistHit = (candidate) => {
    const other = canonical(candidate.artist);
    return Boolean(artist && other && (other.includes(artist) || artist.includes(other)));
  };
  // Prefer the plain song over "[生音]", "[プロオケ]" and "(… ver.)" variants.
  const variant = (candidate) => Number(/[(（\[【「]/u.test(candidate.title));
  const plainFirst = (list) => [...list].sort((a, b) => variant(a) - variant(b));
  const exact = plainFirst(titleHits.filter(artistHit));
  if (exact.length) return { confidence: "exact", match: exact[0] };
  if (titleHits.length) return { confidence: "title-only", match: plainFirst(titleHits)[0] };
  const artistOnly = candidates.filter(artistHit);
  if (artistOnly.length) return { confidence: "artist-only", match: artistOnly[0] };
  return { confidence: "none", match: null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const songs = (await loadSongs()).filter((song) => !song.damNumber && song.country !== "한국");
const results = [];
for (const song of songs) {
  // Saved titles often carry notes like "(… OP)" or "(Feat. …)" that DAM does not.
  const bare = (value) => value.replace(/[(（][^)）]*[)）]/gu, "").trim();
  const queries = [...new Set([`${song.title} ${song.artist}`, `${bare(song.title)} ${bare(song.artist)}`, bare(song.title)])];
  const rank = { exact: 0, "title-only": 1, "artist-only": 2, none: 3 };
  let best = { confidence: "none", match: null, candidates: [] };
  for (const query of queries) {
    const candidates = await search(query);
    await sleep(700);
    const picked = pick(song, candidates);
    if (rank[picked.confidence] < rank[best.confidence] || !best.candidates.length) best = { ...picked, candidates };
    if (picked.confidence === "exact") break;
  }
  const { confidence, match, candidates } = best;
  results.push({
    songId: song.id,
    version: song.version,
    title: song.title,
    artist: song.artist,
    tjNumber: song.tjNumber,
    confidence,
    match: match && { damNumber: match.damNumber, title: match.title, artist: match.artist },
    alternatives: candidates.slice(0, 3).map((candidate) => `${candidate.damNumber} ${candidate.title} / ${candidate.artist}`)
  });
  process.stderr.write(`${confidence.padEnd(11)} ${song.title} / ${song.artist}${match ? ` → ${match.damNumber} ${match.title}` : ""}\n`);
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
