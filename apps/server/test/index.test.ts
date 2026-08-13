import { describe, expect, it } from "vitest";
import { serverPackage } from "../src/index.js";

describe("server substrate", () => {
  it("exposes a buildable package boundary", () => {
    expect(serverPackage).toBe("@songbook/server");
  });
});
