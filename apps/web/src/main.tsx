import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { AppShell } from "./routes/AppShell";
import { PublicPage } from "./routes/PublicPage";
import { AuthProvider } from "./lib/auth/AuthContext";
import "./styles.css";

const basePath = import.meta.env.VITE_APP_BASE_PATH || "/okdam-songbook/";
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

const updateServiceWorker = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("songbook:update-ready", { detail: updateServiceWorker }));
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AuthProvider clientId={googleClientId}>
      <BrowserRouter basename={basePath.replace(/\/$/, "")}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<PublicPage />} />
            <Route path="admin" element={<PublicPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>
);
