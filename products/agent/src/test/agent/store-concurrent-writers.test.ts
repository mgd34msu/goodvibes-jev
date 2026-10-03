/**
 * The CLI and the agent are two OS processes over one store file. These tests
 * run that pairing for real rather than simulating it, because the defect they
 * pin only exists between processes: a shared temp filename let one writer
 * rename the temp file another was still writing into, which killed the second
 * writer outright and could promote a splice of both into the canonical path.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { readJsonObject, writeJsonObject } from '../../runtime/onboarding/apply-file-helpers.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { leftoverStoreTempFiles } from '../helpers/store-temp-files.ts';

const SRC_ROOT = join(import.meta.dir, '..', '..');

type ChildResult = { readonly stderr: string; readonly exitCode: number };

async function runWriters(scriptPath: string, args: readonly (readonly string[])[]): Promise<readonly ChildResult[]> {
  return Promise.all(
    args.map(async (argv) => {
      const proc = Bun.spawn(['bun', 'run', scriptPath, ...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { stderr, exitCode };
    }),
  );
}

describe('agent stores under concurrent processes', () => {
  test('two processes writing one routine store leave it parseable and complete', async () => {
    const root = makeProjectTempDir('gv-store-concurrent-routines');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const storePath = AgentRoutineRegistry.fromShellPaths(paths).snapshot().path;

      const script = join(root, 'writer.ts');
      writeFileSync(
        script,
        [
          `import { AgentRoutineRegistry } from ${JSON.stringify(join(SRC_ROOT, 'agent', 'routine-registry.ts'))};`,
          'const [storePath, prefix, count] = process.argv.slice(2);',
          'const registry = new AgentRoutineRegistry(storePath!);',
          'for (let i = 0; i < Number(count); i += 1) {',
          '  registry.create({',
          '    name: `${prefix} ${i}`,',
          '    description: `Routine ${prefix} ${i} description.`,',
          '    steps: `Step one for ${prefix} ${i}. Step two. Step three.`,',
          '  });',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const results = await runWriters(script, [
        [storePath, 'alpha', '30'],
        [storePath, 'beta', '30'],
      ]);
      for (const result of results) {
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
      }

      // The store still parses, which a spliced file would not.
      const routines = AgentRoutineRegistry.fromShellPaths(paths).list();
      expect(routines.length).toBeGreaterThan(0);
      // Cross-process read-modify-write is still last-writer-wins, so the two
      // runs' routines need not both survive; a truncated or half-written
      // record would show up as a parse failure above or a malformed name here.
      for (const routine of routines) {
        expect(routine.name).toMatch(/^(alpha|beta) \d+$/);
        expect(routine.description.endsWith('description.')).toBe(true);
      }
      expect(leftoverStoreTempFiles(storePath)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('a note store survives four writers without a torn or orphaned file', async () => {
    const root = makeProjectTempDir('gv-store-concurrent-notes');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const storePath = AgentNoteRegistry.fromShellPaths(paths).snapshot().path;

      const script = join(root, 'note-writer.ts');
      writeFileSync(
        script,
        [
          `import { AgentNoteRegistry } from ${JSON.stringify(join(SRC_ROOT, 'agent', 'note-registry.ts'))};`,
          'const [storePath, prefix, count] = process.argv.slice(2);',
          'const registry = new AgentNoteRegistry(storePath!);',
          'for (let i = 0; i < Number(count); i += 1) {',
          "  registry.create({ title: `${prefix} ${i}`, body: 'x'.repeat(4000), source: 'user', provenance: 'concurrency test' });",
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const results = await runWriters(script, [
        [storePath, 'w1', '20'],
        [storePath, 'w2', '20'],
        [storePath, 'w3', '20'],
        [storePath, 'w4', '20'],
      ]);
      for (const result of results) {
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
      }

      expect(() => AgentNoteRegistry.fromShellPaths(paths).list()).not.toThrow();
      const notes = AgentNoteRegistry.fromShellPaths(paths).list();
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) {
        expect(note.body).toHaveLength(4000);
      }
      expect(leftoverStoreTempFiles(storePath)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('onboarding settings writes are atomic: concurrent writers leave a parseable settings.json', async () => {
    const root = makeProjectTempDir('gv-store-concurrent-onboarding');
    try {
      const settingsPath = join(root, '.goodvibes', 'agent', 'settings.json');
      writeJsonObject(settingsPath, { seeded: true });

      const script = join(root, 'settings-writer.ts');
      writeFileSync(
        script,
        [
          `import { writeJsonObject } from ${JSON.stringify(join(SRC_ROOT, 'runtime', 'onboarding', 'apply-file-helpers.ts'))};`,
          'const [path, marker, count] = process.argv.slice(2);',
          "const payload = { owner: marker, filler: marker!.repeat(20_000) };",
          'for (let i = 0; i < Number(count); i += 1) writeJsonObject(path!, payload);',
          '',
        ].join('\n'),
        'utf-8',
      );

      const results = await runWriters(script, [
        [settingsPath, 'a', '25'],
        [settingsPath, 'b', '25'],
        [settingsPath, 'c', '25'],
      ]);
      for (const result of results) {
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
      }

      // A bare writeFileSync would let a reader see a half-written file here;
      // the whole boot fails on an unparseable settings.json.
      const settings = readJsonObject(settingsPath);
      const owner = String(settings.owner);
      expect(['a', 'b', 'c']).toContain(owner);
      expect(settings.filler).toBe(owner.repeat(20_000));
      expect(leftoverStoreTempFiles(settingsPath)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('a settings.json written by writeJsonObject is never observed partially by a concurrent reader', async () => {
    const root = makeProjectTempDir('gv-store-onboarding-reader');
    try {
      const settingsPath = join(root, 'settings.json');
      writeJsonObject(settingsPath, { owner: 'seed', filler: 'seed'.repeat(20_000) });

      const script = join(root, 'reader.ts');
      writeFileSync(
        script,
        [
          "import { readFileSync } from 'node:fs';",
          'const [path, count] = process.argv.slice(2);',
          'for (let i = 0; i < Number(count); i += 1) {',
          '  const text = readFileSync(path!, "utf-8");',
          '  JSON.parse(text);',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const reader = Bun.spawn(['bun', 'run', script, settingsPath, '3000'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      for (let i = 0; i < 200; i += 1) {
        writeJsonObject(settingsPath, { owner: `w${i}`, filler: 'x'.repeat(20_000) });
      }
      const [stderr, exitCode] = await Promise.all([new Response(reader.stderr).text(), reader.exited]);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      expect(readFileSync(settingsPath, 'utf-8').trimEnd().endsWith('}')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
