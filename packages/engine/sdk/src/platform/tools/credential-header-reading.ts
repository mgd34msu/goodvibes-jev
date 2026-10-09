import { JudgmentInputError, snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { CallOptions } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { credentialHeader } from './batteries/credential-header.js';

/** Name-only credential classification. Null means no acting reading; failures propagate. */
export async function readCredentialHeader(
  header: string,
  options: CallOptions = {},
): Promise<boolean | null> {
  const captured = snapshotJudgmentInput(header);
  if (typeof captured !== 'string') throw new JudgmentInputError('unsupported-input');
  const site = options.site ?? 'tools.credential-header';
  options.signal?.throwIfAborted();
  const run = await credentialHeader.run(judgmentPort(site), { header: captured }, { ...options, site });
  options.signal?.throwIfAborted();
  const { verdict, outcome } = run.readings.credential;
  const credential = outcome === 'act' && verdict !== 'uncertain' ? verdict === 'yes' : null;
  run.recordAction(credential === null ? 'credential classification withheld' : credential ? 'classified credential header' : 'classified noncredential header');
  return credential;
}
