/**
 * The release scripts' error decisions: whether a failed package install is a
 * transient network fault worth retrying (scripts/install-retry.ts, used by
 * the install smoke and the artifact lane), and whether a failed `npm view`
 * means the package or version is absent from the registry
 * (scripts/verify-published-packages.ts).
 *
 * Structured codes decide without a reading; only wording with no code goes
 * through the failure battery, answered here by a fake port.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

import {
  installErrorCode,
  isTransientInstallFailure,
  retryTransientInstall,
} from '../scripts/install-retry.ts';
import {
  isMissingPublishedVersionError,
  npmViewErrorCode,
  parseNpmViewString,
} from '../scripts/verify-published-packages.ts';
import { useFailureReadings } from './_helpers/failure-readings.ts';

function commandError(message: string, output: { stderr?: string; stdout?: string; code?: string } = {}): Error {
  return Object.assign(new Error(message), output);
}

describe('installErrorCode', () => {
  test('reads the error object code first (a spawn failure)', () => {
    expect(installErrorCode(commandError('spawn npm ENOENT', { code: 'ENOENT' }))).toBe('ENOENT');
  });

  test('reads the code npm prints on its fixed code line, in both npm spellings', () => {
    const current = commandError('Command failed: npm install', { stderr: 'npm error code ECONNRESET\nnpm error network aborted\n' });
    const legacy = commandError('Command failed: npm install', { stderr: 'npm ERR! code ETIMEDOUT\n' });
    expect(installErrorCode(current)).toBe('ECONNRESET');
    expect(installErrorCode(legacy)).toBe('ETIMEDOUT');
  });

  test('is null when neither the error nor npm names a code', () => {
    expect(installErrorCode(commandError('Command failed: bun add', { stderr: 'error: ConnectionRefused downloading package manifest zod' }))).toBeNull();
  });
});

describe('isTransientInstallFailure', () => {
  const readings = useFailureReadings([
    ['ConnectionRefused downloading', { category: 'network', transientNetwork: true, beforeResponse: true }],
    ['package "@goodvibes-jev/engine" not found', { category: 'not_found' }],
  ]);

  test('a transient errno code retries without a reading', async () => {
    const error = commandError('Command failed: npm install', { stderr: 'npm error code ECONNRESET\n' });
    expect(await isTransientInstallFailure(error, 'test.install')).toBe(true);
    expect(readings.requests).toHaveLength(0);
  });

  test('any other code does not retry and asks nothing', async () => {
    const notFound = commandError('Command failed: npm install', { stderr: 'npm error code E404\nnpm error 404 Not Found\n' });
    const integrity = commandError('Command failed: npm install', { stderr: 'npm error code EINTEGRITY\n' });
    expect(await isTransientInstallFailure(notFound, 'test.install')).toBe(false);
    expect(await isTransientInstallFailure(integrity, 'test.install')).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('with no code, the wording is read and a transient network reading retries', async () => {
    const error = commandError('Command failed: bun add', { stderr: 'error: ConnectionRefused downloading package manifest zod' });
    expect(await isTransientInstallFailure(error, 'test.install')).toBe(true);
    expect(readings.requests.length).toBeGreaterThan(0);
  });

  test('with no code, a reading that is not a network fault does not retry', async () => {
    const error = commandError('Command failed: bun add', { stderr: 'error: package "@goodvibes-jev/engine" not found' });
    expect(await isTransientInstallFailure(error, 'test.install')).toBe(false);
  });

  test('a failure that does not retry is thrown on the first attempt', async () => {
    let calls = 0;
    const failure = commandError('Command failed: npm install', { stderr: 'npm error code E404\n' });
    await expect(retryTransientInstall(() => {
      calls += 1;
      throw failure;
    }, { prefix: 'test', label: 'npm install', site: 'test.install' })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

describe('isTransientInstallFailure without a judgment port', () => {
  const savedKey = process.env['TYPESAFE_API_KEY'];
  let previous: ReturnType<typeof installJudgmentPort>;
  afterEach(() => {
    installJudgmentPort(previous);
    if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY'];
    else process.env['TYPESAFE_API_KEY'] = savedKey;
  });

  test('wording with no code and no way to read it fails loudly instead of guessing', async () => {
    previous = installJudgmentPort(undefined);
    delete process.env['TYPESAFE_API_KEY'];
    const error = commandError('Command failed: bun add', { stderr: 'error: ConnectionRefused downloading package manifest zod' });
    await expect(isTransientInstallFailure(error, 'test.install')).rejects.toThrow('could not be read');
  });
});

describe('npm view --json error codes', () => {
  function viewError(stdout: string): Error {
    return commandError('Command failed: npm view', { stdout });
  }

  test('an absent package or version is code E404 in the JSON error, never read from wording', () => {
    const absentVersion = viewError(JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 9.9.9' } }));
    const absentTarget = viewError(JSON.stringify({ error: { code: 'ETARGET', summary: 'No matching version' } }));
    expect(npmViewErrorCode(absentVersion)).toBe('E404');
    expect(isMissingPublishedVersionError(absentVersion)).toBe(true);
    expect(isMissingPublishedVersionError(absentTarget)).toBe(true);
  });

  test('any other failure is not treated as absent', () => {
    expect(isMissingPublishedVersionError(viewError(JSON.stringify({ error: { code: 'E500', summary: 'Internal Server Error' } })))).toBe(false);
    expect(isMissingPublishedVersionError(viewError('is not in this registry'))).toBe(false);
    expect(isMissingPublishedVersionError(commandError('Command failed: npm view'))).toBe(false);
  });

  test('parses the JSON value npm view prints', () => {
    expect(parseNpmViewString('"2.0.23"\n')).toBe('2.0.23');
    expect(parseNpmViewString('')).toBeNull();
    expect(parseNpmViewString('["2.0.22","2.0.23"]')).toBe('2.0.23');
  });
});
