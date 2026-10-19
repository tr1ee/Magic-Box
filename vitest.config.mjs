import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.jsx"],
    environment: "jsdom",
    setupFiles: ["./test/ui.setup.mjs"],
    restoreMocks: true
  }
});
