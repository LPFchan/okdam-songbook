import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../lib/db";

const { createPerformance, cancelPerformance } = vi.hoisted(() => ({
  createPerformance: vi.fn(),
  cancelPerformance: vi.fn()
}));

vi.mock("../lib/api", () => ({
  createPerformance,
  cancelPerformance,
  isApiAuthError: (error: unknown) => {
    const value = error as { code?: string };
    return value?.code === "UNAUTHORIZED" || value?.code === "FORBIDDEN";
  }
}));

import {
  discardQueueItem,
  cancelPerformanceOrQueue,
  drainOfflineQueue,
  enqueuePerformanceCancel,
  enqueuePerformanceCreate,
  queueCounts,
  queueItems,
  resetQueueForTests,
  retryQueueItem
} from "../lib/offlineQueue";

describe("offline performance queue", () => {
  beforeEach(async () => {
    resetQueueForTests();
    await db.queue.clear();
    createPerformance.mockReset();
    cancelPerformance.mockReset();
  });

  it("replays an offline create once when online", async () => {
    const item = await enqueuePerformanceCreate("song-1", "11111111-1111-4111-8111-111111111111", "2026-08-13T10:00:00.000Z");
    createPerformance.mockResolvedValue({ id: "performance-1" });

    await Promise.all([
      drainOfflineQueue({ auth: { requireValidCredential: async () => undefined } }),
      drainOfflineQueue({ auth: { requireValidCredential: async () => undefined } })
    ]);

    expect(createPerformance).toHaveBeenCalledTimes(1);
    expect(createPerformance).toHaveBeenCalledWith(item.songId, item.clientRequestId, "2026-08-13T10:00:00.000Z");
    expect(await queueItems()).toEqual([]);
  });

  it("keeps transient failures retryable with bounded backoff", async () => {
    await enqueuePerformanceCreate("song-1", "22222222-2222-4222-8222-222222222222");
    createPerformance.mockRejectedValueOnce(new TypeError("offline"));
    const now = new Date("2026-08-13T10:00:00.000Z");
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, now: () => now });
    const item = (await queueItems())[0]!;
    expect(item.status).toBe("failed");
    expect(item.errorClassification).toBe("network");
    expect(item.nextRetryAt).toBe("2026-08-13T10:00:01.100Z");

    createPerformance.mockResolvedValue({ id: "performance-1" });
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, now: () => new Date(item.nextRetryAt!) });
    expect(createPerformance).toHaveBeenCalledTimes(2);
    expect(await queueItems()).toEqual([]);
  });

  it("pauses on auth and resumes with the original request id", async () => {
    const item = await enqueuePerformanceCreate("song-1", "33333333-3333-4333-8333-333333333333");
    const requireCredential = vi.fn().mockRejectedValueOnce(new Error("login required")).mockResolvedValue(undefined);
    createPerformance.mockResolvedValue({ id: "performance-1" });

    await drainOfflineQueue({ auth: { requireValidCredential: requireCredential } });
    expect((await queueItems())[0]).toMatchObject({ status: "failed", errorClassification: "auth" });

    await retryQueueItem(item.id);
    await drainOfflineQueue({ auth: { requireValidCredential: requireCredential } });
    expect(createPerformance).toHaveBeenCalledWith(item.songId, item.clientRequestId, expect.any(String));
    expect(await queueItems()).toEqual([]);
  });

  it("dead-letters permanent errors and supports explicit discard", async () => {
    const item = await enqueuePerformanceCreate("deleted-song", "44444444-4444-4444-8444-444444444444");
    createPerformance.mockRejectedValue({ code: "NOT_FOUND", status: 404, message: "missing" });
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined } });
    expect((await queueItems())[0]).toMatchObject({ status: "dead-letter", errorClassification: "not_found", attemptCount: 1 });
    expect((await queueCounts()).deadLetter).toBe(1);

    await discardQueueItem(item.id);
    expect(await queueItems()).toEqual([]);
  });

  it("replays cancellation through the same queue contract", async () => {
    const item = await enqueuePerformanceCancel("song-1", "performance-1", "55555555-5555-4555-8555-555555555555");
    cancelPerformance.mockResolvedValue(undefined);
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined } });
    expect(cancelPerformance).toHaveBeenCalledWith(item.performanceId, item.clientRequestId);
    expect(await queueItems()).toEqual([]);
  });

  it("keeps the online cancellation request id when a response is lost", async () => {
    const cancellationRequestId = "66666666-6666-4666-8666-666666666666";
    cancelPerformance.mockRejectedValueOnce(new TypeError("response lost"));

    const result = await cancelPerformanceOrQueue("song-1", "performance-1", cancellationRequestId);
    const queued = (await queueItems())[0]!;

    expect(result).toEqual({ queued: true });
    expect(cancelPerformance).toHaveBeenCalledWith("performance-1", cancellationRequestId);
    expect(queued).toMatchObject({ id: cancellationRequestId, clientRequestId: cancellationRequestId, performanceId: "performance-1", status: "failed", errorClassification: "network" });

    await retryQueueItem(queued.id);
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined } });
    expect(cancelPerformance).toHaveBeenNthCalledWith(2, "performance-1", cancellationRequestId);
    expect(await queueItems()).toEqual([]);
  });
});
