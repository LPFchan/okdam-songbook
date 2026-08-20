import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { serverPackage } from "../src/index.js";

describe("server substrate", () => {
  it("exposes a buildable package boundary", () => {
    expect(serverPackage).toBe("@songbook/server");
  });

  it("wires the TJ adapter to the same SQLite handle as the server", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain('import { createTjAdapter, createTjSearchMirror } from "@songbook/server-core"');
    expect(source).toMatch(/const database = \(await import\("@songbook\/server-core"\)\)\.openDatabase\(\{ filename: dbPath \}\);[\s\S]*?mirror:\s*createTjSearchMirror\(database\.sqlite\)/u);
    expect(source).toMatch(/onWarn:\s*\(warning\)\s*=>\s*console\.warn\(JSON\.stringify/u);
  });
});
