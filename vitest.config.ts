import { defineConfig } from "vitest/config";

// Local runs use the docker MySQL's outbrief_test; CI sets OUTBRIEF_TEST_DATABASE_URL.

export default defineConfig({
  test: {
    // All test files share one MySQL test database.
    fileParallelism: false,
  },
});
