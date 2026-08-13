import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { serverPackage } from "../src/index.js";

describe("server substrate", () => {
  it("exposes a buildable package boundary", () => {
    expect(serverPackage).toBe("@songbook/server");
  });

  it("wires the bounded TJ adapter into the environment-started server", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain('import { createTjAdapter } from "@songbook/server-core"');
    expect(source).toMatch(/createConfiguredServer\(\{[\s\S]*?tj:\s*createTjAdapter\(\)/u);
  });
});
