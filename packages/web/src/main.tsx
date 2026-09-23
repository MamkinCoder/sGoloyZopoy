import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable panel (home-screen icon). The hashed entry file name versions the asset cache.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const v = new URL(import.meta.url).pathname.split("/").pop() ?? "";
  navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(v)}`).catch(() => undefined);
}
