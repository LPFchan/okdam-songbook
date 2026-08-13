import { describe, expect, it } from "vitest";
import { mcpPackage } from "../src/index.js";

describe("MCP substrate", () => {
  it("exposes a buildable package boundary", () => {
    expect(mcpPackage).toBe("@songbook/mcp");
  });
});
