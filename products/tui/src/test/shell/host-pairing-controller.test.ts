import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { InputTokenizer } from '@goodvibes-jev/engine/sdk/platform/core';
import { HostPairingController } from '../../shell/host-pairing-controller.ts';
import { handleBlockingShellInput, type PendingPermissionState } from '../../shell/blocking-input.ts';
import { tuiHostPairingStorePath, readTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';
import { interactiveHostPairingFixture, untilPairing } from '../helpers/interactive-host-pairing.ts';

type Fixture = ReturnType<typeof interactiveHostPairingFixture>;
function controllerFor(f: Fixture) {
  const output: string[] = [];
  const prompts: string[] = [];
  const scrolls: number[] = [];
  const commands: Array<{ line: string; pairingActive: boolean }> = [];
  let present = true;
  let visiblePrompt = '';
  const controller = new HostPairingController(f.options, {
    print: text => output.push(text),
    setPrompt: text => { visiblePrompt = text; prompts.push(text); },
    readPrompt: () => visiblePrompt, canPresent: () => present,
    executeOwnerCommand: line => { commands.push({ line, pairingActive: controller.active }); },
    scroll: lines => scrolls.push(lines),
  });
  const tokenizer = new InputTokenizer();
  return {
    controller, commands, output, prompts, scrolls,
    text: () => [...output, ...prompts].join('\n'),
    setPresent: (value: boolean) => { present = value; },
    visiblePrompt: () => visiblePrompt,
    replacePrompt: (value: string) => { visiblePrompt = value; },
    phrase() {
      const matches = [...output.join('\n').matchAll(/PAIR [0-9a-f]{12}/g)];
      expect(matches.length).toBeGreaterThan(0);
      return matches.at(-1)![0];
    },
    feed(value: string) { return tokenizer.feed(value).map(token => controller.handleToken(token)); },
  };
}

async function withController(
  run: (f: Fixture, ui: ReturnType<typeof controllerFor>) => Promise<void>,
  options: Parameters<typeof interactiveHostPairingFixture>[0] = {},
) {
  const f = interactiveHostPairingFixture(options);
  const ui = controllerFor(f);
  try { await run(f, ui); f.assertPrivateOutput(ui.text()); }
  finally { ui.controller.dispose(); await f.stop(); }
}

const apply = { apply: true, bootstrapShared: true, name: 'Interactive TUI fixture' };

describe('interactive TUI host pairing controller over the real pairing core', () => {
  test('preview reads the selected host without opening a confirmation or creating a store', async () => withController(async (f, ui) => {
    expect(ui.controller.active).toBe(false);
    expect(ui.feed('x')).toEqual([false]);
    await ui.controller.start({ ...apply, apply: false });
    expect(ui.controller.active).toBe(false);
    expect(f.authCalls()).toBe(1);
    expect(f.migrations()).toBe(0);
    expect(ui.text()).toContain(f.host);
    expect(ui.text()).toContain('persistent administrative');
    expect(ui.text()).not.toMatch(/PAIR [0-9a-f]{12}/);
    expect(existsSync(tuiHostPairingStorePath(f.homeDirectory))).toBe(false);
  }));

  test('visible exact phrase applies once and persists a private host-bound credential', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    expect(ui.controller.active).toBe(true);
    expect(ui.text()).toContain(f.host);
    expect(ui.text()).toContain('persistent administrative');
    expect(f.migrations()).toBe(0);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
    ui.feed(`${ui.phrase()}\r\r`);
    await untilPairing(() => !ui.controller.active, 'paired result');
    expect(ui.text()).toContain('TUI host pairing: paired');
    expect(f.migrations()).toBe(1);
    expect(f.names()).toEqual([apply.name]);
    expect(readTuiHostPairing(f.homeDirectory, f.host)).toMatchObject({ status: 'paired', name: apply.name });
    const path = tuiHostPairingStorePath(f.homeDirectory);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    await ui.controller.start(apply);
    expect(ui.controller.active).toBe(false);
    expect(f.migrations()).toBe(1);
    expect(ui.text()).toContain('already-paired');
  }));

  test('CSI-u space is an exact ordinary space in the owner confirmation', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    const phrase = ui.phrase();
    ui.feed(`PAIR\x1b[32u${phrase.slice('PAIR '.length)}\r`);
    await untilPairing(() => !ui.controller.active, 'CSI-u confirmation');
    expect(f.migrations()).toBe(1);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('paired');
  }));

  test('paging and wheel scrolling preserve the active confirmation and typed answer', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    const phrase = ui.phrase();
    ui.feed(phrase.slice(0, 6));
    for (const key of ['\x1b[5~', '\x1b[6~', '\x1b[<64;1;1M', '\x1b[<65;1;1M']) {
      expect(ui.feed(key)).toEqual([true]);
      expect(ui.controller.active).toBe(true);
      expect(f.migrations()).toBe(0);
    }
    expect(ui.scrolls).toHaveLength(4);
    expect(ui.scrolls[0]).toBeLessThan(0);
    expect(ui.scrolls[1]).toBeGreaterThan(0);
    expect(ui.scrolls[2]).toBeLessThan(0);
    expect(ui.scrolls[3]).toBeGreaterThan(0);
    expect(ui.commands).toEqual([]);
    ui.feed(`${phrase.slice(6)}\r`);
    await untilPairing(() => !ui.controller.active, 'confirmation after scrolling');
    expect(f.migrations()).toBe(1);
  }));

  for (const kind of ['empty', 'yes', 'lowercase', 'leading space', 'trailing space', 'multiline paste']) {
    test(`${kind} is not the exact action-time phrase`, async () => withController(async (f, ui) => {
      await ui.controller.start(apply);
      const phrase = ui.phrase();
      const answer = kind === 'empty' ? '' : kind === 'yes' ? 'yes' : kind === 'lowercase' ? phrase.toLowerCase()
        : kind === 'leading space' ? ` ${phrase}` : kind === 'trailing space' ? `${phrase} ` : `${phrase}\n`;
      ui.feed(`\x1b[200~${answer}\x1b[201~\r`);
      await untilPairing(() => !ui.controller.active, 'refused confirmation');
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
    }));
  }

  test('backspace can correct an ordinary typo before explicit Enter', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed(`${ui.phrase()}x\x7f\r`);
    await untilPairing(() => !ui.controller.active, 'corrected confirmation');
    expect(f.migrations()).toBe(1);
  }));

  for (const invalid of ['\0', '\t', '\r', '\x7f']) {
    test(`a control-bearing paste cannot be normalized into a confirmation (${JSON.stringify(invalid)})`, async () => withController(async (f, ui) => {
      await ui.controller.start(apply);
      ui.feed(`\x1b[200~${ui.phrase()}${invalid}\x1b[201~\r`);
      await untilPairing(() => !ui.controller.active, 'invalid paste refusal');
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
    }));
  }

  test('backspacing an overflow paste does not turn it into fresh confirmation', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    const phrase = ui.phrase();
    ui.feed(`\x1b[200~${'x'.repeat(513)}\x1b[201~`);
    ui.feed('\x7f'.repeat(513));
    ui.feed(`${phrase}\r`);
    await untilPairing(() => !ui.controller.active, 'overflow refusal');
    expect(f.migrations()).toBe(0);
  }));

  test('a multiline paste cannot normalize into a replacement owner command', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed('\x1b[200~/exit\n\x1b[201~\r');
    expect(ui.controller.active).toBe(false);
    expect(ui.commands).toEqual([]);
    expect(f.migrations()).toBe(0);
  }));

  for (const [label, input] of [['Ctrl-C', '\x03'], ['Ctrl-D', '\x04'], ['Escape', '\x1b']] as const) {
    test(`${label} cancels the live prompt and consumes the cancellation key`, async () => withController(async (f, ui) => {
      await ui.controller.start(apply);
      expect(ui.feed(input)).toEqual([true]);
      expect(ui.controller.active).toBe(false);
      expect(ui.controller.cancel()).toBe(false);
      expect(ui.feed('x')).toEqual([false]);
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
    }));
  }

  for (const command of ['/exit', '/host pair --bootstrap-shared --name replacement --apply', '/help']) {
    test(`${command} replaces the prompt only after cancellation`, async () => withController(async (f, ui) => {
      await ui.controller.start(apply);
      ui.feed(`${command}\r`);
      await untilPairing(() => ui.commands.length === 1, 'replacement command');
      expect(ui.commands).toEqual([{ line: command, pairingActive: false }]);
      expect(ui.controller.active).toBe(false);
      expect(f.migrations()).toBe(0);
    }));
  }

  test('cancel during preview consumes input and suppresses a late prompt', async () => withController(async (f, ui) => {
    const start = ui.controller.start(apply);
    await untilPairing(f.held, 'held preview');
    expect(ui.controller.active).toBe(true);
    expect(ui.feed('y')).toEqual([true]);
    expect(ui.feed('\x03')).toEqual([true]);
    const afterCancel = ui.text();
    f.release();
    await start;
    expect(ui.controller.active).toBe(false);
    expect(ui.text()).toBe(afterCancel);
    expect(f.migrations()).toBe(0);
    expect(ui.text()).not.toMatch(/PAIR [0-9a-f]{12}/);
  }, { holdAuth: 1 }));

  test('newer preview wins over an older response without inheriting its answer', async () => withController(async (f, ui) => {
    const first = ui.controller.start({ ...apply, name: 'Old pairing' });
    await untilPairing(f.held, 'first preview');
    ui.feed('queued answer');
    await ui.controller.start({ ...apply, name: 'New pairing' });
    const phrase = ui.phrase();
    const current = ui.text();
    f.release(); await first;
    expect(ui.text()).toBe(current);
    expect(ui.controller.active).toBe(true);
    ui.feed(`${phrase}\r`);
    await untilPairing(() => !ui.controller.active, 'replacement apply');
    expect(f.names()).toEqual(['New pairing']);
  }, { holdAuth: 1 }));

  test('an old prompt phrase cannot authorize a replacement preview', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    const oldPhrase = ui.phrase();
    await ui.controller.start({ ...apply, name: 'Replacement pairing' });
    expect(ui.phrase()).not.toBe(oldPhrase);
    ui.feed(`${oldPhrase}\r`);
    await untilPairing(() => !ui.controller.active, 'stale answer refusal');
    expect(f.migrations()).toBe(0);
  }));

  test('Ctrl-C during authority revalidation cancels before the durable marker', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed(`${ui.phrase()}\r`);
    await untilPairing(f.held, 'held authority revalidation');
    expect(ui.controller.active).toBe(true);
    expect(ui.feed('\x03')).toEqual([true]);
    const afterCancel = ui.text();
    f.release();
    await untilPairing(() => f.returned() === 2, 'late revalidation reply');
    await Bun.sleep(10);
    expect(ui.controller.active).toBe(false);
    expect(ui.text()).toBe(afterCancel);
    expect(f.migrations()).toBe(0);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
  }, { holdAuth: 2 }));

  test('a render-driven surface takeover cancels held revalidation without another input token', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed(`${ui.phrase()}\r`);
    await untilPairing(f.held, 'held authority revalidation');
    expect(ui.controller.active).toBe(true);
    ui.setPresent(false);
    ui.controller.checkPresentation();
    // Cancellation must happen synchronously before the held authority reply.
    expect(ui.controller.active).toBe(false);
    expect(f.migrations()).toBe(0);
    const afterTakeover = ui.text();
    f.release();
    await untilPairing(() => f.returned() === 2, 'authority reply after takeover');
    await Bun.sleep(10);
    expect(f.migrations()).toBe(0);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
    expect(ui.text()).toBe(afterTakeover);
    ui.setPresent(true);
    ui.controller.checkPresentation();
    expect(ui.controller.active).toBe(false);
    expect(ui.controller.ownsInput).toBe(true);
    expect(ui.feed('\r')).toEqual([true]);
    expect(ui.controller.ownsInput).toBe(false);
    expect(ui.feed('x')).toEqual([false]);
  }, { holdAuth: 2 }));

  for (const [label, boundary] of [['Enter', '\r'], ['Escape', '\x1b'], ['Ctrl-C', '\x03'], ['Ctrl-D', '\x04']] as const) {
    test(`takeover drains the abandoned PAIR line through ${label} before permission input`, async () => withController(async (f, ui) => {
      await ui.controller.start(apply);
      const phrase = ui.phrase();
      ui.feed('P');
      const resolved: Array<[boolean, boolean | undefined]> = [];
      let pending: PendingPermissionState | null = {
        id: 'synthetic-permission', toolName: 'write', reason: 'Synthetic competing prompt',
        resolve: (approved: boolean, remember?: boolean) => { resolved.push([approved, remember]); },
      } as unknown as PendingPermissionState;
      const originalPending = pending;
      // These are the same two public input seams the shell composes. The
      // actual permission route would approve-and-remember a lone trailing A.
      const route = (data: string) => {
        if (ui.controller.ownsInput) {
          for (const handled of ui.feed(data)) expect(handled).toBe(true);
          return;
        }
        pending = handleBlockingShellInput({
          data, pendingPermission: pending, abortTurn: () => {}, render: () => {},
        }).pendingPermission;
      };
      ui.setPresent(false);
      expect(ui.controller.cancelForTakeover()).toBe(true);
      expect(ui.controller.active).toBe(false);
      expect(ui.controller.ownsInput).toBe(true);
      route('A');
      route(phrase.slice(2));
      expect(ui.controller.ownsInput).toBe(true);
      expect(pending).toBe(originalPending);
      expect(resolved).toEqual([]);
      route(boundary);
      expect(ui.controller.ownsInput).toBe(false);
      expect(resolved).toEqual([]);
      expect(pending).toBe(originalPending);
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
      // The new prompt is still usable, but needs a separate deliberate key.
      route('y');
      expect(resolved).toEqual([[true, false]]);
      expect(pending).toBeNull();
    }));
  }

  test('external draft replacement cancels the hidden phrase and preserves the new draft', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    const phrase = ui.phrase();
    ui.feed(phrase);
    expect(ui.visiblePrompt()).toBe(phrase);
    const newDraft = 'A fresh voice draft should stay visible.';
    ui.replacePrompt(newDraft);
    ui.controller.checkPresentation();
    expect(ui.controller.active).toBe(false);
    expect(ui.controller.ownsInput).toBe(true);
    expect(ui.visiblePrompt()).toBe(newDraft);
    expect(ui.feed('\r')).toEqual([true]);
    expect(ui.controller.ownsInput).toBe(false);
    expect(ui.visiblePrompt()).toBe(newDraft);
    expect(f.migrations()).toBe(0);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
    expect(ui.commands).toEqual([]);
  }));

  test('cancellation after migration preserves uncertainty and never remints on restart', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed(`${ui.phrase()}\r`);
    await untilPairing(f.held, 'held migration response');
    expect(f.migrations()).toBe(1);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('unknown');
    ui.feed('\x04');
    expect(ui.controller.active).toBe(false);
    const afterCancel = ui.text();
    f.release();
    await untilPairing(() => f.returned() === 3, 'late migration response');
    await Bun.sleep(10);
    expect(ui.text()).toBe(afterCancel);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('unknown');
    await ui.controller.start(apply);
    expect(ui.controller.active).toBe(false);
    expect(ui.text()).toContain('unknown');
    expect(f.migrations()).toBe(1);
  }, { holdMigration: true }));

  test('a slash command during revalidation cancels before dispatch and suppresses the old result', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed(`${ui.phrase()}\r`);
    await untilPairing(f.held, 'held authority revalidation');
    ui.feed('/help\r');
    expect(ui.commands).toEqual([{ line: '/help', pairingActive: false }]);
    const afterReplace = ui.text();
    f.release();
    await untilPairing(() => f.returned() === 2, 'replaced authority response');
    await Bun.sleep(10);
    expect(ui.text()).toBe(afterReplace);
    expect(f.migrations()).toBe(0);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
  }, { holdAuth: 2 }));

  test('cancellation after storage keeps the sole secret and reports unverified authority', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed(`${ui.phrase()}\r`);
    await untilPairing(f.held, 'held post-storage verification');
    const saved = readTuiHostPairing(f.homeDirectory, f.host);
    expect(saved.status).toBe('paired');
    ui.feed('\x03');
    expect(ui.controller.active).toBe(false);
    expect(ui.output.at(-1)).toContain('paired-unverified');
    const afterCancel = ui.text();
    f.release();
    await untilPairing(() => f.returned() === 4, 'late paired verification');
    await Bun.sleep(10);
    expect(ui.text()).toBe(afterCancel);
    expect(readTuiHostPairing(f.homeDirectory, f.host)).toEqual(saved);
    await ui.controller.start(apply);
    expect(ui.controller.active).toBe(false);
    expect(ui.text()).toContain('already-paired');
    expect(f.migrations()).toBe(1);
  }, { holdAuth: 3 }));

  test('disposing during migration preserves an unknown outcome without late UI writes', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed(`${ui.phrase()}\r`);
    await untilPairing(f.held, 'held migration response');
    ui.controller.dispose();
    const disposed = ui.text();
    f.release();
    await untilPairing(() => f.returned() === 3, 'disposed migration response');
    await Bun.sleep(10);
    expect(ui.controller.active).toBe(false);
    expect(ui.text()).toBe(disposed);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('unknown');
    expect(f.migrations()).toBe(1);
    await ui.controller.start(apply);
    expect(ui.text()).toBe(disposed);
    expect(f.migrations()).toBe(1);
  }, { holdMigration: true }));

  test('changed selected host invalidates the phrase without making a migration request', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    const phrase = ui.phrase();
    f.configManager.set('controlPlane.port', 1);
    ui.feed(`${phrase}\r`);
    await untilPairing(() => !ui.controller.active, 'changed host refusal');
    expect(f.migrations()).toBe(0);
    expect(ui.text()).toContain('changed');
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
  }));

  test('an unavailable live surface never acquires a pending confirmation', async () => withController(async (f, ui) => {
    ui.setPresent(false);
    await ui.controller.start(apply);
    expect(ui.controller.active).toBe(false);
    expect(ui.text()).not.toMatch(/PAIR [0-9a-f]{12}/);
    expect(f.migrations()).toBe(0);
  }));

  test('losing the surface during preview prevents a late confirmation', async () => withController(async (f, ui) => {
    const start = ui.controller.start(apply);
    await untilPairing(f.held, 'held preview');
    ui.setPresent(false); f.release(); await start;
    expect(ui.controller.active).toBe(false);
    expect(ui.text()).not.toMatch(/PAIR [0-9a-f]{12}/);
    expect(f.migrations()).toBe(0);
  }, { holdAuth: 1 }));

  test('disposal aborts pending preview and cannot resurrect a prompt', async () => withController(async (f, ui) => {
    const start = ui.controller.start(apply);
    await untilPairing(f.held, 'held preview');
    ui.controller.dispose();
    const disposed = ui.text();
    f.release(); await start;
    expect(ui.controller.active).toBe(false);
    expect(ui.text()).toBe(disposed);
    expect(f.migrations()).toBe(0);
  }, { holdAuth: 1 }));

  test('without explicit bootstrap selection the controller does not contact the host', async () => withController(async (f, ui) => {
    await ui.controller.start({ ...apply, bootstrapShared: false });
    expect(ui.controller.active).toBe(false);
    expect(f.authCalls()).toBe(0);
    expect(f.migrations()).toBe(0);
    expect(ui.text()).not.toMatch(/PAIR [0-9a-f]{12}/);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
  }));

  for (const queued of ['PAIR 000000000000\r', 'yes\rpartial answer', '\x1b[200~bad\nanswer\x1b[201~']) {
    test(`preview discards queued answers and invalid-paste state before the fresh prompt: ${JSON.stringify(queued)}`, async () => withController(async (f, ui) => {
      const start = ui.controller.start(apply);
      await untilPairing(f.held, 'held preview');
      expect(ui.feed(queued).every(Boolean)).toBe(true);
      expect(f.migrations()).toBe(0);
      expect(ui.text()).not.toMatch(/Type PAIR [0-9a-f]{12}/);
      f.release(); await start;
      expect(ui.controller.active).toBe(true);
      expect(ui.visiblePrompt()).toBe('');
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
      ui.feed(`${ui.phrase()}\r`);
      await untilPairing(() => !ui.controller.active, 'fresh answer after queued preview input');
      expect(f.migrations()).toBe(1);
    }, { holdAuth: 1 }));
  }

  test('voice draft replacement during preview cancels the late prompt and preserves the draft', async () => withController(async (f, ui) => {
    const start = ui.controller.start(apply);
    await untilPairing(f.held, 'held preview');
    const draft = 'This voice draft replaced the pairing composer.';
    ui.replacePrompt(draft);
    f.release(); await start;
    expect(ui.controller.active).toBe(false);
    expect(ui.controller.ownsInput).toBe(true);
    expect(ui.visiblePrompt()).toBe(draft);
    expect(ui.text()).not.toMatch(/PAIR [0-9a-f]{12}/);
    expect(f.migrations()).toBe(0);
    expect(ui.feed('abandoned line\r').every(Boolean)).toBe(true);
    expect(ui.controller.ownsInput).toBe(false);
    expect(ui.visiblePrompt()).toBe(draft);
    expect(ui.commands).toEqual([]);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
  }, { holdAuth: 1 }));

  test('a hidden modal detected on input consumes and quarantines the abandoned confirmation', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    const phrase = ui.phrase();
    ui.feed('P');
    ui.setPresent(false);
    expect(ui.feed('A')).toEqual([true]);
    expect(ui.controller.active).toBe(false);
    expect(ui.controller.ownsInput).toBe(true);
    expect(ui.feed(`${phrase.slice(2)}\r`).every(Boolean)).toBe(true);
    expect(ui.controller.ownsInput).toBe(false);
    expect(ui.commands).toEqual([]);
    expect(f.migrations()).toBe(0);
    expect(readTuiHostPairing(f.homeDirectory, f.host).status).toBe('missing');
  }));

  for (const [label, key] of [['Ctrl-C', '\x03'], ['Ctrl-D', '\x04'], ['Escape', '\x1b']] as const) {
    for (const phase of ['preview', 'revalidation', 'migration', 'verification'] as const) {
      test(`${label} cancels the ${phase} lifetime and preserves its durable outcome`, async () => withController(async (f, ui) => {
        const start = ui.controller.start(apply);
        if (phase !== 'preview') {
          await start;
          ui.feed(`${ui.phrase()}\r`);
        }
        await untilPairing(f.held, `held ${phase}`);
        const expectedState = phase === 'migration' ? 'unknown' : phase === 'verification' ? 'paired' : 'missing';
        const expectedMigrations = phase === 'migration' || phase === 'verification' ? 1 : 0;
        const before = readTuiHostPairing(f.homeDirectory, f.host);
        expect(before.status).toBe(expectedState);
        expect(ui.feed(key)).toEqual([true]);
        expect(ui.controller.active).toBe(false);
        expect(ui.controller.ownsInput).toBe(false);
        const afterCancel = ui.text();
        f.release(); await start;
        const returned = phase === 'preview' ? 1 : phase === 'revalidation' ? 2 : phase === 'migration' ? 3 : 4;
        await untilPairing(() => f.returned() === returned, `late ${phase} response`);
        await Bun.sleep(10);
        expect(ui.text()).toBe(afterCancel);
        expect(f.migrations()).toBe(expectedMigrations);
        expect(readTuiHostPairing(f.homeDirectory, f.host)).toEqual(before);
      }, phase === 'migration' ? { holdMigration: true } : { holdAuth: phase === 'preview' ? 1 : phase === 'revalidation' ? 2 : 3 }));
    }
  }

  test('rejected verification preserves the saved credential and cannot remint on restart', async () => withController(async (f, ui) => {
    await ui.controller.start(apply);
    ui.feed(`${ui.phrase()}\r`);
    await untilPairing(() => !ui.controller.active, 'unverified saved result');
    expect(ui.text()).toContain('paired-unverified');
    const saved = readTuiHostPairing(f.homeDirectory, f.host);
    expect(saved.status).toBe('paired');
    expect(f.migrations()).toBe(1);
    await ui.controller.start({ ...apply, bootstrapShared: false });
    expect(ui.controller.active).toBe(false);
    expect(ui.output.at(-1)).toContain('paired-unverified');
    expect(f.migrations()).toBe(1);
    expect(readTuiHostPairing(f.homeDirectory, f.host)).toEqual(saved);
  }, { rejectMinted: true }));

});
