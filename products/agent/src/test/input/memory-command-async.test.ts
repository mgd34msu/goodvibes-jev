import { expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test.each(['search', 'list', 'queue', 'explain'])('the actual memory command awaits %s before rendering', async (command) => {
  const reading = deferred<never[] | { injections: never[]; prompt: null }>();
  const lines: string[] = [];
  const memory = {
    search: () => reading.promise,
    reviewQueue: () => reading.promise,
    explain: () => reading.promise,
  };
  const context = { print: (line: string) => lines.push(line), clients: { agentKnowledgeApi: { memory } } } as unknown as CommandContext;
  let finished = false;
  const pending = Promise.resolve(recallCommand.handler([command, ...(command === 'explain' ? ['fixture task'] : [])], context)).then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(lines).toEqual([]);
  reading.resolve(command === 'explain' ? { injections: [], prompt: null } : []);
  await pending;
  expect(finished).toBe(true);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('[memory]');
});

test('a failed asynchronous memory read propagates without printing an empty success', async () => {
  const reading = deferred<never[]>();
  const lines: string[] = [];
  const context = {
    print: (line: string) => lines.push(line),
    clients: { agentKnowledgeApi: { memory: { search: () => reading.promise } } },
  } as unknown as CommandContext;
  const pending = Promise.resolve(recallCommand.handler(['list'], context));
  reading.reject(new Error('synthetic memory reading unavailable'));
  await expect(pending).rejects.toThrow('synthetic memory reading unavailable');
  expect(lines).toEqual([]);
});
