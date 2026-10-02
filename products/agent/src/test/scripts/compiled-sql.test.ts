import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bunCompileCompatibilityFiles } from '../../../scripts/bun-compile-compat.ts';
import { compileAgent } from '../../../scripts/compile.ts';

const product = resolve(import.meta.dir, '../../..');

for (const dependencyOwner of ['product', 'engine'] as const) test(`pristine ${dependencyOwner}-owned sql.js embeds WASM and runs a query without runtime files`, async () => {
  const installed = dirname(createRequire(join(product, 'package.json')).resolve('sql.js/package.json'));
  const installedSource = readFileSync(join(installed, 'dist/sql-wasm.js'), 'utf8');
  const wasm = readFileSync(join(installed, 'dist/sql-wasm.wasm'));
  const injection = `if(!Ea&&typeof Buffer!=="undefined"){Ea=new Uint8Array(Buffer.from("${wasm.toString('base64')}","base64"));}`;
  // Older prebuilds may have patched a developer's install already. Always
  // exercise the pristine upstream shape, entirely inside this owned fixture.
  const pristine = installedSource.replace(injection, '');
  const dir = mkdtempSync(join(tmpdir(), 'agent-sql-compile-'));
  const engine = join(dir, 'packages/engine');
  const sql = join(dependencyOwner === 'engine' ? engine : dir, 'node_modules/sql.js');
  const source = join(sql, 'dist/sql-wasm.js');
  const isolated = join(dir, 'runtime');
  try {
    mkdirSync(join(sql, 'dist'), { recursive: true });
    mkdirSync(isolated);
    const dependencies = dependencyOwner === 'engine' ? { '@goodvibes-jev/engine': 'workspace:*' } : { 'sql.js': '1.14.1' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'synthetic-sql-consumer', dependencies }));
    if (dependencyOwner === 'engine') {
      mkdirSync(join(dir, 'node_modules/@goodvibes-jev'), { recursive: true });
      symlinkSync(engine, join(dir, 'node_modules/@goodvibes-jev/engine'));
      writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', version: '1.0.0', main: 'index.js', dependencies: { 'sql.js': '1.14.1' } }));
      writeFileSync(join(engine, 'index.js'), `export { default } from 'sql.js';`);
    }
    copyFileSync(join(installed, 'package.json'), join(sql, 'package.json'));
    writeFileSync(source, pristine);
    writeFileSync(join(sql, 'dist/sql-wasm.wasm'), wasm);
    writeFileSync(join(dir, 'entry.ts'), `import init from '${dependencyOwner === 'engine' ? '@goodvibes-jev/engine' : 'sql.js'}'; const SQL = await init(); const db = new SQL.Database(); console.log(JSON.stringify(db.exec('SELECT 6 * 7 AS answer')[0].values)); db.close();`);
    const files = bunCompileCompatibilityFiles(dir);
    expect(pristine).not.toContain(injection);
    expect(files[source]).toContain(injection);
    const binary = join(dir, 'sql-proof');
    await compileAgent(dir, ['entry.ts', '--compile', `--target=bun-${process.platform}-${process.arch}`, '--outfile', binary]);
    expect(readFileSync(source, 'utf8')).toBe(pristine);
    // Remove the fixture's JS/WASM before execution, so success requires embedding.
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    rmSync(join(dir, 'packages'), { recursive: true, force: true });
    const run = spawnSync(binary, [], { cwd: isolated, env: { PATH: '/usr/bin:/bin', HOME: isolated }, encoding: 'utf8', timeout: 30_000 });
    expect({ status: run.status, stdout: run.stdout.trim(), stderr: run.stderr }).toEqual({ status: 0, stdout: '[[42]]', stderr: '' });
    expect(readFileSync(join(installed, 'dist/sql-wasm.js'), 'utf8')).toBe(installedSource);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 360_000);
