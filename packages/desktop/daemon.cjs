// Pilot desktop — daemon entry point.
//
// Forked by the Electron main process via child_process.fork(), so it shares
// Electron's Node ABI (node-pty works without system Node). Communicates with
// the parent via IPC: sends { type:'ready', port, pairingUrl } on startup,
// and { type:'log', level, message } for stdout forwarding.
//
// Receives config via process.env:
//   PILOT_PORT, PILOT_BIND, PILOT_NAME, PILOT_CLI_DIST, PILOT_SHARED_DIST

'use strict';

const { hostname } = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Resolve CLI and shared dist paths.
function resolveDist(envKey, fallbackRel) {
  if (process.env[envKey]) return process.env[envKey];
  // In dev mode, the daemon is at packages/desktop/daemon.cjs,
  // so __dirname = packages/desktop/. The fallback goes up one level.
  return path.join(__dirname, fallbackRel);
}

async function main() {
  const cliDist = resolveDist('PILOT_CLI_DIST', '..', 'cli', 'dist');
  const sharedDist = resolveDist('PILOT_SHARED_DIST', '..', 'shared', 'dist');

  const port = parseInt(process.env.PILOT_PORT || '7117', 10);
  const bind = process.env.PILOT_BIND || '0.0.0.0';
  const name = process.env.PILOT_NAME || hostname();

  // ── Module resolution setup ───────────────────────────────────────────
  // In the packaged app, npm packages (ws, zod, qrcode) live inside
  // app.asar, but the forked daemon process uses plain Node.js resolution
  // which can't see inside asar files. We use asarUnpack to place copies
  // at app.asar.unpacked/node_modules/ and symlink them into cli-dist so
  // the CLI's ESM imports resolve correctly.
  function ensureModuleResolution() {
    const nmPilot = path.join(cliDist, 'node_modules', '@pilot');
    const sharedLink = path.join(nmPilot, 'shared');

    // If @pilot/shared is already resolvable globally (dev mode), skip.
    try {
      require.resolve('@pilot/shared');
    } catch {
      // Production: create node_modules/@pilot/shared → sharedDist symlink.
      if (!fs.existsSync(sharedLink)) {
        try {
          fs.mkdirSync(nmPilot, { recursive: true });
          fs.symlinkSync(sharedDist, sharedLink, 'dir');
        } catch (err) {
          process.stderr.write(
            `[daemon] could not symlink @pilot/shared: ${err instanceof Error ? err.message : err}\n`,
          );
        }
      }
    }

    // Production: symlink the full unpacked node_modules so the forked
    // Node process (which can't see inside app.asar) can resolve all deps.
    const asarUnpackedNm = path.join(path.dirname(cliDist), 'app.asar.unpacked', 'node_modules');
    if (fs.existsSync(asarUnpackedNm)) {
      const cliNm = path.join(cliDist, 'node_modules');
      if (!fs.existsSync(cliNm)) {
        try {
          fs.mkdirSync(path.dirname(cliNm), { recursive: true });
          fs.symlinkSync(asarUnpackedNm, cliNm, 'dir');
        } catch (err) {
          process.stderr.write(
            `[daemon] could not symlink node_modules: ${err instanceof Error ? err.message : err}\n`,
          );
        }
      }
    }

    // Ensure the shared dist has a package.json so it's recognized as a module.
    const sharedPkgJson = path.join(sharedDist, 'package.json');
    if (!fs.existsSync(sharedPkgJson)) {
      fs.writeFileSync(
        sharedPkgJson,
        JSON.stringify({ name: '@pilot/shared', type: 'module', main: './index.js' }),
        'utf8',
      );
    }

    // Ensure the CLI dist has a package.json with type:module so Node
    // treats its .js files (which use ESM import/export) as ES modules.
    const cliPkgJson = path.join(cliDist, 'package.json');
    if (!fs.existsSync(cliPkgJson)) {
      fs.writeFileSync(
        cliPkgJson,
        JSON.stringify({ type: 'module' }),
        'utf8',
      );
    }
  }

  ensureModuleResolution();

  // ── Import CLI modules (all ESM) ──────────────────────────────────────

  const serverModule = await import(path.join(cliDist, 'server.js'));
  const tailscaleModule = await import(path.join(cliDist, 'tailscale.js'));
  const networkModule = await import(path.join(cliDist, 'network.js'));
  const tokenModule = await import(path.join(cliDist, 'token.js'));
  const pairingModule = await import(path.join(cliDist, 'pairing.js'));
  const sharedModule = await import(path.join(sharedDist, 'index.js'));

  const { startServer } = serverModule;
  const { getTailscaleIp } = tailscaleModule;
  const { getLanIpv4s } = networkModule;
  const { loadOrCreateToken } = tokenModule;
  const { buildPairingPayload, buildPairingUrl } = pairingModule;
  const { SHARED_PACKAGE_VERSION, PROTOCOL_VERSION } = sharedModule;

  // ── Startup ───────────────────────────────────────────────────────────

  const tokenResult = loadOrCreateToken({ rotate: false });
  const tailscaleIp = await getTailscaleIp();

  // Build pairing addresses.
  const addresses = [];
  if (tailscaleIp) {
    addresses.push({ address: `${tailscaleIp}:${port}`, label: 'Tailscale — anywhere' });
  }
  for (const lan of getLanIpv4s()) {
    addresses.push({ address: `${lan.address}:${port}`, label: `Local network (${lan.iface}) — same Wi-Fi` });
  }
  if (addresses.length === 0) {
    addresses.push({ address: `${bind}:${port}`, label: 'Local' });
  }

  const hosts = [...(tailscaleIp ? [tailscaleIp] : []), ...getLanIpv4s().map((l) => l.address)];
  if (hosts.length === 0) hosts.push(bind);

  const payload = buildPairingPayload({ host: hosts[0], hosts, port, token: tokenResult.token, name });
  const pairingUrl = buildPairingUrl(payload);

  // Forward logs to parent.
  function log(level, message) {
    if (process.send) process.send({ type: 'log', level, message });
    // Also write to stderr so it's visible in dev.
    if (level === 'error') process.stderr.write(`[daemon] ${message}\n`);
  }

  log('info', `pilot-cli v${SHARED_PACKAGE_VERSION} (protocol v${PROTOCOL_VERSION})`);
  log(
    'info',
    tokenResult.created
      ? `Token: new token written to ${tokenResult.path}`
      : `Token: reusing ${tokenResult.path}`,
  );
  if (!tailscaleIp) {
    log('warn', 'Tailscale not detected — advertising LAN address(es) only.');
  }
  log('info', `Listening on ${bind}:${port}  ·  Name: ${payload.name}`);

  // ── Start server ──────────────────────────────────────────────────────

  try {
    const server = await startServer({
      token: tokenResult.token,
      port,
      bind,
      tailscaleIp,
      pairingUrl,
      machineName: payload.name,
      pairingAddresses: addresses,
    });

    log('info', `HTTP server ready on http://${bind}:${server.port}`);
    log('info', `Pairing page: http://localhost:${server.port}/`);

    // Tell the parent we're ready.
    if (process.send) {
      process.send({ type: 'ready', port: server.port, pairingUrl });
    }

    // Handle shutdown signals from parent.
    process.on('message', (msg) => {
      if (msg && typeof msg === 'object' && msg.type === 'shutdown') {
        server.close().then(() => process.exit(0));
      }
    });

    // Forward graceful OS signals.
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('info', `Received ${signal}, shutting down…`);
      if (process.send) process.send({ type: 'exiting', signal });
      await server.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    // Keep the process alive.
    process.on('disconnect', () => {
      log('warn', 'Parent disconnected, shutting down.');
      server.close().then(() => process.exit(0));
    });
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log('error', `Failed to start server: ${message}`);
    if (process.send) process.send({ type: 'error', message });
    process.exit(1);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[daemon] fatal: ${message}\n`);
  if (process.send) process.send({ type: 'error', message });
  process.exit(1);
});
