// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/** @type {import('eslint').LinterConfig[]} */
export default [
  // Global ignores
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/*.config.{js,mjs,cjs}',
    ],
  },

  // Base JS recommended rules everywhere
  js.configs.recommended,

  // TypeScript recommended rules spread (flat config has no `extends`)
  ...tseslint.configs.recommended,

  // Server-side packages (Node globals)
  {
    files: ['packages/shared/**/*.ts', 'packages/cli/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Cloudflare Worker runtime — Worker globals (Request/Response/fetch/
  // crypto/caches/URL/Headers) instead of Node's `process`/`Buffer`.
  {
    files: ['packages/get-site/src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Worker runtime types
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        URLPattern: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        crypto: 'readonly',
        Crypto: 'readonly',
        SubtleCrypto: 'readonly',
        Cache: 'readonly',
        CacheStorage: 'readonly',
        ExecutionContext: 'readonly',
        ExportedHandler: 'readonly',
        // Service Worker event handlers (only used by scheduled workers,
        // but harmless to expose here)
        addEventListener: 'readonly',
        Event: 'readonly',
        ExtendableEvent: 'readonly',
        ScheduledEvent: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Repo tooling scripts (Node globals) — matches the top-level scripts/
  // folder AND any package-local scripts/ folder (e.g. the Cloudflare Worker
  // bundle generator at packages/get-site/scripts/).
  {
    files: [
      'scripts/**/*.{js,mjs,cjs}',
      'packages/*/scripts/**/*.{js,mjs,cjs}',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Desktop Electron main process (CommonJS, Node globals)
  {
    files: ['packages/desktop/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Desktop Electron renderer (browser globals — runs in a sandboxed
  // BrowserWindow, no Node, no modules). Terminal/FitAddon come from the
  // vendored xterm.js UMD bundles loaded via <script> before app.js.
  {
    files: ['packages/desktop/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, Terminal: 'readonly', FitAddon: 'readonly' },
    },
  },

  // React Native / Expo (browser globals + JSX)
  {
    files: ['packages/app/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Prettier last — disables conflicting style rules
  prettier,
];
