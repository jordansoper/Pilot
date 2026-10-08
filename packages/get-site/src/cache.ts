/**
 * Cache-Control directives for the install script endpoint.
 *
 * Mirrors the conventions used by `get.docker.com`, `rustup.rs`, and similar
 * install-script hosts:
 *
 *   - max-age: 5 min browser cache (forces revalidation on hard refresh)
 *   - s-maxage: 1 day shared CDN cache (Cloudflare, ISP)
 *   - stale-while-revalidate: 1 week. CDN keeps serving stale content while
 *     revalidating in the background after s-maxage expires, so a deploy
 *     to the worker doesn't cause a cold-cache stampede.
 *
 * Operators editing install.sh on main don't have to redeploy the worker to
 * push updates — pass `?source=github` to fetch the latest main copy.
 */
export interface InstallCacheOptions {
  /** Browser cache seconds. Default 300 (5 min). */
  maxAge?: number;
  /** Shared/CDN cache seconds. Default 86400 (1 day). */
  sMaxAge?: number;
  /** Stale-while-revalidate seconds. Default 604800 (1 week). */
  swr?: number;
}

export function installCacheHeaders(
  opts: InstallCacheOptions = {},
): Record<string, string> {
  return {
    'Cache-Control': [
      'public',
      `max-age=${opts.maxAge ?? 300}`,
      `s-maxage=${opts.sMaxAge ?? 86400}`,
      `stale-while-revalidate=${opts.swr ?? 604800}`,
    ].join(', '),
  };
}

/** Security headers for any shell-script response. */
export function installSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    // The body is a bash script that some downstream tools proxy. Don't
    // allow it to be embedded or executed in a browser context.
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
  };
}

/** Cache + security headers for the HTML landing page. */
export function htmlCacheHeaders(): Record<string, string> {
  return {
    'Cache-Control':
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  };
}
