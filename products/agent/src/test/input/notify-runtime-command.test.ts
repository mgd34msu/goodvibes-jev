import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerNotifyRuntimeCommands } from '../../input/commands/notify-runtime.ts';

function makeContext(out: string[], urls: string[]): CommandContext {
  const stored = [...urls];
  const notifier = {
    setUrls: (_u: string[]) => {},
    test: async () => [],
    send: async () => ({ attempted: 0, delivered: 0, failed: 0, results: [] }),
  };
  return {
    print: (text: string) => out.push(text),
    platform: {
      webhookNotifier: notifier,
      configManager: {
        getCategory: () => ({ webhookUrls: stored }),
        mergeCategory: () => {},
      },
    },
    session: {} as never,
    provider: {} as never,
    ops: {} as never,
    extensions: {} as never,
  } as unknown as CommandContext;
}

describe('/notify list URL masking', () => {
  test('list masks the URL path tail by default', async () => {
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, ['https://ntfy.sh/my-very-secret-topic']);

    await registry.get('notify')!.handler(['list'], ctx);

    const text = out.join('\n');
    expect(text).toContain('https://ntfy.sh');
    expect(text).not.toContain('my-very-secret-topic');
    expect(text).toContain('--show --yes');
  });

  test('list reveals full URL with --show --yes', async () => {
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, ['https://ntfy.sh/my-very-secret-topic']);

    await registry.get('notify')!.handler(['list', '--show', '--yes'], ctx);

    const text = out.join('\n');
    expect(text).toContain('my-very-secret-topic');
  });

  test('list masks credentials in user:pass@host URLs', async () => {
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, ['https://user:secretpassword@hooks.example.com/path/to/webhook']);

    await registry.get('notify')!.handler(['list'], ctx);

    const text = out.join('\n');
    expect(text).not.toContain('secretpassword');
  });
});
