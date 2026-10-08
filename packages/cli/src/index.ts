#!/usr/bin/env node
/**
 * pilot-cli — Phase 1 entry point.
 *
 * Boots a daemon that prints a `pilot://pair` QR (for the app to scan),
 * runs on the user's Tailscale IP (or 0.0.0.0), and serves a tiny HTTP+WS
 * control plane the Expo app uses to launch a shell in a chosen folder.
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
import type { PairingAddress } from './pairing-page.js';
import { getTailscaleIp } from './tailscale.js';
import { getLanIpv4s } from './network.js';
import { loadOrCreateToken } from './token.js';
import { acquireLock, releaseLock } from './lock.js';
import { logError } from './log.js';

interface CliArgs {
  port: number;
  bind: string;
  /** true when --bind was explicitly passed (vs the DEFAULT_BIND fallback). */
  bindExplicit: boolean;
  name: string;
  noQr: boolean;
  /** Force-print the pairing QR even when --no-qr would suppress it. */
  pair: boolean;
  rotateToken: boolean;
  /** Explicit host(s) to advertise in the QR, overriding auto-detection. */
  hosts: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: DEFAULT_PORT,
    bind: DEFAULT_BIND,
    bindExplicit: false,
    name: hostname(),
    noQr: false,
    pair: false,
    rotateToken: false,
    hosts: [],
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
        args.bindExplicit = true;
        break;
      case '--name':
      case '-n':
        args.name = String(next());
        break;
      case '--no-qr':
        args.noQr = true;
        break;
      case '--pair':
        args.pair = true;
        break;
      case '--host':
        // Repeatable: --host 192.168.1.20 --host 100.x.y.z
        args.hosts.push(String(next()));
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

USAGE
  pilot [flags]

FLAGS
  --port, -p <n>     TCP port (default ${DEFAULT_PORT}; 0 = OS picks ephemeral)
  --bind, -b <ip>    IP to bind (default: Tailscale IP or ${DEFAULT_BIND})
  --name, -n <s>     Machine name shown in the QR (default: hostname)
  --no-qr            Print pairing URL only — skip the ASCII QR
  --pair             Force-print the pairing QR (e.g. on a headless server)
  --host <ip>        Advertise this address in the QR (repeatable; default:
                     auto-detect Tailscale IP + LAN IPs, then fall back to
                     the bind address)
  --rotate-token     Revoke all pairings and generate a new token
  -h, --help         Print this help

ENVIRONMENT
  PILOT_FS_ROOT      Folder-browser allowlist root (default: $HOME)
  PILOT_DEBUG=1      Log every HTTP request to stderr (off by default)

FILES
  ~/.pilot/token       Persistent pairing token (0600, 32 random bytes hex)
  ~/.pilot/daemon.lock  PID lock file — prevents accidental double-start

EXAMPLES
  # Start the daemon — picks Tailscale IP (or 0.0.0.0) + port ${DEFAULT_PORT}
  pilot

  # Headless server — no ASCII art in the logs
  pilot --no-qr

  # Headless server — re-print QR for pairing from a remote terminal
  pilot --pair

  # Localhost-only, custom port (e.g. behind a reverse proxy)
  pilot --bind 127.0.0.1 --port 8080

  # Revoke all existing pairings
  pilot --rotate-token

  # Explicitly advertise only certain addresses
  pilot --host 192.168.1.42 --host 100.64.0.5

The pairing token persists in ~/.pilot/token so paired phones survive
daemon restarts. Use --rotate-token to revoke and re-pair.
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

  // When the user didn't explicitly set --bind, prefer the Tailscale IP
  // (more secure than 0.0.0.0). Fall back to 0.0.0.0 if not on a tailnet.
  const effectiveBind = args.bindExplicit ? args.bind : (tailscaleIp ?? args.bind);

  // Single-instance lock — refuse to start if something is already on our port.
  const lock = await acquireLock(effectiveBind, args.port);
  if (!lock.held) {
    const msg = `pilot-cli: ${lock.message}`;
    logError(msg);
    console.error(msg);
    process.exit(1);
  }

  // Assemble every address the phone might use. One QR carries them all, and
  // the app tries each — LAN when on the same Wi-Fi (fast, no Tailscale needed),
  // Tailscale from anywhere. `--host` overrides auto-detection.
  const addresses: PairingAddress[] = [];
  if (args.hosts.length > 0) {
    for (const h of args.hosts)
      addresses.push({ address: `${h}:${args.port}`, label: 'Custom' });
  } else {
    if (tailscaleIp) {
      addresses.push({
        address: `${tailscaleIp}:${args.port}`,
        label: 'Tailscale — anywhere',
      });
    }
    for (const lan of getLanIpv4s()) {
      addresses.push({
        address: `${lan.address}:${args.port}`,
        label: `Local network (${lan.iface}) — same Wi-Fi`,
      });
    }
  }

  const hosts =
    args.hosts.length > 0
      ? args.hosts
      : [...(tailscaleIp ? [tailscaleIp] : []), ...getLanIpv4s().map((l) => l.address)];
  // Fall back to the bind address if nothing was detected (single-machine use).
  if (hosts.length === 0) {
    hosts.push(args.bind);
    addresses.push({ address: `${args.bind}:${args.port}`, label: 'Local' });
  }

  const payload = buildPairingPayload({
    host: hosts[0]!,
    hosts,
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
  if (!tailscaleIp && args.hosts.length === 0) {
    console.log('⚠ Tailscale not detected — advertising LAN address(es) only.');
  }
  console.log(
    `Listening on ${effectiveBind}:${args.port}  ·  Name: ${payload.name}  ·  Reachable at: ${hosts
      .map((h) => `${h}:${args.port}`)
      .join(', ')}`,
  );
  renderPairingQr(url, { silent: args.noQr && !args.pair });

  const server = await startServer({
    token,
    port: args.port,
    bind: effectiveBind,
    tailscaleIp,
    pairingUrl: url,
    machineName: payload.name,
    pairingAddresses: addresses,
  });
  console.log(`HTTP server ready on http://${args.bind}:${server.port}`);
  console.log(`Pairing page (scan a crisp QR here): http://localhost:${server.port}/`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down…`);
    await server.close();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  releaseLock();
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logError(`fatal: ${message}`);
  console.error('fatal:', message);
  process.exit(1);
});
