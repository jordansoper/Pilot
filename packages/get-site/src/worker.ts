import { getInstallScript, type Env } from './install.js';
import { getLandingPage } from './landing.js';

export {
  INSTALL_SH_SHA256,
  INSTALL_SH_BYTES,
  INSTALL_SH_TEXT,
  INSTALL_SH_SOURCE,
} from './install-bundled.js';
export type { Env };

/**
 * Routes handled by this worker (Cloudflare binds `pilot.remarkablenerds.com` via
 * `routes` in wrangler.jsonc):
 *
 *   GET /                  → HTML landing page
 *   GET /install.sh        → Linux install script (primary)
 *   GET /install           → alias for /install.sh (convenience)
 *   everything else        → 404 Not Found
 *
 * The `?source=github` query on /install.sh forces a fetch from
 * raw.githubusercontent.com rather than the bundled copy. This is the
 * operator's escape hatch when main's install.sh has been updated but
 * the worker redeploy hasn't landed yet.
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    switch (path) {
      case '/':
        return getLandingPage();
      case '/install.sh':
      case '/install':
        return getInstallScript(request, env);
      default:
        return new Response(
          `Not found: ${path}\nTry /install.sh instead.\n`,
          {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          },
        );
    }
  },
};
