import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4176",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4176",
    url: "http://127.0.0.1:4176/feedback",
    reuseExistingServer: false,
  },
});
