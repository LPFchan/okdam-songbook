/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_APP_BASE_PATH?: string;
  readonly VITE_ENABLE_MOCK_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
