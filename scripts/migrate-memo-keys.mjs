#!/usr/bin/env node
/**
 * One-shot migration: move key notation stored in song memos into the
 * structured key_candidates_json column.
 *
 *   node scripts/migrate-memo-keys.mjs <path-to-songbook.sqlite> [--apply]
 *
 * Default is a dry run that prints what would change. --apply writes inside a
 * single transaction and stamps the changed rows with updated_at = now.
 */
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

const KEY_TEXT_PATTERN = /^([여남])(?:키)?\s*([+-]?\d{1,2})?$/;

function parseKeyText(segment) {
  const text = segment.trim();
  const match = text.match(KEY_TEXT_PATTERN);
  const offsetOnly = text.match(/^([+-]\d{1,2})$/);
  if (!match && !offsetOnly) return null;
  const baseMode = match ? (match[1] === "여" ? "female" : "male") : "original";
  const offset = match ? Number(match[2] ?? 0) : Number(offsetOnly?.[1] ?? 0);
  if (!Number.isInteger(offset) || offset < -12 || offset > 12) return null;
  return {
    candidate: {
      id: crypto.randomUUID(),
      baseMode,
      offset,
      label: "추천",
      memo: "",
      isPrimary: true
    },
    matchedText: text
  };
}

export function migrateRow(memo, keyCandidatesJson) {
  const existing = JSON.parse(keyCandidatesJson || "[]");
  if (existing.length > 0) return null;
  if (!memo || !memo.trim()) return null;
  const segments = memo.split(/[\n,/]/);
  const candidates = [];
  const matched = [];
  const kept = [];
  for (const segment of segments) {
    const parsed = parseKeyText(segment);
    if (parsed) {
      candidates.push(parsed.candidate);
      matched.push(parsed.matchedText);
    } else {
      kept.push(segment);
    }
  }
  if (!candidates.length) return null;
  candidates.forEach((candidate, index) => {
    candidate.isPrimary = index === 0;
  });
  return { candidates, matched, memo: kept.join("\n").trim() };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbPath = args.find((arg) => !arg.startsWith("--"));
  if (!dbPath) {
    console.error("usage: node scripts/migrate-memo-keys.mjs <db-path> [--apply]");
    process.exit(1);
  }
  const db = new Database(dbPath, apply ? undefined : { readonly: true });
  const rows = db
    .prepare("SELECT id, title, memo, key_candidates_json, version FROM songs WHERE deleted_at IS NULL")
    .all();
  const changes = [];
  for (const row of rows) {
    const result = migrateRow(row.memo, row.key_candidates_json);
    if (result) changes.push({ row, result });
  }
  if (!changes.length) {
    console.log("no memo key text found; nothing to migrate");
    return;
  }
  for (const { row, result } of changes) {
    console.log(`[${row.title}]`);
    console.log(`  keys: ${result.matched.join(", ")} -> ${JSON.stringify(result.candidates)}`);
    console.log(`  memo: ${JSON.stringify(row.memo)} -> ${JSON.stringify(result.memo)}`);
  }
  console.log(`${changes.length} song(s) ${apply ? "migrated" : "would be migrated"}`);
  if (!apply) return;
  const now = new Date().toISOString();
  const update = db.prepare(
    "UPDATE songs SET key_candidates_json = ?, memo = ?, updated_at = ? WHERE id = ?"
  );
  db.transaction(() => {
    for (const { row, result } of changes) {
      update.run(JSON.stringify(result.candidates), result.memo, now, row.id);
    }
  })();
  console.log(`applied at ${now}`);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) main();
