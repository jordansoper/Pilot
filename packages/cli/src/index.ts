#!/usr/bin/env node
/**
 * pilot-cli — Phase 1 entry point.
 *
 * Boots a daemon that prints a `pilot://pair` QR (for the app to scan),
 * runs on the user's Tailscale IP, and serves a tiny HTTP+WS control plane
 * the Expo app uses to launch an AI CLI in a chosen folder.
 *
 * See PROJECT_PLAN.md §Phase 1 for what this does and doesn't yet do.
 */
import { hostname } from 'node:os';
import {
  DEFAULT_BIND,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  SHARED_PACKAGE_VERSION,
} from '@pilot/shared';
import { buildPairingPayload, buildPairingUrl, renderPairingQr } from './pairing.js';
import { startServer } from './server.js';
import { getTailscaleIp } from './tailscale.js';
import { loadOrCreateToken } from './token.js';

interface CliArgs {
  port: number;
  bind: string;
  name: string;
  noQr: boolean;
  rotateToken: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: DEFAULT_PORT,
    bind: DEFAULT_BIND,
    name: hostname(),
    noQr: false,
    rotateToken: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--port':
      case '-p': {
        const v = Number(next());
        if (!Number.isInteger(v) || v < 0 || v > 65535) {
          throw new Error('--port must be an integer in 0..65535');
        }
        args.port = v;
        break;
      }
      case '--bind':
      case '-b':
        args.bind = String(next());
        break;
      case '--name':
      case '-n':
        args.name = String(next());
        break;
      case '--no-qr':
        args.noQr = true;
        break;
      case '--rotate-token':
        args.rotateToken = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        if (a?.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    `pilot-cli v${SHARED_PACKAGE_VERSION} (protocol v${PROTOCOL_VERSION})

Usage:
  pilot [flags]

Flags:
  --port, -p <n>   TCP port to listen on (default ${DEFAULT_PORT}, 0 = ephemeral)
  --bind, -b <ip>  IP to bind to (default ${DEFAULT_BIND})
  --name, -n <s>   Friendly machine name in the QR (default: hostname)
  --no-qr          Print pairing URL but skip the ASCII QR (for headless)
  --rotate-token   Generate a fresh token (invalidates existing pairings)
  -h, --help       Print this help

The pairing token is persisted to ~/.pilot/token so a paired phone keeps
working across restarts. Use --rotate-token to revoke and re-pair.
`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const {
    token,
    path: tokenPath,
    created,
  } = loadOrCreateToken({
    rotate: args.rotateToken,
  });
  const tailscaleIp = await getTailscaleIp();

  // The pairing payload MUST use a Tailscale-routable host. If we couldn't
  // find one, we still print a payload but with the local bind IP — pairing
  // will work only when the phone is on the same machine. We make this loud.
  const payload = buildPairingPayload({
    host: tailscaleIp ?? args.bind,
    port: args.port,
    token,
    name: args.name,
  });
  const url = buildPairingUrl(payload);

  console.log(`pilot-cli v${SHARED_PACKAGE_VERSION} (protocol v${PROTOCOL_VERSION})`);
  console.log(
    created
      ? `Token: new token written to ${tokenPath} — pair once; it persists across restarts.`
      : `Token: reusing ${tokenPath} — existing pairings still valid (use --rotate-token to revoke).`,
  );
  if (tailscaleIp) {
    console.log(
      `Tailscale IP: ${tailscaleIp}  ·  Listening on ${args.bind}:${args.port}  ·  Name: ${payload.name}`,
    );
  } else {
    console.log(
      `⚠ Tailscale not detected. Falling back to ${args.bind} — pairing will only work on this machine.`,
    );
    console.log(`Listening on ${args.bind}:${args.port}  ·  Name: ${payload.name}`);
  }
  renderPairingQr(url, { silent: args.noQr });

  const server = await startServer({
    token,
    port: args.port,
    bind: args.bind,
    tailscaleIp,
  });
  console.log(`HTTP server ready on http://${args.bind}:${server.port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down…`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('fatal:', message);
  process.exit(1);
});
