// Local entry point. The default `expo/AppEntry` does `import App from
// '../../App'`, a path relative to the expo package — which breaks under
// pnpm where expo resolves into .pnpm/. Registering the root component from a
// file inside this package keeps the App import local and monorepo-safe.
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
