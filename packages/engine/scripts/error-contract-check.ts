import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHECKED_FILES, loadStaleServerKindReadings, staleServerKindFindings } from './stale-server-kind-readings.ts';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const requiredKinds = [
  'auth',
  'config',
  'contract',
  'network',
  'not-found',
  'protocol',
  'rate-limit',
  'service',
  'internal',
  'tool',
  'validation',
  'unknown',
] as const;

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

function* walkFiles(rel: string): Generator<string> {
  const abs = resolve(repoRoot, rel);
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules'
      || entry === 'dist'
      || entry === 'coverage'
      || entry === '.turbo'
      || entry === '.tmp'
      || entry === '.wrangler') {
      continue;
    }
    const childRel = `${rel}/${entry}`;
    const childAbs = resolve(repoRoot, childRel);
    const stat = statSync(childAbs);
    if (stat.isDirectory()) {
      yield* walkFiles(childRel);
      continue;
    }
    if (stat.isFile()) yield childRel;
  }
}

function fail(message: string): never {
  console.error(`error-contract-check: ${message}`);
  process.exit(1);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function extractSdkErrorKindUnion(source: string): string {
  const match = source.match(/export\s+type\s+SDKErrorKind\s*=\s*([\s\S]*?);/);
  assert(match, 'errors/src/index.ts must export SDKErrorKind');
  const union = match[1];
  assert(union !== undefined, 'SDKErrorKind export matched but its union body did not capture');
  return union;
}

function assertErrorKindContract(): void {
  const source = read('errors/src/index.ts');
  const union = extractSdkErrorKindUnion(source);

  for (const kind of requiredKinds) {
    assert(
      union.includes(`'${kind}'`) || union.includes(`"${kind}"`),
      `SDKErrorKind is missing '${kind}'`,
    );
  }
  assert(!union.includes("'server'") && !union.includes('"server"'), "SDKErrorKind must not include stale 'server'");

  for (const kind of ['service', 'protocol', 'internal', 'tool'] as const) {
    assert(
      new RegExp(`return\\s+['"]${kind}['"]`).test(source),
      `inferKind must preserve '${kind}' instead of collapsing it`,
    );
  }
}

async function fileContainsPattern(rel: string, pattern: RegExp): Promise<boolean> {
  const stream = createReadStream(resolve(repoRoot, rel), { encoding: 'utf8', highWaterMark: 16_384 });
  let carry = '';
  for await (const chunk of stream) {
    const text = carry + chunk;
    if (pattern.test(text)) return true;
    carry = text.slice(-512);
  }
  return false;
}

async function assertRetryContract(): Promise<void> {
  const errorsSource = read('errors/src/index.ts');
  // The literal list lives in failure-transience.ts since 95c1e56 made it the
  // one list the transience decision and the retry policy share; the errors
  // package's index exports it as RETRYABLE_STATUS_CODES. Both files are the
  // errors package, which is what this contract requires to own the list.
  const transienceSource = read('errors/src/failure-transience.ts');
  const sdkTypesSource = read('sdk/src/platform/types/errors.ts');
  const transportRetrySource = read('transport-http/src/retry.ts');
  const retryLiteralPattern = new RegExp(String.raw`\[\s*408,\s*429,\s*500,\s*502,\s*503,\s*504\s*\]`);
  const retryLiteralAllowedFiles = new Set([
    'errors/src/failure-transience.ts',
    'scripts/error-contract-check.ts',
    'test/error-kind.test.ts',
  ]);

  assert(
    /export\s+const\s+TRANSIENT_STATUS_CODES\s*:\s*readonly\s+number\[\]\s*=\s*\[\s*408,\s*429,\s*500,\s*502,\s*503,\s*504\s*\]/.test(transienceSource)
      && /export\s+const\s+RETRYABLE_STATUS_CODES\s*:\s*readonly\s+number\[\]\s*=\s*TRANSIENT_STATUS_CODES\s*;/.test(errorsSource),
    'errors must own the canonical retryable status list (failure-transience.ts, exported by errors/src/index.ts as RETRYABLE_STATUS_CODES)',
  );
  const canonicalRetryImport = /import\s*\{[^}]*\bRETRYABLE_STATUS_CODES\b[^}]*\}\s*from\s*'@goodvibes-jev\/engine\/errors'/;
  assert(
    canonicalRetryImport.test(sdkTypesSource),
    'SDK platform errors must import the canonical retryable status list',
  );
  assert(
    canonicalRetryImport.test(transportRetrySource),
    'transport-http retry policy must import the canonical retryable status list',
  );
  // The old packages are the engine's top-level package directories.
  const packageRoots = [
    'contracts', 'daemon-sdk', 'errors', 'operator-sdk', 'peer-sdk', 'sdk',
    'terminal-shell', 'toolchain', 'transport-core', 'transport-http', 'transport-realtime',
  ];
  for (const root of [...packageRoots, 'scripts', 'test', 'examples']) {
    for (const rel of walkFiles(root)) {
      if (retryLiteralAllowedFiles.has(rel)) continue;
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) continue;
      if (await fileContainsPattern(rel, retryLiteralPattern)) {
        fail(`${rel} must import RETRYABLE_STATUS_CODES instead of inlining the canonical retryable status list`);
      }
    }
  }
}

/**
 * The consumer-facing error docs and worker tests must not present 'server'
 * as an error kind. Whether a file does is read through Jev
 * (`errors.stale-server-kind`) by `bun run error-kinds:read` and stored per
 * file content in etc/stale-server-kind-readings.json; this check is offline
 * and passes only a settled no for each file's current text.
 */
function assertNoStaleServerKindDocs(): void {
  const findings = staleServerKindFindings(repoRoot, CHECKED_FILES, loadStaleServerKindReadings());
  if (findings.length > 0) fail(findings.join('\nerror-contract-check: '));

}

assertErrorKindContract();
await assertRetryContract();
assertNoStaleServerKindDocs();
console.log('error-contract-check: OK');
