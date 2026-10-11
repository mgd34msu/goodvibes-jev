import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { assertCurrentToolEffect } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ShellPathService } from '@/runtime/index.ts';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { retainCliConfig } from '../cli/config-owner.ts';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { agentHostPairingStorePath, canonicalizePairingHost } from '../runtime/connected-host-pairing-store.ts';
import type { AgentConnectedHostConfigReader } from './routine-schedule-promotion.ts';

const nativeIncarnation = ConfigManager.prototype.getConfigurationIncarnation;

function held(): never { throw new Error('Connected operator authority changed or is unavailable.'); }

function retainGet(reader: AgentConnectedHostConfigReader): () => void {
  const chain: object[] = [];
  let owner: object | null = reader;
  while (owner) {
    chain.push(owner);
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'get');
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') held();
      return () => {
        for (const [index, object] of chain.entries()) {
          if (index < chain.length - 1 && Object.getPrototypeOf(object) !== chain[index + 1]) held();
          const current = Object.getOwnPropertyDescriptor(object, 'get');
          if (index < chain.length - 1 ? current !== undefined : !current || !('value' in current)
            || current.value !== descriptor.value || current.writable !== descriptor.writable
            || current.configurable !== descriptor.configurable || current.enumerable !== descriptor.enumerable) held();
        }
      };
    }
    owner = Object.getPrototypeOf(owner);
  }
  return held();
}

/** Retain only the selected private credential and its physical ancestry. */
function credentialFiles(path: string) {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) held();
  const ancestors: readonly string[] = (() => {
    const result: string[] = [];
    for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
      result.push(ancestor);
      if (dirname(ancestor) === ancestor) return result;
    }
  })();
  const directories = ancestors.map(ancestor => {
    const stat = lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) held();
    return { path: ancestor, dev: stat.dev, ino: stat.ino, mode: stat.mode };
  });
  const bytes = readFileSync(path);
  const signature = (stat: Stats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink,
    stat.size, stat.mtimeMs, stat.ctimeMs];
  const original = signature(file);
  const assertCurrent = () => {
    for (const directory of directories) {
      const stat = lstatSync(directory.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directory.dev || stat.ino !== directory.ino || stat.mode !== directory.mode) held();
    }
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || !isDeepStrictEqual(signature(before), original)
      || !readFileSync(path).equals(bytes) || !isDeepStrictEqual(signature(lstatSync(path)), original)) held();
  };
  assertCurrent();
  return assertCurrent;
}

/** This owner does not mint admission. Its checks only restrict the current invocation. */
export function captureOperatorConnection(shellPaths: Pick<ShellPathService, 'homeDirectory'>, reader: AgentConnectedHostConfigReader,
  assertInvocation: () => void) {
  const home = shellPaths.homeDirectory;
  const assertGet = retainGet(reader);
  const get = reader.get;
  const native = reader instanceof ConfigManager ? retainCliConfig(reader) : undefined;
  if (reader instanceof ConfigManager && reader.getConfigurationIncarnation !== nativeIncarnation) held();
  const host = captureStrictJudgmentJson(get.call(reader, 'controlPlane.host'));
  const port = captureStrictJudgmentJson(get.call(reader, 'controlPlane.port'));
  const baseUrl = connectedHostBaseUrl(host, port);
  if (canonicalizePairingHost(baseUrl) !== baseUrl) held();
  const selected = readConnectedHostOperatorToken(home, baseUrl);
  const path = selected.path === 'Agent host-bound pairing store' ? agentHostPairingStorePath(home) : selected.path;
  const assertFiles = selected.token && !selected.path.startsWith('env:') ? credentialFiles(resolve(path)) : undefined;
  const assertCurrent = () => {
    assertInvocation(); assertGet(); native?.assertCurrent();
    if (shellPaths.homeDirectory !== home || reader.get !== get
      || !isDeepStrictEqual(captureStrictJudgmentJson(get.call(reader, 'controlPlane.host')), host)
      || !isDeepStrictEqual(captureStrictJudgmentJson(get.call(reader, 'controlPlane.port')), port)) held();
    assertGet(); native?.assertCurrent(); assertFiles?.();
    if (readConnectedHostOperatorToken(home, baseUrl).selectionIdentity !== selected.selectionIdentity) held();
    assertGet(); native?.assertCurrent(); assertInvocation();
  };
  assertCurrent();
  return { baseUrl, token: selected.token, tokenPath: selected.path, assertCurrent };
}

export function assertOperatorEffect(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  outward = false): void {
  if (!assertCurrentToolEffect(args, options, 'write') || (outward && !assertCurrentToolEffect(args, options, 'send'))) {
    throw new Error('Connected operator effects require current recorded effect admission.');
  }
  options?.signal?.throwIfAborted();
}
