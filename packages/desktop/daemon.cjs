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
function resolveDist(envKey, ...fallbackRel) {
  if (process.env[envKey]) return process.env[envKey];
  // In dev mode, the daemon is at packages/desktop/daemon.cjs,
  // so __dirname = packages/desktop/. The fallback goes up one level.
  return path.join(__dirname, ...fallbackRel);
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
    // Production: cli-dist sits next to app.asar.unpacked in Resources/. The
    // forked Node process can't resolve packages inside app.asar, so cli-dist
    // gets a node_modules shim pointing at a real copy of the unpacked
    // modules (Resources/node_modules). Everything here is RELATIVE and
    // self-healing: earlier builds wrote absolute links (which dangle when
    // the bundle is moved, e.g. dist → /Applications) and created
    // cli-dist/node_modules as a real dir that shadowed the unpacked modules,
    // so a shim that exists must still be verified, not trusted.
    const asarUnpackedNm = path.join(path.dirname(cliDist), 'app.asar.unpacked', 'node_modules');
    if (fs.existsSync(asarUnpackedNm)) {
      // Windows can't create symlinks without admin/Developer Mode, so shims
      // there are physical copies (matching after-pack.cjs).
      const isWin = process.platform === 'win32';

      // Packages must load from a path with NO `app.asar` segment: node-pty
      // rewrites 'app.asar' → 'app.asar.unpacked' in its own realpath to find
      // spawn-helper, which corrupts an already-unpacked path and kills every
      // PTY spawn ("posix_spawnp failed"). after-pack.cjs bakes this copy in
      // at build time; recreate it here only for bundles that predate it.
      const realNm = path.join(path.dirname(cliDist), 'node_modules');
      if (!fs.existsSync(path.join(realNm, 'node-pty'))) {
        try {
          fs.rmSync(realNm, { recursive: true, force: true });
          fs.cpSync(asarUnpackedNm, realNm, { recursive: true });
        } catch (err) {
          process.stderr.write(
            `[daemon] could not copy node_modules: ${err instanceof Error ? err.message : err}\n`,
          );
        }
      }

      // Make `@pilot/shared` importable: place it inside the modules copy
      // FIRST so the full-node_modules shims below include it.
      const nmPilot = path.join(realNm, '@pilot');
      const sharedLink = path.join(nmPilot, 'shared');
      let sharedOk = false;
      try {
        sharedOk = isWin
          ? fs.existsSync(path.join(sharedLink, 'index.js'))
          : fs.realpathSync(sharedLink) === fs.realpathSync(sharedDist);
      } catch {
        /* missing or dangling */
      }
      if (!sharedOk) {
        try {
          fs.rmSync(sharedLink, { recursive: true, force: true });
          fs.mkdirSync(nmPilot, { recursive: true });
          if (isWin) {
            fs.cpSync(sharedDist, sharedLink, { recursive: true });
          } else {
            fs.symlinkSync(path.relative(nmPilot, sharedDist), sharedLink, 'dir');
          }
        } catch (err) {
          process.stderr.write(
            `[daemon] could not shim @pilot/shared: ${err instanceof Error ? err.message : err}\n`,
          );
        }
      }

      // Both dists need the shim: ESM resolves a symlinked import to its
      // realpath, so shared-dist's own imports (zod) resolve from shared-dist,
      // not through cli-dist.
      for (const dir of [cliDist, sharedDist]) {
        const nm = path.join(dir, 'node_modules');
        let healthy = false;
        try {
          healthy = isWin
            ? fs.existsSync(path.join(nm, 'zod'))
            : fs.lstatSync(nm).isSymbolicLink() &&
              fs.realpathSync(nm) === fs.realpathSync(realNm);
        } catch {
          /* missing or dangling — recreate below */
        }
        if (!healthy) {
          try {
            fs.rmSync(nm, { recursive: true, force: true });
            if (isWin) {
              fs.cpSync(realNm, nm, { recursive: true });
            } else {
              fs.symlinkSync(path.relative(dir, realNm), nm, 'dir');
            }
          } catch (err) {
            process.stderr.write(
              `[daemon] could not shim node_modules: ${err instanceof Error ? err.message : err}\n`,
            );
          }
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

    // Graceful close, but never linger: server.close() waits for open
    // connections, and a wedged one would otherwise orphan this process
    // forever (e.g. parent force-quit while a client is attached).
    let shuttingDown = false;
    const shutdown = (why) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('info', `Shutting down (${why})…`);
      setTimeout(() => process.exit(0), 3000).unref();
      server.close().then(() => process.exit(0));
    };

    // Handle shutdown signals from parent.
    process.on('message', (msg) => {
      if (msg && typeof msg === 'object' && msg.type === 'shutdown') {
        shutdown('parent request');
      }
    });

    // Forward graceful OS signals.
    const onSignal = (signal) => {
      if (process.send && !shuttingDown) {
        try {
          process.send({ type: 'exiting', signal });
        } catch {
          /* IPC channel already closed */
        }
      }
      shutdown(signal);
    };
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));

    // Parent gone (crashed or force-quit) — never outlive it.
    process.on('disconnect', () => shutdown('parent disconnected'));
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
