/** Playwright imports fixture helpers under Node; Bun-only behavior must not leak in. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_TEMP_ROOT, REPO_ROOT } from './helpers/project-temp';

const helperUrl = new URL('./helpers/project-temp.ts', import.meta.url);

/** Preserve original module URLs without requiring Node 22.6+ native type stripping. */
function nodeTypeScriptPreload(urls: readonly URL[]): string {
  const sources = Object.fromEntries(urls.map(url => [url.href, transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, removeComments: true },
  }).outputText]));
  const loader = `
    const sources = ${JSON.stringify(sources)};
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && context.parentURL) {
        const url = new URL(specifier, context.parentURL).href;
        const typed = url.endsWith('.ts') ? url : url + '.ts';
        if (Object.hasOwn(sources, typed)) return { url: typed, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (!Object.hasOwn(sources, url)) return nextLoad(url, context);
      return { format: 'module', source: sources[url], shortCircuit: true };
    }
  `;
  const preload = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});`;
  return `data:text/javascript,${encodeURIComponent(preload)}`;
}

function runNode(urls: readonly URL[], program: string): unknown {
  const result = spawnSync('node', ['--import', nodeTypeScriptPreload(urls), '--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(`Node fixture failed (${String(result.status)}): ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown;
}

test('Node and Bun root the terminal-theme fixture in the same owned temp directory', () => {
  const proof = runNode([helperUrl], `
    import { REPO_ROOT, PROJECT_TEMP_ROOT, KNOWN_TEMP_PREFIXES, makeProjectTempDir } from ${JSON.stringify(helperUrl.href)};
    const directory = makeProjectTempDir('webui-terminal-theme-');
    console.log(JSON.stringify({ root: REPO_ROOT, temp: PROJECT_TEMP_ROOT, directory, swept: KNOWN_TEMP_PREFIXES.includes('webui-terminal-theme-') }));
  `) as { root: string; temp: string; directory: string; swept: boolean };
  expect(proof.root).toBe(REPO_ROOT);
  expect(proof.root).toBe(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  expect(proof.temp).toBe(PROJECT_TEMP_ROOT);
  expect(proof.directory.startsWith(PROJECT_TEMP_ROOT + sep + 'webui-terminal-theme-')).toBe(true);
  expect(proof.swept).toBe(true);
  expect(existsSync(proof.directory)).toBe(false); // Node's registered exit cleanup ran.
});

test('the browser fixture constructs and runs real config routes under Node without a socket', () => {
  const hostUrl = new URL('../e2e/support/terminal-theme-host.ts', import.meta.url);
  const proof = runNode([helperUrl, hostUrl], `
    import { createTerminalThemeHost, themeConfigRequest } from ${JSON.stringify(hostUrl.href)};
    const host = createTerminalThemeHost('vaporwave');
    try {
      const read = await host.dispatch(themeConfigRequest('GET'));
      const theme = (await read.json()).display.theme;
      const accepted = await host.dispatch(themeConfigRequest('POST', { key: 'display.theme', value: 'nord' }));
      const receipt = await accepted.json();
      const rejected = await host.dispatch(themeConfigRequest('POST', { key: 'display.theme', value: 'not-a-theme' }));
      const failure = await rejected.json();
      host.reload();
      console.log(JSON.stringify({ root: host.root, theme, statuses: [read.status, accepted.status, rejected.status],
        receipt, failure, persisted: host.persisted(), reloaded: host.manager.get('display.theme') }));
    } finally { host.cleanup(); }
  `) as { root: string; theme: string; statuses: number[]; receipt: unknown; failure: unknown; persisted: unknown; reloaded: string };
  expect(proof.statuses).toEqual([200, 200, 400]);
  expect(proof.theme).toBe('vaporwave');
  expect(proof.receipt).toMatchObject({ success: true, key: 'display.theme', value: 'nord', daemonOwned: false });
  expect(proof.failure).toHaveProperty('error');
  expect(proof.persisted).toMatchObject({ display: { theme: 'nord', themeMode: 'light' } });
  expect(proof.reloaded).toBe('nord');
  expect(proof.root.startsWith(PROJECT_TEMP_ROOT + sep + 'webui-terminal-theme-')).toBe(true);
  expect(existsSync(proof.root)).toBe(false);
});

test('the Node browser fixture refuses settings envelopes without invoking the legacy writer', () => {
  const hostUrl = new URL('../e2e/support/terminal-theme-host.ts', import.meta.url);
  const proof = runNode([helperUrl, hostUrl], `
    import { existsSync, readFileSync } from 'node:fs';
    import { createTerminalThemeHost, themeConfigRequest } from ${JSON.stringify(hostUrl.href)};
    const host = createTerminalThemeHost('vaporwave');
    try {
      const before = readFileSync(host.settingsPath, 'utf8');
      const originalWrite = host.manager.setDynamic.bind(host.manager);
      let writes = 0;
      host.manager.setDynamic = (...args) => { writes++; return originalWrite(...args); };
      const replies = [];
      for (const settingsPrecondition of [
        { version: 1, action: 'capture', operation: 'set', key: 'display.theme', value: 'nord' },
        { version: 1, action: 'apply', reference: 'unissued-terminal-theme-reference' },
      ]) {
        for (const legacy of [{}, { key: 'display.theme', value: 'nord' }]) {
          const response = await host.dispatch(themeConfigRequest('POST', { ...legacy, settingsPrecondition }));
          replies.push({ status: response.status, code: (await response.json()).code });
        }
      }
      host.reload();
      console.log(JSON.stringify({ root: host.root, replies, writes,
        unchanged: readFileSync(host.settingsPath, 'utf8') === before,
        daemonFile: existsSync(host.daemonTierPath), theme: host.manager.get('display.theme') }));
    } finally { host.cleanup(); }
  `) as { root: string; replies: { status: number; code: string }[]; writes: number; unchanged: boolean; daemonFile: boolean; theme: string };
  expect(proof.replies).toEqual(Array.from({ length: 4 }, () => ({ status: 409, code: 'SETTINGS_PRECONDITION_UNSUPPORTED' })));
  expect(proof.writes).toBe(0);
  expect(proof.unchanged).toBe(true);
  expect(proof.daemonFile).toBe(false);
  expect(proof.theme).toBe('vaporwave');
  expect(existsSync(proof.root)).toBe(false);
});
