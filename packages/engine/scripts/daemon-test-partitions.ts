import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SERVER_PARITY = 'src/test/daemon/server-parity.test.ts';
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Every daemon test file has one owner under the shared runner deadline. */
export function daemonTestManifest(daemonRoot: string) {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(resolve(daemonRoot, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) visit(child);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(child);
    }
  };
  visit('src/test');
  files.sort();
  if (files.length === 0) throw new Error('Daemon test inventory is empty');
  const groups = [
    { id: 'server-parity', files: files.filter(file => file === SERVER_PARITY) },
    { id: 'other-1', files: [] as string[] },
    { id: 'other-2', files: [] as string[] },
  ];
  files.filter(file => file !== SERVER_PARITY).forEach((file, index) => groups[1 + index % 2]!.files.push(file));
  const nonempty = groups.filter(group => group.files.length > 0);
  const census = nonempty.flatMap(group => group.files).sort();
  if (new Set(census).size !== files.length || census.some((file, index) => file !== files[index])) {
    throw new Error('Daemon child plans differ from the complete test inventory');
  }
  const sha256 = createHash('sha256').update(JSON.stringify({ files, groups: nonempty })).digest('hex');
  return { version: 1, sha256, files, groups: nonempty };
}

export function daemonTestPlans(daemonRoot: string, args: readonly string[]): readonly (readonly string[])[] {
  if (args.length > 0) throw new Error('The complete daemon test command does not accept test selectors');
  const manifest = daemonTestManifest(daemonRoot);
  console.log(`[daemon-tests] ${manifest.files.length} files in ${manifest.groups.length} owned children; manifest ${manifest.sha256}`);
  return manifest.groups.map(group => ['--cwd', '../../products/daemon', ...group.files.map(file => `./${file}`)]);
}

if (import.meta.main) {
  const daemonRoot = resolve(import.meta.dir, '../../../products/daemon');
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'manifest' && args.length === 0) console.log(JSON.stringify(daemonTestManifest(daemonRoot)));
  else if (mode === 'run') {
    const { runTests } = await import('./test.ts');
    await runTests(() => daemonTestPlans(daemonRoot, args), join(daemonRoot, '.test-tmp'));
  } else throw new Error('Usage: daemon-test-partitions.ts manifest|run');
}
