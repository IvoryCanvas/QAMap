import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:5173" },
});
