// Regenerate packages/app/src/vendor/xterm-assets.ts from the installed
// @xterm packages.
//
// Why the terminal's assets are baked into the JS bundle rather than fetched:
// the WebView used to pull xterm.js and xterm.css from jsDelivr at load time,
// so a phone without public internet got a render-blocking stylesheet that
// never arrived — a white screen and no terminal, even though the daemon it
// was talking to was one hop away on the LAN. A terminal for a machine on your
// own network has no business needing a CDN.
//
// Metro can't import .js/.css as text, so the bytes are emitted as TS string
// constants. Run after bumping either @xterm dependency:
//   pnpm --filter @pilot/app vendor:xterm

import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'src', 'vendor', 'xterm-assets.ts');

/** Resolve a file inside an installed package. */
function readPackageFile(pkg, relPath) {
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return readFileSync(join(dirname(pkgJson), relPath), 'utf8');
}

function versionOf(pkg) {
  return JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), 'utf8')).version;
}

const xtermCss = readPackageFile('@xterm/xterm', 'css/xterm.css');
const xtermJs = readPackageFile('@xterm/xterm', 'lib/xterm.js');
const fitJs = readPackageFile('@xterm/addon-fit', 'lib/addon-fit.js');

const xtermVersion = versionOf('@xterm/xterm');
const fitVersion = versionOf('@xterm/addon-fit');

const banner = `// GENERATED — do not edit. Run \`pnpm --filter @pilot/app vendor:xterm\`.
//
// Vendored from @xterm/xterm@${xtermVersion} and @xterm/addon-fit@${fitVersion}
// so the terminal WebView renders with no network access beyond the daemon
// itself. Both are UMD builds: xterm.js assigns its exports onto globalThis
// (window.Terminal) and addon-fit sets window.FitAddon.
/* eslint-disable */
`;

const body = [
  `export const XTERM_CSS = ${JSON.stringify(xtermCss)};`,
  `export const XTERM_JS = ${JSON.stringify(xtermJs)};`,
  `export const FIT_ADDON_JS = ${JSON.stringify(fitJs)};`,
].join('\n\n');

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${banner}\n${body}\n`, 'utf8');

const kb = (s) => `${Math.round(s.length / 1024)} KB`;
console.log(`wrote ${outFile}`);
console.log(`  xterm.css     ${kb(xtermCss)}`);
console.log(`  xterm.js      ${kb(xtermJs)}  (@xterm/xterm@${xtermVersion})`);
console.log(`  addon-fit.js  ${kb(fitJs)}  (@xterm/addon-fit@${fitVersion})`);
