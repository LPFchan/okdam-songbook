import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The tests run the Worker entry on Node, where the runtime's own modules
// don't exist; they get a stand-in that runs background work without
// keeping anything alive.
export default defineConfig({
  test: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers.ts", import.meta.url))
    }
  }
});
