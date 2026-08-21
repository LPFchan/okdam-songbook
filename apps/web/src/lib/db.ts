import Dexie, { type Table } from "dexie";
import type { PublicData } from "@songbook/shared";

export interface CachedSnapshot {
  id: "public";
  data: PublicData;
  savedAt: string;
}

export interface OfflineQueueItem {
  id: string;
  action: "performance:create" | "performance:cancel";
  songId: string;
  /** Email of the user who queued the write. "legacy" marks rows that predate owner stamping. */
  ownerEmail: string;
  /** The id sent to the server. It must survive an offline replay. */
  clientRequestId: string;
  performanceId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: "pending" | "in_flight" | "failed" | "dead-letter";
  attemptCount: number;
  nextRetryAt?: string;
  errorClassification?: "network" | "server" | "auth" | "validation" | "not_found" | "conflict" | "unknown";
  errorMessage?: string;
}

class SongbookDatabase extends Dexie {
  snapshots!: Table<CachedSnapshot, string>;
  queue!: Table<OfflineQueueItem, string>;

  constructor() {
    super("songbook");
    this.version(1).stores({
      snapshots: "id,savedAt",
      queue: "id,status,createdAt"
    });
    this.version(2).stores({
      snapshots: "id,savedAt",
      queue: "id,status,createdAt,nextRetryAt,clientRequestId"
    }).upgrade((transaction) => {
      return transaction.table("queue").toCollection().modify((item: Partial<OfflineQueueItem>) => {
        // v1 used the item id as the create request id. Cancellation rows did
        // not persist one, so the old row id is the safest replay identity.
        item.clientRequestId = typeof item.clientRequestId === "string"
          ? item.clientRequestId
          : String(item.id);
        item.attemptCount = typeof item.attemptCount === "number" ? item.attemptCount : 0;
        item.status = item.status === "failed" ? "failed" : "pending";
      });
    });
    this.version(3).stores({
      snapshots: "id,savedAt",
      queue: "id,status,createdAt,nextRetryAt,clientRequestId,ownerEmail"
    }).upgrade((transaction) => {
      return transaction.table("queue").toCollection().modify((item: Partial<OfflineQueueItem>) => {
        // Rows from before owner stamping have no recorded author. Mark them
        // legacy so the next signed-in user can flush them once.
        item.ownerEmail = typeof item.ownerEmail === "string" ? item.ownerEmail : "legacy";
      });
    });
  }
}

export const db = new SongbookDatabase();

export async function readCachedPublicData(): Promise<PublicData | null> {
  return (await db.snapshots.get("public"))?.data ?? null;
}

export async function saveCachedPublicData(data: PublicData): Promise<void> {
  await db.snapshots.put({ id: "public", data, savedAt: new Date().toISOString() });
}
