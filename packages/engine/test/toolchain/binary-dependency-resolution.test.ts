import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { provideNativeAddon, resolveNativeAddonPayload, resolveOwnedPackageManifest } from '../../toolchain/src/lib/binary-dependency-resolution.ts';
import type { BinaryTarget } from '../../toolchain/src/config.ts';
import type { Exec } from '../../toolchain/src/lib/effects.ts';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const target: BinaryTarget = { key: 'linux-x64', bunTarget: 'bun-linux-x64', appArtifact: 'app', nativeAddonPackage: 'sqlite-vec-linux-x64', nativeAddonFile: 'vec0.so' };
const cross: BinaryTarget = { key: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', appArtifact: 'app', nativeAddonPackage: 'sqlite-vec-darwin-arm64', nativeAddonFile: 'vec0.dylib' };
function pkg(directory: string, name: string, version = '0.1.9', extra: Record<string, unknown> = {}): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, ...extra }));
  return directory;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'binary-owner-test-')); roots.push(root);
  const product = pkg(join(root, 'products', 'app'), 'fixture-app');
  const owner = pkg(join(root, 'store', 'sqlite-vec', 'node_modules', 'sqlite-vec'), 'sqlite-vec', '0.1.9', { optionalDependencies: { [target.nativeAddonPackage!]: '0.1.9', [cross.nativeAddonPackage!]: '0.1.9' } });
  mkdirSync(join(product, 'node_modules'), { recursive: true });
  symlinkSync(owner, join(product, 'node_modules', 'sqlite-vec'), 'dir');
  const install = (selected = target, version = '0.1.9') => {
    const native = pkg(join(root, 'store', selected.nativeAddonPackage!, 'node_modules', selected.nativeAddonPackage!), selected.nativeAddonPackage!, version);
    writeFileSync(join(native, selected.nativeAddonFile!), `fixture ${selected.key}`);
    symlinkSync(native, join(dirname(owner), selected.nativeAddonPackage!), 'dir');
    return native;
  };
  const destination = (selected = target) => join(product, 'dist', 'lib', selected.nativeAddonPackage!, selected.nativeAddonFile!);
  const stage = (selected = target, sameHost = true, exec?: Exec) => provideNativeAddon({ root: product, addonOutDir: 'dist/lib', target: selected, sameHost, ...(exec ? { exec } : {}), logger: { info() {}, warn() {}, error() {} } });
  return { root, product, owner, install, destination, stage };
}

test('resolves the linked dependency owner and stages its native package', () => {
  const f = fixture(); const native = f.install();
  expect(existsSync(join(f.product, 'node_modules', target.nativeAddonPackage!))).toBe(false);
  expect(resolveOwnedPackageManifest(join(f.product, 'package.json'), 'sqlite-vec')).toBe(join(f.owner, 'package.json'));
  expect(resolveOwnedPackageManifest(join(f.owner, 'package.json'), target.nativeAddonPackage!)).toBe(join(native, 'package.json'));
  expect(f.stage()).toBe(true);
  expect(readFileSync(f.destination(), 'utf8')).toBe('fixture linux-x64');
});

test('stages the requested installed cross target, not the host package', () => {
  const f = fixture(); f.install(); f.install(cross);
  expect(f.stage(cross, false, () => { throw new Error('installed target must not fetch'); })).toBe(true);
  expect(readFileSync(f.destination(cross), 'utf8')).toBe('fixture darwin-arm64');
  expect(existsSync(f.destination())).toBe(false);
});

test('missing same-host addon fails without attempting a fetch or creating output', () => {
  const f = fixture();
  expect(f.stage(target, true, () => { throw new Error('same-host must not fetch'); })).toBe(false);
  expect(existsSync(f.destination())).toBe(false);
});

test('missing owner fails without falling back to an unrelated product addon', () => {
  const f = fixture(); rmSync(join(f.product, 'node_modules', 'sqlite-vec'));
  pkg(join(f.product, 'node_modules', target.nativeAddonPackage!), target.nativeAddonPackage!);
  expect(f.stage()).toBe(false);
  expect(existsSync(f.destination())).toBe(false);
});

test('installed version mismatch fails before staging', () => {
  const f = fixture(); f.install(target, '0.1.1');
  expect(() => f.stage()).toThrow('different installed version');
  expect(existsSync(f.destination())).toBe(false);
});

test('an undeclared target version is not inferred from the owner version', () => {
  const f = fixture(); f.install(); pkg(f.owner, 'sqlite-vec');
  expect(() => f.stage()).toThrow('does not pin a version');
  expect(existsSync(f.destination())).toBe(false);
});

