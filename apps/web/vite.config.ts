import { svelte } from "@sveltejs/vite-plugin-svelte";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv } from "vite";
import { SvelteKitPWA } from "@vite-pwa/sveltekit";

function pwaPlugin(base: string) {
  return SvelteKitPWA({
    registerType: "prompt",
    scope: base,
    base,
    includeAssets: ["robots.txt", "icons/*.png"],
    manifest: {
      name: "Songbook",
      short_name: "Songbook",
      description: "개인용 노래방 애창곡 관리 앱",
      scope: base,
      start_url: base,
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#3f5fb7",
      icons: [
        {
          src: `${base}icons/icon-192.png`,
          sizes: "192x192",
          type: "image/png",
          purpose: "any"
        },
        {
          src: `${base}icons/icon-512.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "any"
        },
        {
          src: `${base}icons/icon-maskable-512.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable"
        }
      ]
    },
    workbox: {
      globPatterns: ["client/**/*.{js,css,ico,png,svg,webmanifest}", "prerendered/**/*.html"],
      navigateFallback: `${base === "/" ? "" : base}/index.html`,
      navigateFallbackDenylist: [/^(?:api|mcp|\.well-known)(?:\/|$)/u],
      runtimeCaching: [
        {
          urlPattern: ({ url }: { url: URL }) => /^(?:api|mcp|\.well-known)(?:\/|$)/u.test(url.pathname.replace(/^\//u, "")),
          handler: "NetworkOnly",
          options: { cacheName: "songbook-network-only" }
        }
      ]
    }
  });
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = env.VITE_APP_BASE_PATH || "/";
  const isTest = mode === "test" || Boolean(process.env.VITEST);
  return {
    base,
    plugins: isTest ? [svelte()] : [sveltekit(), pwaPlugin(base)],
    test: {
      environment: "jsdom",
      setupFiles: "./vitest.setup.ts",
      include: ["src/**/*.{test,spec}.{ts,svelte.ts}"],
      server: {
        deps: {
          inline: ["svelte"]
        }
      },
      alias: [
        { find: /^svelte$/, replacement: new URL("../../node_modules/svelte/src/index-client.js", import.meta.url).pathname },
        { find: /^\$app\/state$/, replacement: new URL("./src/test/mocks/app-state.ts", import.meta.url).pathname },
        { find: /^\$app\/navigation$/, replacement: new URL("./src/test/mocks/app-navigation.ts", import.meta.url).pathname }
      ],
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: ["@lucide/svelte"]
          }
        }
      }
    }
  };
});
