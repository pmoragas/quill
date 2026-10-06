/// <reference types="@cloudflare/vitest-pool-workers/types" />

// The bindings declared in wrangler.jsonc, as seen from tests through `env`.
declare namespace Cloudflare {
  interface Env {
    BUCKET: R2Bucket;
    DEVICE_TOKENS?: string;
    MAX_FILE_BYTES?: string;
  }
}
