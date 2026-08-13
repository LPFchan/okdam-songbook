import { cancelPerformance, createPerformance, isApiAuthError, type ParsedApiError } from "./api";
import { db, type OfflineQueueItem } from "./db";

const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export type QueueFailureClassification = NonNullable<OfflineQueueItem["errorClassification"]>;

export interface QueueCounts {
  pending: number;
  inFlight: number;
  failed: number;
  deadLetter: number;
  authPaused: boolean;
}

export interface QueueAuth {
  requireValidCredential(): Promise<void>;
}

export interface QueueReplayOptions {
  auth?: QueueAuth;
  now?: () => Date;
  onChange?: () => void;
}

let drainPromise: Promise<QueueCounts> | null = null;
const listeners = new Set<() => void>();
let authPaused = false;

function notify(options?: QueueReplayOptions): void {
  options?.onChange?.();
  for (const listener of listeners) listener();
}

export function subscribeQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function queueRequestId(): string {
  return crypto.randomUUID();
}

export async function enqueuePerformanceCreate(songId: string, clientRequestId = queueRequestId(), performedAt = new Date().toISOString()): Promise<OfflineQueueItem> {
  const item: OfflineQueueItem = {
    id: clientRequestId,
    clientRequestId,
    action: "performance:create",
    songId,
    payload: { performedAt },
    createdAt: new Date().toISOString(),
    status: "pending",
    attemptCount: 0
  };
  await db.queue.put(item);
  notify();
  return item;
}

export async function enqueuePerformanceCancel(songId: string, performanceId: string, clientRequestId = queueRequestId()): Promise<OfflineQueueItem> {
  const item: OfflineQueueItem = {
    id: clientRequestId,
    clientRequestId,
    action: "performance:cancel",
    songId,
    performanceId,
    payload: { performanceId },
    createdAt: new Date().toISOString(),
    status: "pending",
    attemptCount: 0
  };
  await db.queue.put(item);
  notify();
  return item;
}

/** Convert a browser/network/API error into a user-actionable queue category. */
export function classifyQueueError(error: unknown): QueueFailureClassification {
  if (isApiAuthError(error)) return "auth";
  const parsed = error as Partial<ParsedApiError> | null;
  if (parsed && typeof parsed === "object" && typeof parsed.code === "string") {
    if (parsed.code === "VALIDATION_ERROR" || parsed.code === "BAD_REQUEST") return "validation";
    if (parsed.code === "NOT_FOUND") return "not_found";
    if (parsed.code === "CONFLICT") return "conflict";
    if (parsed.status === 401 || parsed.status === 403) return "auth";
    if (typeof parsed.status === "number" && (parsed.status >= 500 || parsed.status === 408 || parsed.status === 429)) return "server";
    return "unknown";
  }
  // Fetch failures have no HTTP status and are safe to retry.
  if (error instanceof TypeError || (typeof globalThis.DOMException !== "undefined" && error instanceof globalThis.DOMException)) return "network";
  return "unknown";
}

function isRetryable(classification: QueueFailureClassification): boolean {
  return classification === "network" || classification === "server";
}

function retryDelay(attemptCount: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attemptCount - 1));
  // Small deterministic jitter avoids all tabs retrying at the same instant.
  return Math.min(MAX_BACKOFF_MS, base + Math.floor(base * 0.1));
}

function errorMessage(error: unknown, classification: QueueFailureClassification): string {
  if (error instanceof Error && error.message) return error.message;
  switch (classification) {
    case "auth": return "로그인이 필요해.";
    case "validation": return "입력값을 확인해줘.";
    case "not_found": return "대상 곡이나 기록을 찾지 못했어.";
    case "conflict": return "서버에서 이미 바뀐 기록이야.";
    case "network": return "네트워크 연결을 확인해줘.";
    default: return "동기화하지 못했어.";
  }
}

