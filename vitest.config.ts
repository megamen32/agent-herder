import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts"],
    exclude: ["vendor/**", "node_modules/**"],
    setupFiles: ["tests/vitest-isolation.setup.ts"],
  },
});
