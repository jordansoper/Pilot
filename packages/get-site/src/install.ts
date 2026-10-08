import {
  INSTALL_SH_TEXT,
  INSTALL_SH_BYTES,
  INSTALL_SH_SHA256,
  INSTALL_SH_SOURCE,
} from './install-bundled.js';
import {
  installCacheHeaders,
  installSecurityHeaders,
} from './cache.js';

export interface Env {
  /** GitHub `owner/repo` to fall back to. Default `jordansoper/Pilot`. */
  GITHUB_REPO?: string;
  /** Git ref / branch. Default `main`. */
  GITHUB_REF?: string;
  /** Path inside the repo. Default `install.sh`. */
  INSTALL_SH_PATH?: string;
}

const UPSTREAM_TIMEOUT_MS = 5000;

// GitHub raw URL components must come from operator-controlled wrangler
// vars, but defense-in-depth: a future deploy could typo a fragment or @
// host into one of these. Restrict to safe chars so the URL is always
// well-formed and points at raw.githubusercontent.com only.
const SAFE_PATH_RE = /^[\w./-]+$/;

function safePath(value: string | undefined, fallback: string): string | null {
  const candidate = value ?? fallback;
  return SAFE_PATH_RE.test(candidate) ? candidate : null;
}

function upstreamUrl(
  env: Env,
): { url: string } | { error: string } {
  const repo = safePath(env.GITHUB_REPO, 'jordansoper/Pilot');
  const ref = safePath(env.GITHUB_REF, 'main');
  const path = safePath(env.INSTALL_SH_PATH, 'install.sh');
  if (repo === null || ref === null || path === null) {
    return { error: 'Invalid GITHUB_REPO / GITHUB_REF / INSTALL_SH_PATH env' };
  }
  return { url: `https://raw.githubusercontent.com/${repo}/${ref}/${path}` };
}

/** Compute a SHA-256 hex digest of a UTF-8 string. */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * ETag derived from full SHA-256. We use the first 16 hex chars (64 bits)
 * — enough to avoid collisions across deploys and small enough to fit in
 * any caller.
 */
function etagFromSha(sha: string): string {
  return `"${sha.slice(0, 16)}"`;
}

export async function getInstallScript(
  request: Request,
  env: Env,
): Promise<Response> {
  if (INSTALL_SH_BYTES === 0) {
    // Defensive — bundle script should have populated this. If we're running
    // in production with an empty bundle, fetch from GitHub raw as a failsafe
    // rather than serving a 0-byte body to `curl | bash`.
    return serveFromGithub(env);
  }

  const etag = etagFromSha(INSTALL_SH_SHA256);

  // Honor If-None-Match — saves bandwidth for ETag-aware callers (curl
  // supports `--etag-compare`; CI caches; bots). 304 responses still carry
  // cache + security headers so the cache contract holds.
  const inm = request.headers.get('If-None-Match');
  if (inm !== null && inm === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        ...installCacheHeaders(),
        ...installSecurityHeaders(),
      },
    });
  }

  const url = new URL(request.url);

  // Operator escape hatch: force a fresh GitHub raw fetch. Useful when
  // someone just edited install.sh on main and wants the live URL to
  // reflect it before the next worker deploy catches up.
  if (url.searchParams.get('source') === 'github') {
    const upstream = await serveFromGithub(env);
    if (upstream.ok) return upstream;
    const fallback = bundledResponse(etag);
    fallback.headers.set('X-Pilot-Github-Fallback', 'unreachable');
    return fallback;
  }

  return bundledResponse(etag);
}

function bundledResponse(etag: string): Response {
  return new Response(INSTALL_SH_TEXT, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(INSTALL_SH_BYTES),
      ETag: etag,
      'X-Pilot-Source': 'bundled',
      'X-Pilot-Bundled-Sha256': INSTALL_SH_SHA256,
      'X-Pilot-Bundled-Source': INSTALL_SH_SOURCE,
      ...installCacheHeaders(),
      ...installSecurityHeaders(),
    },
  });
}

async function serveFromGithub(env: Env): Promise<Response> {
  const upstream = upstreamUrl(env);
  if ('error' in upstream) {
    return new Response(`${upstream.error}\n`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const url = upstream.url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'pilot-get-site/1.0' },
      // Cache the GitHub response on Cloudflare's edge for 60s.
      // Note: this is Cloudflare's Cache API TTL; our own response sets
      // s-maxage=600 which is the higher value (CDN will use that), so the
      // practical edge TTL is 10 min on a hit but 1 min on a miss path.
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) {
      return new Response(
        `GitHub raw returned ${res.status} for ${url}\n`,
        {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        },
      );
    }
    const body = await res.text();
    const sha = await sha256Hex(body);
    return new Response(body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ETag: etagFromSha(sha),
        'X-Pilot-Source': 'github-raw',
        'X-Pilot-Upstream': url,
        // Shorter TTL since GitHub raw's own ETag governs upstream caching.
        ...installCacheHeaders({ maxAge: 60, sMaxAge: 600, swr: 3600 }),
        ...installSecurityHeaders(),
      },
    });
  } catch (e) {
    return new Response(
      `Failed to reach ${url}: ${(e as Error).message}\n`,
      {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}
