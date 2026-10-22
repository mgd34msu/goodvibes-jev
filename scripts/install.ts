import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMANDS, PACKAGE, SERVICE, assertOwnedFiles, atomicWrite, contained, dataOwner, digest, isReleaseInUse, plainPath, present, quote, readDataId, readInstallation, receiptPath, run, stopService, unitPath, validateLayout, withLock, type Installation, type Layout, type Run } from './installation.ts';

export interface Options extends Layout { port: number; service: boolean; runtimeDir: string; nodePath?: string; workspace?: string }
const ROOT = resolve(import.meta.dir, '..');
export function parseOptions(args: string[], home = realpathSync(process.env.HOME ?? ''), runtime = {
  bunPath: process.execPath, findNode: (): string | null => Bun.which('node'),
}): Options {
  const values: Record<string, string> = {};
  let service: boolean | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--no-service') service = false;
    else if (flag === '--service') service = true;
    else if (['--prefix', '--bin-dir', '--data-dir', '--port', '--runtime-dir', '--workspace'].includes(flag) && args[i + 1] && !args[i + 1]!.startsWith('--')) values[flag] = args[++i]!;
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  const prefix = resolve(values['--prefix'] ?? join(home, '.local/share/goodvibes-jev'));
  const old = readInstallation(prefix);
  const runtimeDir = resolve(values['--runtime-dir'] ?? dirname(runtime.bunPath));
  const adjacentNode = join(runtimeDir, 'node');
  const nodePath = values['--runtime-dir'] || existsSync(adjacentNode) ? adjacentNode : resolve(runtime.findNode() ?? adjacentNode);
  const options = { home, prefix, binDir: resolve(values['--bin-dir'] ?? old?.binDir ?? join(home, '.local/bin')),
    dataDir: resolve(values['--data-dir'] ?? old?.dataDir ?? join(home, '.local/share/goodvibes-jev-data')),
    port: Number(values['--port'] ?? old?.port ?? 3421), service: service ?? old?.service ?? true,
    workspace: realpathSync(resolve(values['--workspace'] ?? old?.workspace ?? ROOT)),
    runtimeDir, nodePath };
  validateLayout(options);
  if (!statSync(options.workspace).isDirectory()) throw new Error('--workspace must name a project directory.');
  if (options.workspace === home || options.workspace === '/' || contained(options.dataDir, options.workspace) || contained(options.prefix, options.workspace)) throw new Error('--workspace must name a project directory outside installation data.');
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('--port must be an integer between 1024 and 65535.');
  if (old && (old.home !== home || old.binDir !== options.binDir || old.dataDir !== options.dataDir)) throw new Error('Keep existing command/data paths when updating, or uninstall first.');
  return options;
}
export function preflight(options: Options, old: Installation | undefined, execute: Run = run): void {
  validateLayout(options);
  if (contained(options.prefix, ROOT) || contained(ROOT, options.prefix) || contained(options.dataDir, ROOT)) throw new Error('Install programs and data outside the source checkout.');
  if (old) assertOwnedFiles(old);
  else {
    if (present(options.prefix) && readdirSync(options.prefix).length) throw new Error('Program directory is not empty and has no Jev installation receipt.');
    for (const name of COMMANDS) if (present(join(options.binDir, name))) throw new Error(`Command already exists: ${join(options.binDir, name)}. Choose --bin-dir or remove the old installation first.`);
    if (present(unitPath(options))) throw new Error(`A service already exists at ${unitPath(options)}.`);
    if (present(options.dataDir) && readdirSync(options.dataDir).length && !readDataId(options)) throw new Error('Data directory is not empty and is not owned by the Jev installer. Choose --data-dir.');
  }
  if (options.service || old?.service) {
    execute('systemctl', ['--user', 'show-environment'], { capture: true });
    const fragment = execute('systemctl', ['--user', 'show', SERVICE, '--property=FragmentPath', '--value'], { capture: true });
    if (fragment && (!old?.service || fragment !== unitPath(options))) throw new Error(`Another ${SERVICE} is already loaded.`);
  }
}
export function wrapper(options: Options, name: typeof COMMANDS[number], arch = process.arch): string {
  const current = join(options.prefix, 'current');
  const header = '#!/bin/sh\nset -eu\n# Managed by the goodvibes-jev installer.\n';
  // An update moves current. Keep each process and its admitted runtime on the
  // same physical release for its entire lifetime, including subsequent execs.
  const pinRelease = `goodvibes_release=$(CDPATH= cd ${quote(current)} && pwd -P)\n`;
  if (name === 'goodvibes-uninstall') return `${header}${pinRelease}exec "$goodvibes_release/runtime/bun" "$goodvibes_release/uninstall.js" --prefix ${quote(options.prefix)} "$@"\n`;
  const product = name === 'goodvibes' ? 'tui' : name === 'goodvibes-agent' ? 'agent' : 'daemon';
  return `${header}if [ -f ${quote(join(options.dataDir, 'environment'))} ]; then\n  set -a\n  . ${quote(join(options.dataDir, 'environment'))}\n  set +a\nfi\n${pinRelease}export GOODVIBES_HOME=${quote(options.dataDir)}\nexport GOODVIBES_DAEMON_HOME=${quote(join(options.dataDir, '.goodvibes/daemon'))}\nexport TYPESAFE_DEFAULT_MODEL=jev-latest\nexport PATH="$goodvibes_release/runtime:$PATH"\nexec "$goodvibes_release/${product}/${name}-linux-${arch}" "$@"\n`;
}
function switchRelease(prefix: string, release: string): void {
  const temporary = join(prefix, `current-${process.pid}`);
  symlinkSync(`releases/${release}`, temporary);
  try { renameSync(temporary, join(prefix, 'current')); } finally { rmSync(temporary, { force: true }); }
}
export async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((yes, no) => {
    const server = createServer();
    server.once('error', () => no(new Error(`Port ${port} is already in use. Choose --port; no other service will be stopped.`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? no(error) : yes()));
  });
}
async function ready(options: Options, html: string, execute: Run): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = execute('systemctl', ['--user', 'show', SERVICE, '--property=ActiveState', '--value'], { capture: true });
    if (state === 'failed' || state === 'inactive') throw new Error(`Daemon stopped during startup. Inspect: journalctl --user -u ${SERVICE}`);
    if (state === 'active') {
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}/`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if (response.ok && await response.text() === html) {
          const tokenPath = join(options.dataDir, '.goodvibes/daemon/operator-tokens.json');
          const tokenFile = JSON.parse(readFileSync(tokenPath, 'utf8')) as { token?: unknown };
          if (typeof tokenFile.token !== 'string') continue;
          const health = await fetch(`http://127.0.0.1:${options.port}/api/health`, {
            headers: { Authorization: `Bearer ${tokenFile.token}` }, signal: AbortSignal.timeout(1500), redirect: 'error',
          });
          const value = await health.json() as { network?: { controlPlane?: { ready?: boolean } } };
          if (health.ok && value.network?.controlPlane?.ready === true) return;
        }
      } catch { /* Listener may still be starting. */ }
    }
    await Bun.sleep(500);
  }
  throw new Error(`Daemon/WebUI did not become ready in 90 seconds. Inspect: journalctl --user -u ${SERVICE}`);
}
async function build(root: string, execute: Run): Promise<string> {
  const git = (...args: string[]) => execute('git', args, { cwd: root, capture: true });
  const commit = git('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Install from a Git checkout with an exact commit.');
  try { git('diff', '--quiet', 'HEAD'); }
  catch { throw new Error('Commit or stash tracked changes before installing, so the build matches its recorded commit.'); }
  console.log(`Building GoodVibes Jev from ${commit}...`);
  execute('bun', ['install', '--frozen-lockfile'], { cwd: root });
  execute('bun', ['packages/engine/scripts/build.ts'], { cwd: root });
  for (const [product, script] of [['daemon', 'build:binary'], ['tui', 'build'], ['agent', 'build:binary'], ['webui', 'build']]) {
    execute('bun', ['run', script!], { cwd: join(root, 'products', product!) });
  }
  if (git('rev-parse', 'HEAD') !== commit) throw new Error('Checkout changed during the build; re-run installation.');
  git('diff', '--quiet', 'HEAD');
  execute('bun', ['scripts/ci-artifact.ts', 'record', commit, commit], { cwd: join(root, 'products/daemon') });
  return commit;
}
async function stage(root: string, release: string, options: Options, commit: string, execute: Run): Promise<void> {
  const target = `linux-${process.arch}`;
  execute('bun', ['scripts/install-native.ts', 'install', '--artifact-root', join(root, 'products/daemon'), '--prefix', join(release, 'daemon'),
    '--source-commit', commit, '--head-commit', commit], { cwd: join(root, 'products/daemon') });
  for (const [product, binary] of [['tui', 'goodvibes'], ['agent', 'goodvibes-agent']]) {
    const dest = join(release, product!); mkdirSync(dest, { recursive: true });
    for (const suffix of ['', '.bun', '.bun.json', '.bun.LICENSE.md']) {
      copyFileSync(join(root, 'products', product!, 'dist', `${binary}-${target}${suffix}`), join(dest, `${binary}-${target}${suffix}`));
    }
    cpSync(join(root, 'products', product!, 'dist/lib'), join(dest, 'lib'), { recursive: true, dereference: true });
  }
  const require = createRequire(join(root, 'packages/engine/package.json'));
  const driver = dirname(require.resolve('playwright-core/package.json'));
  // The daemon and clients can all execute browser tools; each resolves beside its executable.
  for (const product of ['daemon', 'tui', 'agent']) cpSync(driver, join(release, product, 'playwright-core'), { recursive: true, dereference: true });
  cpSync(join(root, 'products/webui/dist'), join(release, 'webui'), { recursive: true, dereference: true });
  if (!existsSync(join(release, 'webui/index.html'))) throw new Error('WebUI build did not produce index.html.');
  mkdirSync(join(release, 'runtime'));
  for (const binary of ['bun', 'node']) {
    copyFileSync(binary === 'node' && options.nodePath ? options.nodePath : join(options.runtimeDir, binary), join(release, 'runtime', binary));
    chmodSync(join(release, 'runtime', binary), 0o755);
  }
  copyFileSync(join(release, 'daemon', `goodvibes-daemon-${target}.bun.LICENSE.md`), join(release, 'runtime/BUN-LICENSE.md'));
  for (const product of ['daemon', 'tui', 'agent', 'webui']) copyFileSync(join(root, 'products', product, 'LICENSE'), join(release, product, 'LICENSE'));
  execute('bun', ['build', join(ROOT, 'scripts/uninstall.ts'), '--target=bun', '--outfile', join(release, 'uninstall.js')]);
  for (const [product, binary] of [['daemon', 'goodvibes-daemon'], ['tui', 'goodvibes'], ['agent', 'goodvibes-agent']]) {
    execute(join(release, product!, `${binary}-${target}`), ['--version'], { capture: true });
  }
}
export interface InstallHooks {
  isReleaseInUse?: typeof isReleaseInUse;
  execute?: Run;
  build?: typeof build;
  stage?: typeof stage;
  ready?: typeof ready;
  renderUnit?: (options: Options) => Promise<string>;
}
export async function install(options: Options, hooks: InstallHooks = {}): Promise<void> {
  const execute = hooks.execute ?? run;
  await withLock(options.prefix, () => withLock(options.dataDir, async () => {
    const old = readInstallation(options.prefix);
    preflight(options, old, execute);
    const commit = await (hooks.build ?? build)(ROOT, execute);
    // Check again after a potentially long build, before touching live files.
    preflight(options, old, execute);
    const id = old?.id ?? readDataId(options) ?? randomUUID();
    const releaseName = `${commit}-${randomUUID()}`;
    const release = join(options.prefix, 'releases', releaseName);
    mkdirSync(release, { recursive: true, mode: 0o700 });
    let published = false;
    let stopAttempted = false;
    let wasRunning = false;
    let serviceAttempted = false;
    const settingsPaths = ['daemon', 'tui', 'shared'].map(surface => join(options.dataDir, '.goodvibes', surface, 'settings.json'));
    const metadataPaths = [dataOwner(options), join(options.dataDir, 'environment')];
    const previousMetadata = new Map(metadataPaths.map(path => { plainPath(path); return [path, present(path) ? readFileSync(path, 'utf8') : undefined] as const; }));
    let metadataTouched = false;
    const previousSettings = new Map<string, string | undefined>();
    const previousUnit = present(unitPath(options)) ? readFileSync(unitPath(options), 'utf8') : undefined;
    const previousWrappers = new Map(COMMANDS.map(name => [name, old && present(join(options.prefix, 'commands', name)) ? readFileSync(join(options.prefix, 'commands', name), 'utf8') : undefined]));
    try {
      await (hooks.stage ?? stage)(ROOT, release, options, commit, execute);
      let unit = '';
      if (options.service) {
        unit = hooks.renderUnit ? await hooks.renderUnit(options) : (await import(pathToFileURL(join(ROOT, 'packages/engine/sdk/src/platform/daemon/service-manager.ts')).href)).renderSystemdUnit({
          name: 'goodvibes-jev', description: 'GoodVibes Jev daemon and WebUI', workingDirectory: options.workspace ?? ROOT,
          command: join(options.prefix, 'commands/goodvibes-daemon'), args: ['serve', '--hostname', '127.0.0.1', '--port', String(options.port)], env: {}, restartOnFailure: true });
      }
      if (old?.service) {
        const state = execute('systemctl', ['--user', 'show', SERVICE, '--property=ActiveState', '--value'], { capture: true });
        wasRunning = !['inactive', 'failed'].includes(state);
        stopAttempted = true;
        stopService(old, execute);
      }
      if (options.service) await assertPortFree(options.port);
      for (const path of settingsPaths) {
        plainPath(path); previousSettings.set(path, present(path) ? readFileSync(path, 'utf8') : undefined);
      }
      mkdirSync(options.dataDir, { recursive: true, mode: 0o700 }); chmodSync(options.dataDir, 0o700);
      metadataTouched = true;
      atomicWrite(dataOwner(options), JSON.stringify({ package: PACKAGE, id, dataDir: options.dataDir, prefix: options.prefix }) + '\n');
      const environment = join(options.dataDir, 'environment'); plainPath(environment);
      if (!present(environment)) {
        // TYPESAFE_API_KEY is classified daemon-needed by credential-scope-registry.ts.
        const key = process.env.TYPESAFE_API_KEY;
        if (key?.includes('\n') || key?.includes('\r') || key?.includes('\0')) throw new Error('TYPESAFE_API_KEY must be a single line.');
        atomicWrite(environment, '# Private shell environment for GoodVibes Jev.\n' + (key ? `TYPESAFE_API_KEY=${quote(key)}\n` : '# TYPESAFE_API_KEY=your-key\n'));
      }
      switchRelease(options.prefix, releaseName); published = true;
      const wrappers: Record<string, string> = {};
      mkdirSync(options.binDir, { recursive: true });
      for (const name of COMMANDS) {
        const contents = wrapper(options, name); wrappers[name] = digest(contents);
        atomicWrite(join(options.prefix, 'commands', name), contents, 0o755);
        const link = join(options.binDir, name);
        if (!present(link)) symlinkSync(join(options.prefix, 'commands', name), link);
      }
      const daemon = join(options.prefix, 'commands/goodvibes-daemon');
      execute(daemon, ['config', 'set', 'judgment.model', 'jev-latest'], { cwd: options.dataDir, capture: true });
      execute(daemon, ['config', 'set', 'controlPlane.port', String(options.port)], { cwd: options.dataDir, capture: true });
      execute(daemon, ['webui', 'enable', '--loopback', '--bundle-dir', join(options.prefix, 'current/webui')], { cwd: options.dataDir, capture: true });
      if (!hooks.stage) {
        console.log('Verifying the Jev connection...');
        try {
          execute('sh', ['-c', 'set -a; . "$1"; set +a; exec "$2" "$3" "$4"', 'jev-setup', environment,
            join(release, 'runtime/bun'), join(ROOT, 'scripts/check-judgment.ts'), options.dataDir], { cwd: options.dataDir });
        } catch {
          // Account setup and upstream availability do not determine whether
          // the software can be installed or updated. Keep the check's exact
          // diagnostic visible; local service readiness is still required.
          console.warn('Jev connection check failed; continuing software installation. Resolve the account or connection problem reported above to use Jev.');
        }
      }
      if (options.service) {
        atomicWrite(unitPath(options), unit, 0o644);
        serviceAttempted = true;
        execute('systemctl', ['--user', 'daemon-reload']);
        execute('systemctl', ['--user', 'enable', SERVICE]);
        execute('systemctl', ['--user', 'restart', SERVICE]);
        await (hooks.ready ?? ready)(options, readFileSync(join(release, 'webui/index.html'), 'utf8'), execute);
        if (!hooks.stage) execute(join(release, 'runtime/bun'), [join(ROOT, 'products/tui/scripts/pair-installed-host.ts'), options.prefix, options.dataDir, String(options.port), options.workspace ?? ROOT], { cwd: options.dataDir });
      } else if (old?.service) {
        execute('systemctl', ['--user', 'disable', SERVICE]);
        rmSync(unitPath(options)); execute('systemctl', ['--user', 'daemon-reload']);
      }
      const { runtimeDir: _runtimeDir, nodePath: _nodePath, ...installedOptions } = options;
      const receipt: Installation = { ...installedOptions, schema: 1, package: PACKAGE, id, release: releaseName, sourceCommit: commit,
        service: options.service, unit: digest(unit), wrappers };
      atomicWrite(receiptPath(options), JSON.stringify(receipt, null, 2) + '\n');
      // Keep the previous release until all publication and readiness checks pass.
      if (old) {
        try {
          const previousRelease = join(options.prefix, 'releases', old.release);
          if ((hooks.isReleaseInUse ?? isReleaseInUse)(previousRelease)) console.log('Previous release retained for a running terminal or agent. Reopen it to use the update.');
          else rmSync(previousRelease, { recursive: true, force: true });
        }
        catch { console.warn(`Update succeeded; an unused previous release remains at ${join(options.prefix, 'releases', old.release)}.`); }
      }
      console.log(`Installed GoodVibes Jev (${commit.slice(0, 12)}). Commands: ${options.binDir}`);
      if (options.service) console.log(`Workspace: ${options.workspace ?? ROOT}`);
      console.log(options.service ? `WebUI: http://127.0.0.1:${options.port}\nService: systemctl --user status ${SERVICE}` : `Start the daemon: ${join(options.binDir, 'goodvibes-daemon')} serve`);
      console.log(`Credentials: ${environment}\nUninstall: ${join(options.binDir, 'goodvibes-uninstall')} (add --purge to remove data)`);
      if (!(process.env.PATH ?? '').split(':').includes(options.binDir)) console.log(`Add commands to your shell PATH: export PATH=${quote(options.binDir)}:"$PATH"`);
      if (options.service) console.log('For startup before login and after logout: loginctl enable-linger "$USER"');
    } catch (error) {
      // Do not delete binaries that a failed service stop might still be using.
      try {
        if (serviceAttempted) {
          execute('systemctl', ['--user', 'stop', SERVICE]);
          const state = execute('systemctl', ['--user', 'show', SERVICE, '--property=ActiveState', '--value'], { capture: true });
          if (!['inactive', 'failed'].includes(state)) throw new Error('Replacement service did not stop.');
          if (!old?.service) execute('systemctl', ['--user', 'disable', SERVICE]);
        }
        if (published) {
          if (old) switchRelease(options.prefix, old.release);
          else rmSync(join(options.prefix, 'current'), { force: true });
          for (const name of COMMANDS) {
            const previous = previousWrappers.get(name);
            if (previous !== undefined) atomicWrite(join(options.prefix, 'commands', name), previous, 0o755);
            else { rmSync(join(options.prefix, 'commands', name), { force: true }); rmSync(join(options.binDir, name), { force: true }); }
          }
          for (const [path, contents] of previousSettings) {
            if (contents !== undefined) atomicWrite(path, contents);
            else rmSync(path, { force: true });
          }
        }
        if (metadataTouched) {
          for (const [path, contents] of previousMetadata) {
            // A failed first launch can already have created user data. Preserve
            // its new ownership so a retry can adopt it; restore existing owners.
            if (published && previousMetadata.get(dataOwner(options)) === undefined && contents === undefined) continue;
            if (contents !== undefined) atomicWrite(path, contents);
            else rmSync(path, { force: true });
          }
        }
        if (options.service || old?.service) {
          if (previousUnit !== undefined) atomicWrite(unitPath(options), previousUnit, 0o644);
          else rmSync(unitPath(options), { force: true });
          execute('systemctl', ['--user', 'daemon-reload']);
          if (stopAttempted && wasRunning && old?.service) { execute('systemctl', ['--user', 'enable', SERVICE]); execute('systemctl', ['--user', 'start', SERVICE]); }
        }
        if (old) rmSync(release, { recursive: true, force: true });
        else rmSync(options.prefix, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Install failed and automatic recovery was incomplete. Files retained at ${options.prefix}; inspect ${SERVICE} before retrying.`);
      }
      throw error;
    }
  }));
}
if (import.meta.main) {
  try {
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Supported hosts: Linux x64/arm64.');
    if (process.getuid?.() === 0) throw new Error('Run as your regular user, without sudo.');
    await install(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof AggregateError) for (const cause of error.errors) console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
