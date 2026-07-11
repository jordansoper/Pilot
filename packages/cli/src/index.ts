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
import type { PairingAddress } from './pairing-page.js';
import { getTailscaleIp } from './tailscale.js';
import { getLanIpv4s } from './network.js';
import { loadOrCreateToken } from './token.js';

interface CliArgs {
  port: number;
  bind: string;
  name: string;
  noQr: boolean;
  rotateToken: boolean;
  /** Explicit host(s) to advertise in the QR, overriding auto-detection. */
  hosts: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: DEFAULT_PORT,
    bind: DEFAULT_BIND,
    name: hostname(),
    noQr: false,
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
        break;
      case '--name':
      case '-n':
        args.name = String(next());
        break;
      case '--no-qr':
        args.noQr = true;
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

Usage:
  pilot [flags]

Flags:
  --port, -p <n>   TCP port to listen on (default ${DEFAULT_PORT}, 0 = ephemeral)
  --bind, -b <ip>  IP to bind to (default ${DEFAULT_BIND})
  --name, -n <s>   Friendly machine name in the QR (default: hostname)
  --no-qr          Print pairing URL but skip the ASCII QR (for headless)
  --host <ip>      Advertise this address in the QR (repeatable). Overrides
                   auto-detection. Default: Tailscale IP + LAN IP(s), so one
                   QR works on the same Wi-Fi and remotely.
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
    `Listening on ${args.bind}:${args.port}  ·  Name: ${payload.name}  ·  Reachable at: ${hosts
      .map((h) => `${h}:${args.port}`)
      .join(', ')}`,
  );
  renderPairingQr(url, { silent: args.noQr });

  const server = await startServer({
    token,
    port: args.port,
    bind: args.bind,
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
