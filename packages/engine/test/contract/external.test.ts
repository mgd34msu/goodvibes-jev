/**
 * The external work seam (contract/external.ts, design 8.4): the bridge hands
 * every call to the adapter a surface that does not embed the runner supplied,
 * in order, with the contract's id and status on the request.
 */
import { describe, expect, test } from 'bun:test';
import { ContractExternalWorkBridge, type ContractExternalWorkAdapter } from '../../sdk/src/platform/contract/index.js';

describe('ContractExternalWorkBridge', () => {
  test('dispatch, status, cancel and result go to the adapter', async () => {
    const calls: string[] = [];
    const adapter: ContractExternalWorkAdapter = {
      async dispatch(request) {
        calls.push(`dispatch:${request.task}:${request.contractId ?? ''}:${request.status ?? ''}`);
        return { externalTaskId: 'external-1', status: 'queued' };
      },
      async status(externalTaskId) {
        calls.push(`status:${externalTaskId}`);
        return { externalTaskId, status: 'running', progress: 'Contract ctr-1a2b3c4d: running' };
      },
      async cancel(externalTaskId, reason) {
        calls.push(`cancel:${externalTaskId}:${reason ?? ''}`);
      },
      async result(externalTaskId) {
        calls.push(`result:${externalTaskId}`);
        return { externalTaskId, status: 'completed', summary: 'Contract ctr-1a2b3c4d passed', output: 'The answer.' };
      },
    };
    const bridge = new ContractExternalWorkBridge(adapter);
    await expect(bridge.dispatch({ task: 'partner app task', contractId: 'ctr-1a2b3c4d', status: 'queued' })).resolves.toEqual({ externalTaskId: 'external-1', status: 'queued' });
    await expect(bridge.status('external-1')).resolves.toMatchObject({ status: 'running' });
    await bridge.cancel('external-1', 'the owner stopped it');
    await expect(bridge.result('external-1')).resolves.toMatchObject({ status: 'completed', output: 'The answer.' });
    expect(calls).toEqual([
      'dispatch:partner app task:ctr-1a2b3c4d:queued',
      'status:external-1',
      'cancel:external-1:the owner stopped it',
      'result:external-1',
    ]);
  });
});
