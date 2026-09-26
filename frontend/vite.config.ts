import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Phase 1 scope only: base React+TS+Vite wiring. A dev proxy to the
// backend is added once real API routes exist (Phase 3+) — for now the
// health check page calls the backend's absolute URL directly via
// VITE_API_BASE_URL (see src/api/client.ts).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
