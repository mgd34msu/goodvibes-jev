import { describe, expect, test } from 'bun:test';
import type { DaemonWebSocket, DaemonWebSocketFactory } from '@goodvibes-jev/engine/terminal-shell';
import { renderPairingBanner } from '../../core/pairing-banner.js';
import { runPairCommand } from '../../daemon/pair-command.js';

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'web.hostMode': 'local',
    'web.host': '127.0.0.1',
    'web.port': 3423,
    'web.publicBaseUrl': 'http://127.0.0.1:3423',
    'relay.enabled': false,
    ...overrides,
  };
  return { get: (key: string): never => values[key] as never };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    configManager: config(),
    daemonHomeDir: '/home/x/.goodvibes/daemon',
    version: '9.9.9-test',
    readToken: () => JSON.stringify({ token: 'companion-token' }),
    flags: { host: undefined, port: undefined, token: undefined, json: false, yes: false },
    ...overrides,
  };
}

/**
 * A WebSocket stand-in that plays the daemon's side of the frame exchange:
 * accept the auth frame, then answer the `call` frame with a canned body,
 * the same double status-command.test.ts uses for its ws-only verbs.
 */
function fakeSocketFactory(answer: { ok: boolean; body?: unknown; status?: number }): {
  factory: DaemonWebSocketFactory;
  methodIds: string[];
  bodies: unknown[];
} {
  const methodIds: string[] = [];
  const bodies: unknown[] = [];
  const factory: DaemonWebSocketFactory = (_url, _init) => {
    const socket: DaemonWebSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data: string): void {
        const frame = JSON.parse(data) as { type: string; id?: string; methodId?: string; body?: unknown };
        if (frame.type === 'auth') {
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) }));
          return;
        }
        if (frame.type === 'call') {
          methodIds.push(frame.methodId ?? '');
          bodies.push(frame.body);
          queueMicrotask(() => socket.onmessage?.({
            data: JSON.stringify({
              type: 'response',
              id: frame.id,
              ok: answer.ok,
              status: answer.status ?? (answer.ok ? 200 : 400),
              body: answer.body,
            }),
          }));
        }
      },
      close(): void {
        // Nothing to release: this double never opened anything.
      },
    };
    queueMicrotask(() => socket.onopen?.({}));
    return socket;
  };
  return { factory, methodIds, bodies };
}

/** A socket factory that fails the test if it is ever invoked. */
function neverCalledFactory(): DaemonWebSocketFactory {
  return () => {
    throw new Error('socketFactory was called, but nothing should have been reached yet');
  };
}

const MINTED_WITH_ORIGIN = {
  token: { id: 'tok-1', name: 'paired device (2026-07-31 00:00)', token: 'fresh-secret', createdAt: 1 },
  offers: [{ kind: 'notifications', available: true }, { kind: 'passkey', available: true }],
  fragment: '#pair=fresh-secret&offers=notifications%2Cpasskey',
  deepLink: 'http://10.0.0.7:3423/#pair=fresh-secret&offers=notifications%2Cpasskey',
};

const MINTED_NO_ORIGIN = {
  token: { id: 'tok-2', name: 'paired device (2026-07-31 00:00)', token: 'fresh-secret-2', createdAt: 2 },
  offers: [{ kind: 'notifications', available: true }],
  fragment: '#pair=fresh-secret-2&offers=notifications',
};

