import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = env.VITE_APP_BASE_PATH || "/";
  return {
    base,
    plugins: [
      react(),
      VitePWA({
        registerType: "prompt",
        scope: base,
        base,
        includeAssets: ["robots.txt", "icons/icon.svg"],
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
              src: `${base}icons/icon.svg`,
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any maskable"
            }
          ]
        },
        workbox: {
          navigateFallback: `${base}index.html`,
          navigateFallbackDenylist: [/^\/(?:api|mcp|\.well-known)(?:\/|$)/u],
          runtimeCaching: [
            {
              urlPattern: ({ url }) => /^(?:api|mcp|\.well-known)(?:\/|$)/u.test(url.pathname.replace(/^\//u, "")),
              handler: "NetworkOnly",
              options: { cacheName: "songbook-network-only" }
            }
          ],
          globPatterns: ["**/*.{js,css,html,svg,png,ico,txt}"]
        }
      })
    ],
    test: {
      environment: "jsdom",
      setupFiles: "./vitest.setup.ts"
    }
  };
});