export async function queueCounts(): Promise<QueueCounts> {
  const rows = await db.queue.toArray();
  return {
    pending: rows.filter((row) => row.status === "pending").length,
    inFlight: rows.filter((row) => row.status === "in_flight").length,
    failed: rows.filter((row) => row.status === "failed").length,
    deadLetter: rows.filter((row) => row.status === "dead-letter").length,
    authPaused
  };
}

export async function queueItems(): Promise<OfflineQueueItem[]> {
  return (await db.queue.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function normalizeInFlight(): Promise<void> {
  await db.queue.where("status").equals("in_flight").modify({ status: "pending" });
}

async function replayItem(item: OfflineQueueItem, now: Date): Promise<"done" | "paused"> {
  await db.queue.update(item.id, { status: "in_flight" });
  try {
    if (item.action === "performance:create") {
      await createPerformance(item.songId, item.clientRequestId, typeof item.payload.performedAt === "string" ? item.payload.performedAt : undefined);
    } else {
      await cancelPerformance(item.performanceId ?? String(item.payload.performanceId ?? ""), item.clientRequestId);
    }
    await db.queue.delete(item.id);
    return "done";
  } catch (error) {
    const classification = classifyQueueError(error);
    const attemptCount = item.attemptCount + 1;
    const permanent = !isRetryable(classification) || attemptCount >= MAX_ATTEMPTS;
    await db.queue.update(item.id, {
      status: permanent ? "dead-letter" : "failed",
      attemptCount,
      errorClassification: classification,
      errorMessage: errorMessage(error, classification),
      nextRetryAt: permanent || classification === "auth" ? undefined : new Date(now.getTime() + retryDelay(attemptCount)).toISOString()
    });
    return classification === "auth" ? "paused" : "done";
  }
}

/**
 * Drain is process-wide and serialized. A second online/visibility event
 * joins the first drain instead of issuing duplicate writes.
 */
export function drainOfflineQueue(options: QueueReplayOptions = {}): Promise<QueueCounts> {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    const now = options.now ?? (() => new Date());
    await normalizeInFlight();
    authPaused = false;
    const current = now();
    const rows = (await queueItems()).filter((row) => {
      if (row.status !== "pending" && row.status !== "failed") return false;
      return !row.nextRetryAt || new Date(row.nextRetryAt).getTime() <= current.getTime();
    });
    if (!options.auth && rows.length) {
      authPaused = true;
      await db.transaction("rw", db.queue, async () => {
        for (const item of rows) {
          await db.queue.update(item.id, {
            status: "failed",
            errorClassification: "auth",
            errorMessage: "로그인 후 다시 시도할 수 있어.",
            nextRetryAt: undefined
          });
        }
      });
      const result = await queueCounts();
      notify(options);
      return result;
    }
    for (const item of rows) {
      if (options.auth) {
        try {
          await options.auth.requireValidCredential();
        } catch {
          authPaused = true;
          await db.queue.update(item.id, {
            status: "failed",
            errorClassification: "auth",
            errorMessage: "로그인 후 다시 시도할 수 있어.",
            nextRetryAt: undefined
          });
          break;
        }
      }
      const result = await replayItem(item, current);
      if (result === "paused") {
        authPaused = true;
        break;
      }
      notify(options);
    }
    const result = await queueCounts();
    notify(options);
    return result;
  })().finally(() => {
    drainPromise = null;
  });
  return drainPromise;
}

export async function retryQueueItem(id: string): Promise<void> {
  await db.queue.update(id, {
    status: "pending",
    nextRetryAt: undefined,
    errorClassification: undefined,
    errorMessage: undefined
  });
  authPaused = false;
  notify();
}

export async function discardQueueItem(id: string): Promise<void> {
  await db.queue.delete(id);
  notify();
}

export async function markQueueItemFailed(id: string, error: unknown, classification: QueueFailureClassification): Promise<void> {
  await db.queue.update(id, {
    status: "failed",
    errorClassification: classification,
    errorMessage: error instanceof Error ? error.message : "동기화하지 못했어.",
    nextRetryAt: undefined
  });
  notify();
}

export function resetQueueForTests(): void {
  authPaused = false;
  drainPromise = null;
  listeners.clear();
}