test.each(['payload', 'manifest'] as const)('a linked %s outside the installed native package is refused', kind => {
  const f = fixture(); const native = f.install();
  const outside = pkg(join(f.root, 'unrelated'), target.nativeAddonPackage!);
  writeFileSync(join(outside, target.nativeAddonFile!), 'unrelated bytes');
  const name = kind === 'manifest' ? 'package.json' : target.nativeAddonFile!;
  rmSync(join(native, name)); symlinkSync(join(outside, name), join(native, name));
  expect(() => f.stage()).toThrow('outside its package directory');
  expect(existsSync(f.destination())).toBe(false);
});

test('cross-target fetch retains the exact target/version and validates the extracted payload', () => {
  const f = fixture(); const calls: { command: string; args: readonly string[] }[] = [];
  const exec: Exec = (command, args) => {
    calls.push({ command, args });
    if (command === 'npm') return { status: 0, stdout: 'fixture.tgz\n', stderr: '' };
    const scratch = args[args.indexOf('-C') + 1]!;
    const native = pkg(join(scratch, 'package'), cross.nativeAddonPackage!);
    writeFileSync(join(native, cross.nativeAddonFile!), 'extracted target bytes');
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(f.stage(cross, false, exec)).toBe(true);
  expect(calls[0]?.args.slice(0, 2)).toEqual(['pack', 'sqlite-vec-darwin-arm64@0.1.9']);
  expect(readFileSync(f.destination(cross), 'utf8')).toBe('extracted target bytes');
  const scratch = calls[1]!.args.at(-1)!;
  expect(existsSync(scratch)).toBe(false);
});

test.each(['wrong-name', 'wrong-version', 'linked-payload', 'linked-manifest', 'linked-package'] as const)('cross-target %s is refused without output', kind => {
  const f = fixture();
  const outside = pkg(join(f.root, 'unrelated'), cross.nativeAddonPackage!);
  writeFileSync(join(outside, cross.nativeAddonFile!), 'unrelated bytes');
  const exec: Exec = (command, args) => {
    if (command === 'npm') return { status: 0, stdout: 'fixture.tgz', stderr: '' };
    const scratch = args.at(-1)!;
    const native = join(scratch, 'package');
    if (kind === 'linked-package') symlinkSync(outside, native, 'dir');
    else {
      pkg(native, kind === 'wrong-name' ? target.nativeAddonPackage! : cross.nativeAddonPackage!, kind === 'wrong-version' ? '0.1.1' : '0.1.9');
      writeFileSync(join(native, cross.nativeAddonFile!), 'candidate bytes');
      if (kind === 'linked-manifest' || kind === 'linked-payload') {
        // An unrelated directory inside the extraction root is still not the package.
        const neighbor = pkg(join(scratch, 'neighbor'), cross.nativeAddonPackage!);
        writeFileSync(join(neighbor, cross.nativeAddonFile!), 'neighbor bytes');
        const name = kind === 'linked-manifest' ? 'package.json' : cross.nativeAddonFile!;
        rmSync(join(native, name)); symlinkSync(join(neighbor, name), join(native, name));
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  expect(() => f.stage(cross, false, exec)).toThrow();
  expect(existsSync(f.destination(cross))).toBe(false);
});

test('payload inspection accepts a directory-linked package within the extraction root', () => {
  const f = fixture(); const native = pkg(join(f.root, 'contained'), target.nativeAddonPackage!);
  writeFileSync(join(native, target.nativeAddonFile!), 'fixture payload');
  symlinkSync(native, join(f.root, 'package'), 'dir');
  expect(resolveNativeAddonPayload(join(f.root, 'package'), target.nativeAddonPackage!, '0.1.9', target.nativeAddonFile!, f.root)).toBe(join(native, target.nativeAddonFile!));
});


test('an SDK export subpath resolves the enclosing engine package manifest', () => {
  const f = fixture();
  const engine = pkg(join(f.root, 'engine'), '@fixture/engine');
  mkdirSync(join(f.product, 'node_modules', '@fixture'), { recursive: true });
  mkdirSync(join(engine, 'sdk'), { recursive: true });
  symlinkSync(engine, join(f.product, 'node_modules', '@fixture', 'engine'), 'dir');
  expect(resolveOwnedPackageManifest(join(f.product, 'package.json'), '@fixture/engine/sdk')).toBe(join(engine, 'package.json'));
});
