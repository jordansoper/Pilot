#!/usr/bin/env node
/**
 * Post-`expo prebuild` fix-ups required to build the Android app inside this
 * pnpm monorepo. `expo prebuild --clean` regenerates the native android/
 * project every time, wiping manual edits, so these patches are re-applied
 * here after each prebuild. All steps are idempotent.
 *
 * 1. settings.gradle: RN 0.74's template resolves @react-native/gradle-plugin
 *    with a bare `require.resolve(...)` that fails under pnpm (transitive dep
 *    not resolvable from android/). Rewrite it to the same paths-based form
 *    the file already uses elsewhere so both includeBuild() calls resolve to
 *    one path and Gradle doesn't error on a duplicate `:gradle-plugin` build.
 * 2. colors.xml (values and values-night): Expo's splash theme references
 *    @color/splashscreen_background but prebuild doesn't emit the color when
 *    no splash background is configured, so resource linking fails. Ensure it
 *    exists.
 *
 * See TROUBLESHOOTING.md §5.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(repoRoot, 'packages', 'app', 'android');

if (!existsSync(androidDir)) {
  console.error(`[patch-android] no android/ dir at ${androidDir} — run prebuild first`);
  process.exit(1);
}

let changed = 0;

// 1. settings.gradle — make the gradle-plugin resolve pnpm-safe.
const settingsPath = join(androidDir, 'settings.gradle');
const naive = `require.resolve('@react-native/gradle-plugin/package.json')`;
const robust = `require.resolve('@react-native/gradle-plugin/package.json', { paths: [require.resolve('react-native/package.json')] })`;
const settings = readFileSync(settingsPath, 'utf8');
if (settings.includes(naive)) {
  writeFileSync(settingsPath, settings.split(naive).join(robust));
  console.log(
    '[patch-android] settings.gradle: made @react-native/gradle-plugin resolve pnpm-safe',
  );
  changed += 1;
}

// 2. colors.xml — ensure the splash background color exists.
for (const rel of [
  'app/src/main/res/values/colors.xml',
  'app/src/main/res/values-night/colors.xml',
]) {
  const p = join(androidDir, rel);
  if (!existsSync(p)) continue;
  const xml = readFileSync(p, 'utf8');
  if (!xml.includes('splashscreen_background')) {
    writeFileSync(
      p,
      xml.replace(
        '</resources>',
        '  <color name="splashscreen_background">#ffffff</color>\n</resources>',
      ),
    );
    console.log(`[patch-android] ${rel}: added splashscreen_background color`);
    changed += 1;
  }
}

if (changed === 0) {
  console.log('[patch-android] nothing to patch (already applied)');
}
