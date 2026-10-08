import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Days are local days; the tests pin the zone so a fixture's "30 Sep" is 30 Sep everywhere.
    env: { TZ: "UTC" },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
