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
  const accountA = "auth.lost.plus:a";
  const accountB = "auth.lost.plus:b";

  beforeEach(async () => {
    resetQueueForTests();
    await db.queue.clear();
    createPerformance.mockReset();
    cancelPerformance.mockReset();
  });

  it("replays an offline create once when online", async () => {
    const item = await enqueuePerformanceCreate("song-1", accountA, "11111111-1111-4111-8111-111111111111", "2026-08-13T10:00:00.000Z");
    createPerformance.mockResolvedValue({ id: "performance-1" });

    await Promise.all([
      drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountA }),
      drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountA })
    ]);

    expect(createPerformance).toHaveBeenCalledTimes(1);
    expect(createPerformance).toHaveBeenCalledWith(item.songId, item.clientRequestId, "2026-08-13T10:00:00.000Z", accountA);
    expect(await queueItems()).toEqual([]);
  });

  it("keeps transient failures retryable with bounded backoff", async () => {
    await enqueuePerformanceCreate("song-1", accountA, "22222222-2222-4222-8222-222222222222");
    createPerformance.mockRejectedValueOnce(new TypeError("offline"));
    const now = new Date("2026-08-13T10:00:00.000Z");
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountA, now: () => now });
    const item = (await queueItems(accountA))[0]!;
    expect(item.status).toBe("failed");
    expect(item.errorClassification).toBe("network");
    expect(item.nextRetryAt).toBe("2026-08-13T10:00:01.100Z");

    createPerformance.mockResolvedValue({ id: "performance-1" });
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountA, now: () => new Date(item.nextRetryAt!) });
    expect(createPerformance).toHaveBeenCalledTimes(2);
    expect(await queueItems("a@example.com")).toEqual([]);
  });

  it("pauses on auth and resumes with the original request id", async () => {
    const item = await enqueuePerformanceCreate("song-1", accountA, "33333333-3333-4333-8333-333333333333");
    const requireCredential = vi.fn().mockRejectedValueOnce(new Error("login required")).mockResolvedValue(undefined);
    createPerformance.mockResolvedValue({ id: "performance-1" });

    await drainOfflineQueue({ auth: { requireValidCredential: requireCredential }, ownerSubject: accountA });
    expect((await queueItems(accountA))[0]).toMatchObject({ status: "failed", errorClassification: "auth" });

    await retryQueueItem(item.id, accountA);
    await drainOfflineQueue({ auth: { requireValidCredential: requireCredential }, ownerSubject: accountA });
    expect(createPerformance).toHaveBeenCalledWith(item.songId, item.clientRequestId, expect.any(String), accountA);
    expect(await queueItems("a@example.com")).toEqual([]);
  });

  it("dead-letters permanent errors and supports explicit discard", async () => {
    const item = await enqueuePerformanceCreate("deleted-song", accountA, "44444444-4444-4444-8444-444444444444");
    createPerformance.mockRejectedValue({ code: "NOT_FOUND", status: 404, message: "missing" });
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountA });
    expect((await queueItems(accountA))[0]).toMatchObject({ status: "dead-letter", errorClassification: "not_found", attemptCount: 1 });
    expect((await queueCounts(accountA)).deadLetter).toBe(1);

    await discardQueueItem(item.id, accountA);
    expect(await queueItems("a@example.com")).toEqual([]);
  });

  it("replays cancellation through the same queue contract", async () => {
    const item = await enqueuePerformanceCancel("song-1", "performance-1", accountA, "55555555-5555-4555-8555-555555555555");
    cancelPerformance.mockResolvedValue(undefined);
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountA });
    expect(cancelPerformance).toHaveBeenCalledWith(item.performanceId, item.clientRequestId, accountA);
    expect(await queueItems("a@example.com")).toEqual([]);
  });

  it("keeps the online cancellation request id when a response is lost", async () => {
    const cancellationRequestId = "66666666-6666-4666-8666-666666666666";
    cancelPerformance.mockRejectedValueOnce(new TypeError("response lost"));

    const result = await cancelPerformanceOrQueue("song-1", "performance-1", accountA, cancellationRequestId);
    const queued = (await queueItems(accountA))[0]!;

    expect(result).toEqual({ queued: true });
    expect(cancelPerformance).toHaveBeenCalledWith("performance-1", cancellationRequestId, accountA);
    expect(queued).toMatchObject({ id: cancellationRequestId, clientRequestId: cancellationRequestId, performanceId: "performance-1", status: "failed", errorClassification: "network" });

    await retryQueueItem(queued.id, accountA);
    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountA });
    expect(cancelPerformance).toHaveBeenNthCalledWith(2, "performance-1", cancellationRequestId, accountA);
    expect(await queueItems("a@example.com")).toEqual([]);
  });

  it("hides another user's queued rows from reads and drains", async () => {
    await enqueuePerformanceCreate("song-1", accountA, "77777777-7777-4777-8777-777777777777");
    createPerformance.mockResolvedValue({ id: "performance-1" });

    expect(await queueItems(accountB)).toEqual([]);
    expect((await queueCounts(accountB)).pending).toBe(0);

    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountB });
    expect(createPerformance).not.toHaveBeenCalled();
    expect((await queueItems(accountA)).length).toBe(1);
  });

  it("does not let another account retry or discard a queued row by id", async () => {
    const item = await enqueuePerformanceCreate("song-1", accountA, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    expect(await retryQueueItem(item.id, accountB)).toBe(false);
    expect(await discardQueueItem(item.id, accountB)).toBe(false);
    expect(await db.queue.get(item.id)).toMatchObject({ ownerSubject: accountA, status: "pending" });

    expect(await retryQueueItem(item.id, accountA)).toBe(true);
    expect(await discardQueueItem(item.id, accountA)).toBe(true);
    expect(await db.queue.get(item.id)).toBeUndefined();
  });

  it("ignores the queue entirely when no user is signed in", async () => {
    await enqueuePerformanceCreate("song-1", accountA, "88888888-8888-4888-8888-888888888888");

    expect(await queueItems(undefined)).toEqual([]);
    const counts = await drainOfflineQueue({});
    expect(counts.pending).toBe(0);
    expect(counts.authPaused).toBe(false);
    expect(createPerformance).not.toHaveBeenCalled();
  });

  it("quarantines legacy rows instead of assigning them to the next user", async () => {
    await db.queue.put({
      id: "99999999-9999-4999-8999-999999999999",
      clientRequestId: "99999999-9999-4999-8999-999999999999",
      action: "performance:create",
      songId: "song-1",
      ownerSubject: "legacy-unverified",
      payload: {},
      createdAt: new Date().toISOString(),
      status: "dead-letter",
      attemptCount: 0
    });
    createPerformance.mockResolvedValue({ id: "performance-1" });

    await drainOfflineQueue({ auth: { requireValidCredential: async () => undefined }, ownerSubject: accountB });
    expect(createPerformance).not.toHaveBeenCalled();
    expect(await db.queue.get("99999999-9999-4999-8999-999999999999")).toMatchObject({ ownerSubject: "legacy-unverified", status: "dead-letter" });
  });

  it("revalidates the immutable owner before replaying after an account switch", async () => {
    await enqueuePerformanceCreate("song-1", accountA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const requireValidCredential = vi.fn().mockRejectedValue(new Error("account changed"));

    await drainOfflineQueue({ auth: { requireValidCredential }, ownerSubject: accountA });

    expect(requireValidCredential).toHaveBeenCalledWith(accountA);
    expect(createPerformance).not.toHaveBeenCalled();
    expect((await queueItems(accountA))[0]).toMatchObject({ status: "failed", errorClassification: "auth" });
  });
});