describe('pair reprints the block the daemon prints at startup (local form)', () => {
  test.each([0, -1, 65536, NaN])('local reprint refuses unknown or invalid listener port %s', async (port) => {
    const result = await runPairCommand(baseInput({
      readToken: () => { throw new Error('Identity must remain unread'); },
      flags: { host: undefined, port, token: undefined, json: true, yes: false },
    }));
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({ ok: false, error: 'the local pairing port must identify a concrete listener' });
  });
  test.each([undefined, 'explicit-token'])('local reprint honors token overrides without reading or writing identity: %s', async (token) => {
    const result = await runPairCommand(baseInput({ operatorToken: 'process-token',
      readToken: () => { throw new Error('Stored identity must not be read'); },
      flags: { host: undefined, port: undefined, token, json: true, yes: false },
      configManager: config({ 'controlPlane.webui.serve': true }),
    }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.lines[0]!);
    const link = new URL(parsed.data.deepLink);
    expect(link.origin).toBe('http://127.0.0.1:3421');
    expect(new URLSearchParams(link.hash.slice(1)).get('pair')).toBe(token ?? 'process-token');
  });
  test('a JSON-shaped effective override is a literal credential, not a stored-file record', async () => {
    const token = '{"token":"synthetic-inner-token"}';
    const result = await runPairCommand(baseInput({ operatorToken: token,
      flags: { host: undefined, port: undefined, token: undefined, json: true, yes: false },
    }));
    const link = new URL(JSON.parse(result.lines[0]!).data.deepLink);
    expect(new URLSearchParams(link.hash.slice(1)).get('pair')).toBe(token);
  });
  test('the lines are the shared banner, byte for byte', async () => {
    const result = await runPairCommand(baseInput());
    expect(result.exitCode).toBe(0);
    const expected = renderPairingBanner({
      version: '9.9.9-test',
      origin: 'http://127.0.0.1:3423',
      token: 'companion-token',
      offers: ['notifications', 'passkey'],
    });
    expect(result.lines).toEqual(expected.lines);
  });

  test('the deep link carries the EXISTING token, not a fresh one', async () => {
    const result = await runPairCommand(baseInput({
      flags: { host: undefined, port: undefined, token: undefined, json: true, yes: false },
    }));
    const parsed = JSON.parse(result.lines[0] as string) as { data: { deepLink: string } };
    expect(parsed.data.deepLink).toContain('companion-token');
    expect(parsed.data.deepLink.startsWith('http://127.0.0.1:3423')).toBe(true);
  });

  test.each(['::1', '2001:db8::5'])('local pairing keeps a valid IPv6 origin for %s', async (host) => {
    const result = await runPairCommand(baseInput({
      configManager: config({ 'web.publicBaseUrl': '', 'web.hostMode': 'custom', 'web.host': host }),
      flags: { host: undefined, port: undefined, token: undefined, json: true, yes: false },
      socketFactory: neverCalledFactory(),
    }));
    const parsed = JSON.parse(result.lines[0]!) as { data: { origin: string; deepLink: string } };
    expect(parsed.data.origin).toBe(`http://[${host}]:3423`);
    expect(new URL(parsed.data.deepLink).hostname).toBe(`[${host}]`);
    expect(parsed.data.deepLink).toContain('companion-token');
  });

  test('a bare token file (not a JSON record) is read as the token', async () => {
    const result = await runPairCommand(baseInput({
      readToken: () => '  raw-token  ',
      flags: { host: undefined, port: undefined, token: undefined, json: true, yes: false },
    }));
    const parsed = JSON.parse(result.lines[0] as string) as { data: { deepLink: string } };
    expect(parsed.data.deepLink).toContain('raw-token');
  });

  test('a relay-enabled daemon offers relay too', async () => {
    const result = await runPairCommand(baseInput({
      configManager: config({ 'relay.enabled': true }),
      flags: { host: undefined, port: undefined, token: undefined, json: true, yes: false },
    }));
    const parsed = JSON.parse(result.lines[0] as string) as { data: { offers: string[] } };
    expect(parsed.data.offers).toEqual(['notifications', 'relay', 'passkey']);
  });

  test('--json prints the link with no QR block', async () => {
    const result = await runPairCommand(baseInput({
      flags: { host: undefined, port: undefined, token: undefined, json: true, yes: false },
    }));
    expect(result.lines.length).toBe(1);
    expect(result.lines[0]).not.toContain('█');
  });

  test('the prose form carries the QR', async () => {
    const result = await runPairCommand(baseInput());
    expect(result.lines.join('\n')).toContain('scan to pair a device');
  });

  test.each([['127.0.0.1'], ['localhost'], ['::1'], ['0.0.0.0']])(
    '--host %s still means this machine (local reprint, no network call)',
    async (host) => {
      const result = await runPairCommand(baseInput({
        flags: { host, port: undefined, token: undefined, json: false, yes: false },
        socketFactory: neverCalledFactory(),
      }));
      expect(result.exitCode).toBe(0);
    },
  );

  test('no operator token means no link, and says how to make one', async () => {
    const result = await runPairCommand(baseInput({ readToken: () => undefined }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no operator token');
    expect(result.lines.join('\n')).toContain('goodvibes-daemon serve');
  });

  test('a refusal in --json mode is one JSON document', async () => {
    const result = await runPairCommand(baseInput({
      readToken: () => undefined,
      flags: { host: undefined, port: undefined, token: undefined, json: true, yes: false },
    }));
    expect(JSON.parse(result.lines[0] as string)).toMatchObject({ ok: false });
  });
});

describe('pair writes nothing (local form)', () => {
  test('it reads the web origin without freezing it into settings', () => {
    // The boot path calls ensurePublicBaseUrl, which PERSISTS a resolved
    // origin. A command that only prints a link must not do that, so this
    // config double has no write method at all: reaching for one would throw.
    const readOnly = {
      get: (key: string): never => ({
        'web.publicBaseUrl': '',
        'web.hostMode': 'local',
        'web.host': '127.0.0.1',
        'web.port': 3423,
        'relay.enabled': false,
      } as Record<string, unknown>)[key] as never,
    };
    return runPairCommand(baseInput({ configManager: readOnly })).then((result) => {
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('pair --host <other machine> (remote form): confirmation gate', () => {
  test('without -y nothing is called, and the plan states the mint-vs-reprint distinction', async () => {
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false, yes: false },
      socketFactory: neverCalledFactory(),
    }));
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('MINT A NEW');
    expect(text).toContain('10.0.0.7');
    expect(text).toContain('-y');
    expect(text).not.toContain('fresh-secret');
  });

  test('the --json dry run is one JSON document with confirmed: false', async () => {
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: true, yes: false },
      socketFactory: neverCalledFactory(),
    }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.lines[0] as string) as { ok: boolean; data: { confirmed: boolean; target: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.confirmed).toBe(false);
    expect(parsed.data.target).toContain('10.0.0.7');
  });

  test('-y proceeds to call pairing.handoff.create', async () => {
    const { factory, methodIds, bodies } = fakeSocketFactory({ ok: true, body: MINTED_WITH_ORIGIN });
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false, yes: true },
      socketFactory: factory,
    }));
    expect(result.exitCode).toBe(0);
    expect(methodIds).toEqual(['pairing.handoff.create']);
    // No --name flag exists on this command: the mint call names the token
    // with the SDK's own dated default, the same one every other pairing
    // producer falls back to.
    expect((bodies[0] as { name: string }).name).toMatch(/^paired device \(/);
  });
});

