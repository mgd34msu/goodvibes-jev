import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

const runtimeNeutralEntries = [
  'contracts/dist/index.js',
  'errors/dist/index.js',
  'operator-sdk/dist/index.js',
  'peer-sdk/dist/index.js',
  'sdk/dist/index.js',
  'sdk/dist/browser.js',
  'sdk/dist/browser-homeassistant.js',
  'sdk/dist/browser-knowledge.js',
  'sdk/dist/react-native.js',
  'sdk/dist/expo.js',
  // /auth subpath is used by RN consumers for token helpers, must be node:-free
  'sdk/dist/auth.js',
  'transport-core/dist/index.js',
  'transport-http/dist/index.js',
  'transport-realtime/dist/index.js',
];

const disallowedPatterns = [
  /from ['"]node:/,
  /require\(['"]node:/,
  /from ['"]fs['"]/,
  /require\(['"]fs['"]\)/,
];

for (const relativePath of runtimeNeutralEntries) {
  const content = readFileSync(resolve(SDK_ROOT, relativePath), 'utf8');
  for (const pattern of disallowedPatterns) {
    if (pattern.test(content)) {
      throw new Error(`Runtime-neutral entry leaked a Node-only import: ${relativePath}`);
    }
  }
}

console.log('browser/runtime-neutral runtime-neutral support check passed');
