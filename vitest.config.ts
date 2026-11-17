import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@azizan/shared": fileURLToPath(new URL("./packages/shared/src/types.ts", import.meta.url)) },
  },
  test: {
    include: ["apps/**/*.test.ts"],
    // browser-side modules use Blob/FileReader/localStorage
    environmentMatchGlobs: [["apps/web/**", "jsdom"]],
  },
});
