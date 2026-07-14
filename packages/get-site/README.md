# `@pilot/get-site`

Cloudflare Worker that hosts `install.sh` at **https://pilot.remarkablenerds.com/**
with cache-friendly headers. Powers the one-liner:

```bash
curl -fsSL https://pilot.remarkablenerds.com/install.sh | bash
```

## Routes

| Path | Response |
|---|---|
| `GET /install.sh` | Latest bundled `install.sh` from this repo's `main`. |
| `GET /install` | Alias for `/install.sh`. |
| `GET /` | Landing page with the install command and OS matrix. |

Add `?source=github` to `/install.sh` to bypass the bundle and fetch the
freshest `install.sh` straight from `raw.githubusercontent.com` on `main`.
Use this when you just edited `install.sh` on `main` and want to verify
the live URL reflects the change before the next worker deploy lands.

## How it works

`scripts/bundle-install.mjs` runs on every `pnpm install`, `pnpm build`,
`pnpm test`, `pnpm typecheck`, and `pnpm dev` (postinstall + every pre-\*
hook). It reads `../../install.sh`, computes its SHA-256, and writes it
into `src/install-bundled.ts` as an escape-safe template-literal TS
constant.

The worker serves the bundled content with:

```
Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=604800
ETag: "<sha256-prefix>"
Content-Type: text/plain; charset=utf-8
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; sandbox
Referrer-Policy: no-referrer
```

Clients that send `If-None-Match: <etag>` get a 304 with the same headers.

## Local dev

```bash
pnpm install                                        # postinstall → bundle-install.mjs
pnpm --filter @pilot/get-site dev                   # wrangler dev  → http://localhost:8787
pnpm --filter @pilot/get-site test                  # vitest-pool-workers (workerd)
pnpm --filter @pilot/get-site typecheck             # tsc --noEmit
pnpm --filter @pilot/get-site deploy --dry-run      # wrangler dry-run → ./dist
```

Hit the local worker:

```bash
curl -i http://localhost:8787/install.sh
open   http://localhost:8787/
```

## Deploy

```bash
pnpm --filter @pilot/get-site deploy    # needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```

The `routes: [{ pattern: "pilot.remarkablenerds.com", custom_domain: true }]` line
in `wrangler.jsonc` requires the **`remarkablenerds.com` zone** to exist in the
Cloudflare account you're deploying to. Cloudflare provisions the DNS
record for `pilot.remarkablenerds.com` automatically on first deploy.

### CI setup

1. Cloudflare dashboard → My Profile → API Tokens → Create Token.
2. Template: **Edit Cloudflare Workers** (or manually grant
   *Workers Scripts: Edit* + *Workers Routes: Edit* scoped to `remarkablenerds.com`).
3. Add the token and account ID as repository secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. Push to `main` → `.github/workflows/ci.yml` runs the
   `deploy-get-site` job.

## Files

| File | Role |
|---|---|
| `src/worker.ts` | Main `fetch` handler with routing. Re-exports bundled metadata. |
| `src/install.ts` | `install.sh` handler: 200 / 304 / `?source=github` GitHub fetch. |
| `src/landing.ts` | HTML landing page (no JS frameworks, dark+light theme). |
| `src/cache.ts` | Cache-Control + security header helpers. |
| `src/install-bundled.ts` | **Generated.** Gitignored. Holds `install.sh` as a TS string. |
| `src/__tests__/worker.test.ts` | vitest-pool-workers tests (runs in real workerd). |
| `scripts/bundle-install.mjs` | Bundle generator. |
| `wrangler.jsonc` | Worker config: route, env vars, observability. |
| `vitest.config.ts` | Pool config for the workers test runner. |
