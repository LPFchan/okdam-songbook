import { describe, expect, it } from "vitest";
import { serverCorePackage } from "../src/index.js";

describe("server core substrate", () => {
  it("exposes a buildable package boundary", () => {
    expect(serverCorePackage).toBe("@songbook/server-core");
  });
});
