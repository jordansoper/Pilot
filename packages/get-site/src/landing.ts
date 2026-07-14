import {
  INSTALL_SH_BYTES,
  INSTALL_SH_SHA256,
} from './install-bundled.js';
import { htmlCacheHeaders } from './cache.js';

/**
 * Tiny, dependency-free landing page. Serves at GET / so visitors who
 * type `pilot.remarkablenerds.com` directly into a browser see something useful — the
 * curl one-liner, an OS matrix, and a copy button. No JS frameworks, no
 * analytics, ~3 KB transferred gzipped.
 *
 * Important: don't render install.sh content into the HTML — it would
 * break for any user who visits / via curl/pipe. The script only renders
 * derived metadata (size, sha256 prefix).
 */
function render(): string {
  const sizeKb = (INSTALL_SH_BYTES / 1024).toFixed(1);
  const shortSha = `${INSTALL_SH_SHA256.slice(0, 10)}…`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0b1020" />
  <meta name="color-scheme" content="dark light" />
  <meta name="description" content="Pilot — pair your phone with your dev machines, then run AI CLIs from anywhere over Tailscale." />
  <meta property="og:title" content="pilot.remarkablenerds.com — Pilot installer" />
  <meta property="og:description" content="One-liner install for Pilot on Linux." />
  <meta property="og:url" content="https://pilot.remarkablenerds.com/" />
  <title>pilot.remarkablenerds.com — Pilot installer</title>
  <link rel="canonical" href="https://pilot.remarkablenerds.com/" />
  <style>
    :root {
      --bg: #0b1020;
      --bg-elev: rgba(255, 255, 255, 0.04);
      --bg-elev-2: rgba(255, 255, 255, 0.07);
      --border: rgba(255, 255, 255, 0.12);
      --border-strong: rgba(255, 255, 255, 0.22);
      --text: #e7ebf3;
      --muted: #98a2b3;
      --accent: #6ea8ff;
      --accent-strong: #4f87ff;
      --good: #2dd4bf;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f7f8fb;
        --bg-elev: rgba(0, 0, 0, 0.03);
        --bg-elev-2: rgba(0, 0, 0, 0.05);
        --border: rgba(0, 0, 0, 0.08);
        --border-strong: rgba(0, 0, 0, 0.16);
        --text: #0b1020;
        --muted: #4b5565;
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: radial-gradient(1100px 500px at 50% -180px, rgba(110, 168, 255, 0.22), transparent 70%) var(--bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.5;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main {
      width: 100%;
      max-width: 720px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 28px 28px 24px;
      backdrop-filter: blur(8px);
      box-shadow: 0 1px 0 var(--border-strong) inset, 0 30px 60px -40px rgba(0, 0, 0, 0.35);
    }
    h1 {
      font-size: 28px;
      letter-spacing: -0.02em;
      margin: 0 0 4px;
    }
    .tagline { color: var(--muted); margin: 0 0 22px; font-size: 15px; }
    .install {
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 12px 12px 16px;
      font-family: var(--mono);
      font-size: 14px;
      overflow-x: auto;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .install code { white-space: nowrap; }
    .copy {
      margin-left: auto;
      flex-shrink: 0;
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      padding: 6px 10px;
      font: 500 12px var(--sans);
      cursor: pointer;
      transition: color .15s ease, border-color .15s ease, background .15s ease;
    }
    .copy:hover { color: var(--text); background: var(--bg-elev-2); }
    .copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .copy[data-copied="true"] { color: var(--good); border-color: var(--good); }
    .matrix {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 10px 16px;
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      font-size: 13px;
      color: var(--muted);
    }
    .matrix dt { font-weight: 500; color: var(--text); }
    .matrix dd { margin: 0; font-family: var(--mono); }
    .matrix .todo { color: var(--muted); font-family: var(--sans); margin-left: 6px; }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .badge {
      font-size: 12px;
      color: var(--muted);
      border: 1px solid var(--border-strong);
      padding: 3px 8px;
      border-radius: 999px;
      font-family: var(--mono);
    }
    .badge a { color: var(--accent); text-decoration: none; }
    .badge a:hover { text-decoration: underline; }
    .warn {
      margin-top: 18px;
      padding: 10px 12px;
      font-size: 13px;
      color: var(--muted);
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .warn b { color: var(--text); font-weight: 600; }
    code { font-family: var(--mono); }
  </style>
</head>
<body>
  <main>
    <h1>Pilot</h1>
    <p class="tagline">Pair your phone with dev machines. Run AI CLIs from anywhere over Tailscale.</p>

    <div class="install" role="group" aria-label="Install command">
      <code id="cmd">curl -fsSL https://pilot.remarkablenerds.com/install.sh | bash</code>
      <button class="copy" type="button" id="copy" aria-label="Copy install command">Copy</button>
    </div>

    <dl class="matrix">
      <dt>Linux</dt>
      <dd><code>curl -fsSL https://pilot.remarkablenerds.com/install.sh | bash</code></dd>
      <dt>macOS</dt>
      <dd><code>brew install jordansoper/pilot/pilot</code><span class="todo">(soon)</span></dd>
      <dt>Windows</dt>
      <dd><code>iwr -useb https://pilot.remarkablenerds.com/install.ps1 | iex</code><span class="todo">(soon)</span></dd>
    </dl>

    <div class="badges">
      <span class="badge">${sizeKb} KB</span>
      <span class="badge">sha256 ${shortSha}</span>
      <span class="badge"><a href="https://github.com/jordansoper/Pilot">GitHub →</a></span>
    </div>

    <p class="warn">
      <b>Heads up:</b> install.sh clones to <code>~/.local/share/pilot</code>, builds the
      daemon, and registers it as a <code>systemd --user</code> service.
      Inspect it first if you want: <a href="/install.sh" style="color: var(--accent);">/install.sh</a>.
    </p>
  </main>
  <script>
    const btn = document.getElementById('copy');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(document.getElementById('cmd').textContent.trim());
        btn.dataset.copied = 'true';
        btn.textContent = 'Copied';
        setTimeout(() => { btn.dataset.copied = 'false'; btn.textContent = 'Copy'; }, 1500);
      } catch {
        btn.textContent = 'Press ⌘C';
      }
    });
  </script>
</body>
</html>`;
}

export function getLandingPage(): Response {
  return new Response(render(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...htmlCacheHeaders(),
    },
  });
}
