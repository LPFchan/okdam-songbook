import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("worker bundle", () => {
  // Errors cross package boundaries and are told apart with instanceof, which
  // only works when every module shares one copy of server-core.
  it("bundles server-core from its build output only", async () => {
    const result = await build({
      entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["node:*", "cloudflare:*"],
      logLevel: "silent"
    });
    const serverCore = Object.keys(result.metafile.inputs).filter((path) => path.includes("packages/server-core/"));
    expect(serverCore.length).toBeGreaterThan(0);
    expect(serverCore.filter((path) => !path.includes("packages/server-core/dist/"))).toEqual([]);
  }, 30_000);
});
