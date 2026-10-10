import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The API base URL comes from VITE_API_BASE_URL (see src/api/http.ts). Frontend and API must be SAME-SITE in
// production for the refresh cookie to work (docs/auth.md); localhost:5173 -> localhost:8000 is same-site in dev.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    environment: "jsdom",
    globals: true,
    globalSetup: ["./src/test/tz.ts"],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
