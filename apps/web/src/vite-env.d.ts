/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_ENABLED?: string;
  readonly VITE_AUTH_BASE_URL?: string;
  readonly VITE_AUTH_LEGACY_GIS_FALLBACK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