describe('pair --host <other machine> -y (remote form): mint and render', () => {
  test('a deep-link-bearing mint renders through the SAME banner the local form uses', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: MINTED_WITH_ORIGIN });
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false, yes: true },
      socketFactory: factory,
    }));
    expect(result.exitCode).toBe(0);

    // The origin recovered from the response's deepLink, fed back through the
    // SAME renderer the local `pair` block uses, must rebuild that deepLink
    // byte-for-byte (it is asserted directly, since the renderer only prints
    // the origin as text, the deep link itself rides in the QR, not prose).
    const expectedBanner = renderPairingBanner({
      version: 'remote build at http://10.0.0.7:3421',
      origin: 'http://10.0.0.7:3423',
      token: 'fresh-secret',
      offers: ['notifications', 'passkey'],
    });
    expect(expectedBanner.deepLink).toBe(MINTED_WITH_ORIGIN.deepLink);
    expect(result.lines).toEqual([
      'minted a new per-device pairing token ("paired device (2026-07-31 00:00)") on the daemon at http://10.0.0.7:3421.',
      '',
      ...expectedBanner.lines,
    ]);
  });

  test('--json carries the minted secret and the rebuilt deep link', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: MINTED_WITH_ORIGIN });
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: true, yes: true },
      socketFactory: factory,
    }));
    const parsed = JSON.parse(result.lines[0] as string) as {
      ok: boolean;
      data: { minted: boolean; token: string; deepLink: string; offers: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.minted).toBe(true);
    expect(parsed.data.token).toBe('fresh-secret');
    expect(parsed.data.deepLink).toBe(MINTED_WITH_ORIGIN.deepLink);
    expect(parsed.data.offers).toEqual(['notifications', 'passkey']);
  });

  test('a mint with no configured web origin degrades honestly: token and fragment, no QR', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: MINTED_NO_ORIGIN });
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false, yes: true },
      socketFactory: factory,
    }));
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('minted a new per-device pairing token');
    expect(text).toContain('no web origin configured');
    expect(text).toContain('fresh-secret-2');
    expect(text).toContain(MINTED_NO_ORIGIN.fragment);
    expect(text).not.toContain('█'); // no QR possible without a real URL
  });

  test('the fragment-only --json shape carries the token but no deepLink', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: MINTED_NO_ORIGIN });
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: true, yes: true },
      socketFactory: factory,
    }));
    const parsed = JSON.parse(result.lines[0] as string) as {
      data: { token: string; fragment: string; deepLink?: string };
    };
    expect(parsed.data.token).toBe('fresh-secret-2');
    expect(parsed.data.fragment).toBe(MINTED_NO_ORIGIN.fragment);
    expect(parsed.data.deepLink).toBeUndefined();
  });
});

describe('pair --host <other machine> -y: each refusal is named, never a stack trace', () => {
  test('an unreachable daemon is refused by name', async () => {
    const factory: DaemonWebSocketFactory = () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false, yes: true },
      socketFactory: factory,
    }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('could not reach');
  });

  test('an auth failure is refused by name', async () => {
    const factory: DaemonWebSocketFactory = (_url, _init) => {
      const socket: DaemonWebSocket = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data: string): void {
          const frame = JSON.parse(data) as { type: string };
          if (frame.type === 'auth') {
            queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth', ok: false }) }));
          }
        },
        close(): void {
          // Nothing to release.
        },
      };
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    };
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false, yes: true },
      socketFactory: factory,
    }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('refused the operator token');
  });

  test('a daemon too old to serve the verb is refused by name, not a stack trace', async () => {
    const { factory } = fakeSocketFactory({ ok: false, status: 404, body: {} });
    const result = await runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false, yes: true },
      socketFactory: factory,
    }));
    expect(result.exitCode).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('does not know the verb pairing.handoff.create');
    expect(text).toContain('update it');
  });

  test('no operator token for the target machine refuses before any call is made', async () => {
    const result = await runPairCommand(baseInput({
      readToken: () => undefined,
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false, yes: true },
      socketFactory: neverCalledFactory(),
    }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no operator token');
  });
});
