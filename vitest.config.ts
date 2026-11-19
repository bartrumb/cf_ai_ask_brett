import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts", "client/**/*.ts"],
      exclude: ["src/worker-configuration.d.ts", "src/domain/types.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    projects: [
      {
        plugins: [
          agents(),
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            remoteBindings: false,
            miniflare: { bindings: { AI_MODE: "offline" } },
          }),
        ],
        test: { name: "worker", include: ["test/**/*.test.ts"], testTimeout: 30_000 },
      },
      {
        test: { name: "client", environment: "happy-dom", include: ["test-client/**/*.test.ts"] },
      },
    ],
  },
});
