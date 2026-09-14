import { describe, expect, it } from "vitest";
import { whileSubjectCurrent } from "../lib/subjectBound";

describe("subject-bound asynchronous work", () => {
  it("drops a deferred response after the active account changes", async () => {
    let resolve!: (value: string) => void;
    const deferred = new Promise<string>((done) => {
      resolve = done;
    });
    let subject: string | undefined = "auth.lost.plus:a";

    const result = whileSubjectCurrent("auth.lost.plus:a", () => subject, () => deferred);
    subject = "auth.lost.plus:b";
    resolve("account-a-data");

    await expect(result).resolves.toBeUndefined();
  });

  it("returns a response while the originating account remains active", async () => {
    const subject = "auth.lost.plus:a";
    await expect(whileSubjectCurrent(subject, () => subject, async () => "account-a-data")).resolves.toBe("account-a-data");
  });
});
