import { createHash } from "node:crypto";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Two registered devices; tests authenticate with "token-desktop" and "token-phone".
        bindings: { DEVICE_TOKENS: JSON.stringify({ desktop: hash("token-desktop"), phone: hash("token-phone") }) },
      },
    }),
  ],
});
