import { describe, expect, it } from "vitest";
import { adminPackage } from "../src/index.js";

describe("admin substrate", () => {
  it("exposes a buildable package boundary", () => {
    expect(adminPackage).toBe("@songbook/admin");
  });
});
