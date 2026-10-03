import { expect, test } from 'bun:test';
import { buildPairingConnectionInfo } from '../../../views/builtin-modals.ts';
import type { ResolvedBuiltinViewDeps } from '../../../views/view-deps.ts';
import { createPairingModalSurface } from '../../../views/modals/pairing-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { frameFromLayer } from '../../helpers/surface-frame.ts';

function fixture(throws = false) {
  let minted = 0;
  const deps = {
    configManager: {
      get: (key: string) => key === 'web.publicBaseUrl' ? 'https://paired.example.test' : key === 'relay.enabled' ? true : undefined,
      setDynamic: () => { throw new Error('existing origin must be preserved'); },
    },
    uiServices: { platform: { pairingTokens: {
      mint: ({ name }: { name: string }) => {
        if (throws) throw new Error('fixture unavailable');
        minted++;
        return { id: 'fixture-device', name, token: 'fixture-pairing-secret', createdAt: 1 };
      },
    } } },
  } as unknown as ResolvedBuiltinViewDeps;
  return { deps, minted: () => minted };
}

test('real builtin pairing builder produces a handoff and reaches the actual renderer', () => {
  const f = fixture();
  const info = buildPairingConnectionInfo(f.deps);
  expect(info).not.toBeNull();
  expect(f.minted()).toBe(1);
  expect(info?.url).toBe('https://paired.example.test');
  expect(info?.token).toBe('fixture-pairing-secret');
  expect(info?.deepLink).toContain('#pair=');
  expect(info?.offers).toEqual(['notifications', 'relay', 'passkey']);
  const modal = new ConfigModal();
  modal.open(createPairingModalSurface({ getConnectionInfo: () => buildPairingConnectionInfo(f.deps) }));
  const text = frameFromLayer(renderConfigModal(modal, 120, 40), 120, 40).map(line => line.map(cell => cell.char).join('')).join('\n');
  expect(text).toContain('https://paired.example.test');
  expect(text).not.toContain('fixture-pairing-secret');
  expect(text).not.toContain('unavailable');
  modal.close();
});

test('real builtin pairing builder still degrades when its actual token source fails', () => {
  const f = fixture(true);
  expect(buildPairingConnectionInfo(f.deps)).toBeNull();
  expect(f.minted()).toBe(0);
});
