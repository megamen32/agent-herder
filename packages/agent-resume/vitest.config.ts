import { defineConfig } from "vitest/config";

// The core is an independent package: its own test run must not inherit the
// host project's isolation setup, and must not collect the host's suites.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
