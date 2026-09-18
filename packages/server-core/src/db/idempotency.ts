import type { SqlExecutor } from "./sql.js";
import type { IdempotencyKeyRow } from "./schema.js";

export interface IdempotencyRepository {
  get(key: string): Promise<IdempotencyKeyRow | null>;
  reserve(input: IdempotencyClaimInput): Promise<IdempotencyClaim>;
  put(input: Omit<IdempotencyKeyRow, "responseJson"> & { responseJson?: string | null }): Promise<void>;
  complete(key: string, responseJson: string): Promise<void>;
  prune(now: string): Promise<number>;
}

export interface IdempotencyClaimInput {
  key: string;
  actorSubject: string;
  operation: string;
  requestHash: string;
  createdAt: string;
  expiresAt: string;
}

export type IdempotencyClaim =
  | { kind: "new"; record: IdempotencyKeyRow }
  | { kind: "replay"; record: IdempotencyKeyRow };

export class IdempotencyMismatchError extends Error {
  readonly code = "IDEMPOTENCY_MISMATCH" as const;
  readonly existing: IdempotencyKeyRow;

  constructor(existing: IdempotencyKeyRow) {
    super("Idempotency key was already used for a different request.");
    this.name = "IdempotencyMismatchError";
    this.existing = existing;
  }
}

function mapRow(row: Record<string, unknown>): IdempotencyKeyRow {
  return { key: String(row.key), actorSubject: String(row.actor_subject ?? ""), operation: String(row.operation), requestHash: String(row.request_hash), responseJson: row.response_json === null ? null : String(row.response_json), createdAt: String(row.created_at), expiresAt: String(row.expires_at) } as IdempotencyKeyRow;
}

function matches(record: IdempotencyKeyRow, input: IdempotencyClaimInput): boolean {
  return record.actorSubject === input.actorSubject && record.operation === input.operation && record.requestHash === input.requestHash;
}

export function createIdempotencyRepository(sqlite: SqlExecutor): IdempotencyRepository {
  const rowForKey = async (key: string): Promise<IdempotencyKeyRow | null> => {
    const row = await sqlite.prepare("SELECT * FROM idempotency_keys WHERE key=?").get<Record<string, unknown>>(key);
    return row ? mapRow(row) : null;
  };
  return {
    get: rowForKey,
    /**
     * Reserve the key. INSERT OR IGNORE against the primary key is the arbiter:
     * two racing requests cannot both insert, so whoever reports one changed
     * row owns the claim and the other is a replay.
     */
    reserve: async (input) => sqlite.transaction(async () => {
      await sqlite.prepare("DELETE FROM idempotency_keys WHERE key=? AND expires_at<=?").run(input.key, input.createdAt);
      const claimed = await sqlite.prepare("INSERT OR IGNORE INTO idempotency_keys (key,actor_subject,operation,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,NULL,?,?)").run(input.key, input.actorSubject, input.operation, input.requestHash, input.createdAt, input.expiresAt);
      if (claimed.changes === 1) return { kind: "new", record: (await rowForKey(input.key))! };
      const existing = await rowForKey(input.key);
      if (!existing) throw new Error("Idempotency claim disappeared during reservation.");
      if (!matches(existing, input)) throw new IdempotencyMismatchError(existing);
      return { kind: "replay", record: existing };
    }),
    put: async (input) => { await sqlite.prepare("INSERT INTO idempotency_keys (key,actor_subject,operation,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").run(input.key, input.actorSubject, input.operation, input.requestHash, input.responseJson ?? null, input.createdAt, input.expiresAt); },
    complete: async (key, responseJson) => { await sqlite.prepare("UPDATE idempotency_keys SET response_json=? WHERE key=?").run(responseJson, key); },
    prune: async (now) => (await sqlite.prepare("DELETE FROM idempotency_keys WHERE expires_at<=?").run(now)).changes
  };
}
