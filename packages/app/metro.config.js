// Expo Metro config — tell Metro to watch the whole monorepo so it can resolve
// `packages/*` symlinked via pnpm workspaces. Without this, Metro will only
// watch `packages/app/node_modules` and fail to find `@pilot/shared`.
//
// Reference: https://docs.expo.dev/guides/monorepos/

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo
config.watchFolders = [workspaceRoot];

// 1. Prevent Metro from scanning every file in the monorepo for changes.
//    We only care about files inside our app + workspace packages.
config.resolver = config.resolver ?? {};
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 2. Make sure Metro picks up the sibling `packages/*` directories.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
