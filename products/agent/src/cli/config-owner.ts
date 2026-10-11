import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { isDeepStrictEqual } from 'node:util';

const nativeGetRaw = ConfigManager.prototype.getRaw;
const nativeIncarnation = ConfigManager.prototype.getConfigurationIncarnation;

function retainMethodDescriptor(manager: ConfigManager, key: 'getRaw' | 'getConfigurationIncarnation') {
  const chain: object[] = [];
  let owner: object | null = manager;
  while (owner) {
    chain.push(owner);
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('CLI configuration methods must be data properties.');
      return () => {
        for (let i = 0; i < chain.length - 1; i++) {
          if (Object.getPrototypeOf(chain[i]) !== chain[i + 1]) throw new Error('CLI configuration owner changed.');
        }
        for (const [i, object] of chain.entries()) {
          const current = Object.getOwnPropertyDescriptor(object, key);
          if (i < chain.length - 1 ? current !== undefined : !current || !('value' in current)
            || current.value !== descriptor.value || current.writable !== descriptor.writable
            || current.enumerable !== descriptor.enumerable || current.configurable !== descriptor.configurable) {
            throw new Error('CLI configuration owner changed.');
          }
        }
      };
    }
    owner = Object.getPrototypeOf(owner);
  }
  throw new Error('CLI configuration method is unavailable.');
}

/** Retain the detached native view; borrowed getters retain their full readset. */
export function retainCliConfig(manager: ConfigManager) {
  const assertRawDescriptor = retainMethodDescriptor(manager, 'getRaw');
  const assertIncarnationDescriptor = retainMethodDescriptor(manager, 'getConfigurationIncarnation');
  const getRaw = manager.getRaw;
  const getIncarnation = manager.getConfigurationIncarnation;
  const nativeLifetime = manager instanceof ConfigManager && getIncarnation === nativeIncarnation;
  const incarnation = nativeLifetime ? getIncarnation.call(manager) : undefined;
  const raw = getRaw.call(manager);
  const nativeSnapshot = nativeLifetime && getRaw === nativeGetRaw;
  const version = nativeSnapshot ? undefined : captureStrictJudgmentJson(raw);
  const assertCurrent = () => {
    assertRawDescriptor(); assertIncarnationDescriptor();
    if (manager.getRaw !== getRaw || manager.getConfigurationIncarnation !== getIncarnation
      || (nativeLifetime && getIncarnation.call(manager) !== incarnation)) throw new Error('CLI configuration owner changed.');
    if (!nativeSnapshot && !isDeepStrictEqual(captureStrictJudgmentJson(getRaw.call(manager)), version)) {
      throw new Error('CLI configuration content changed.');
    }
    if (manager.getRaw !== getRaw || manager.getConfigurationIncarnation !== getIncarnation
      || (nativeLifetime && getIncarnation.call(manager) !== incarnation)) throw new Error('CLI configuration owner changed.');
    assertRawDescriptor(); assertIncarnationDescriptor();
  };
  assertCurrent();
  return { raw, assertCurrent };
}
