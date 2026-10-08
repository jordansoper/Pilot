import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Run the worker in a real workerd isolate. SELF.fetch (from
 * `cloudflare:test`) calls into the actual fetch handler, so cache headers,
 * Cache-Control, ETag / If-None-Match, and the Cache API all behave the way
 * they will in production.
 *
 * `singleWorker: true` keeps the test run fast — one isolate serves all tests.
 */
export default defineWorkersConfig({
  test: {
    include: ['src/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        singleWorker: true,
        minify: true,
      },
    },
  },
});
