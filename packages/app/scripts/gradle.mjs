// Run the Android Gradle wrapper, cross-platform.
//
// The build scripts used to call `cd android && ./gradlew …`, which is a POSIX
// path that cmd.exe can't execute — so the documented local-APK command simply
// didn't work on Windows. This picks gradlew.bat vs ./gradlew, and fills in the
// two environment variables the Android toolchain needs when they aren't
// already set, rather than failing with Gradle's rather opaque complaints
// about a missing SDK.
//
// Usage: node scripts/gradle.mjs assembleRelease

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const isWin = process.platform === 'win32';
const here = dirname(fileURLToPath(import.meta.url));
const androidDir = join(here, '..', 'android');

if (!existsSync(androidDir)) {
  console.error(
    `No android/ directory at ${androidDir}.\n` +
      'Run `pnpm --filter @pilot/app prebuild:android` first (the build:android:* scripts do this for you).',
  );
  process.exit(1);
}

/** First existing path from a list of candidates. */
function firstExisting(candidates) {
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

// Android Studio bundles a JDK (JBR). Per TROUBLESHOOTING §5 that's the
// supported way to build this project — JDK 21 builds Expo 51 fine, whereas a
// bare `java` on PATH may be far newer than the Android Gradle Plugin accepts.
function resolveJavaHome() {
  if (process.env['JAVA_HOME']) return process.env['JAVA_HOME'];
  return firstExisting(
    isWin
      ? [
          join(
            process.env['ProgramFiles'] ?? 'C:\\Program Files',
            'Android',
            'Android Studio',
            'jbr',
          ),
          join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Android Studio', 'jbr'),
        ]
      : [
          '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
          join(
            process.env['HOME'] ?? '',
            'Applications/Android Studio.app/Contents/jbr/Contents/Home',
          ),
        ],
  );
}

function resolveAndroidHome() {
  if (process.env['ANDROID_HOME']) return process.env['ANDROID_HOME'];
  if (process.env['ANDROID_SDK_ROOT']) return process.env['ANDROID_SDK_ROOT'];
  return firstExisting(
    isWin
      ? [join(process.env['LOCALAPPDATA'] ?? '', 'Android', 'Sdk')]
      : [
          join(process.env['HOME'] ?? '', 'Library/Android/sdk'),
          join(process.env['HOME'] ?? '', 'Android/Sdk'),
        ],
  );
}

const javaHome = resolveJavaHome();
const androidHome = resolveAndroidHome();

if (!androidHome) {
  console.error(
    'Could not find the Android SDK. Install it via Android Studio, or set ANDROID_HOME.',
  );
  process.exit(1);
}
if (!javaHome) {
  console.error(
    'Could not find a JDK. Install Android Studio (it bundles one), or set JAVA_HOME.',
  );
  process.exit(1);
}

console.log(`[pilot] JAVA_HOME    ${javaHome}`);
console.log(`[pilot] ANDROID_HOME ${androidHome}`);

const wrapper = join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');
const child = spawn(wrapper, process.argv.slice(2), {
  cwd: androidDir,
  stdio: 'inherit',
  env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome },
  // gradlew.bat is a batch file; cmd.exe has to interpret it.
  shell: isWin,
});

child.on('error', (err) => {
  console.error(`[pilot] could not run ${wrapper}: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
