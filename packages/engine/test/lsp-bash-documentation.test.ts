import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('Bash completion documentation passes labels as positional data to constant scripts', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exports: { getShellDocumentationWithoutCache?: (input: { word: string }) => Promise<string | null> } = {};
  const dependencies: Record<string, unknown> = {
    child_process: { spawn(command: string, args: string[]) {
      calls.push({ command, args });
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
      queueMicrotask(() => {
        if (args[3]?.startsWith('man ')) child.stdout.emit('data', 'documentation');
        child.emit('close', 0);
      });
      return child;
    } },
    './logger': { logger: { error() {} } },
    './platform': { isWindows: () => false },
  };
  runInNewContext(readFileSync(new URL('../../../vendor/bash-language-server/out/util/sh.js', import.meta.url), 'utf8'), {
    exports, require: (name: string) => dependencies[name],
  });
  for (const word of ['printf', 'label;side-effect', '$(side-effect)', '`side-effect`', '--help']) {
    expect(await exports.getShellDocumentationWithoutCache!({ word })).toBe('documentation');
    for (const call of calls.splice(0)) {
      expect(call.command).toBe('bash');
      expect(call.args.slice(0, 3)).toEqual(['--noprofile', '--norc', '-c']);
      expect(['help -- "$1" | col -bx', 'man -P cat -- "$1" | col -bx']).toContain(call.args[3]!);
      expect(call.args.slice(4)).toEqual(['bash-documentation', word]);
    }
  }
  await expect(exports.getShellDocumentationWithoutCache!({ word: 'bad\tlabel' })).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
