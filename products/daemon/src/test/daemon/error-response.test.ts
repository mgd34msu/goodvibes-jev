import { expect, test } from 'bun:test';
import { jsonErrorResponse } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { ProviderError } from '@goodvibes-jev/engine/sdk/platform/types';
const failure = () => new ProviderError('inceptionlabs chat request failed 401: token rejected', {
  statusCode: 401, provider: 'inceptionlabs', operation: 'chat', phase: 'request', requestId: 'req-401', providerCode: 'invalid_api_key',
});
test('real ProviderError preserves status/category/source and compatible message while protecting privileged metadata', async () => {
  const response = jsonErrorResponse(failure(), { status: 400 }); expect(response.status).toBe(400);
  const body = await response.json();
  expect(body).toMatchObject({ code: 'PROVIDER_ERROR', category: 'authentication', source: 'provider', recoverable: false, status: 400 });
  expect(body.error).toBe('inceptionlabs chat request failed 401: token rejected (code=invalid_api_key, request_id=req-401)');
  expect(body.hint).toBe('The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.');
  expect(body.requestId).toBe('req-401'); expect(body.providerCode).toBeUndefined(); expect(body.provider).toBeUndefined();
  const privileged = jsonErrorResponse(failure(), { status: 400, isPrivileged: true });
  const diagnostic = await privileged.json();
  expect(diagnostic).toMatchObject({ code: 'PROVIDER_ERROR', category: 'authentication', source: 'provider', status: 400,
    requestId: 'req-401', providerCode: 'invalid_api_key', provider: 'inceptionlabs', operation: 'chat', phase: 'request' });
  expect(diagnostic.error).toContain('token rejected'); expect(diagnostic.error).toContain('request_id=req-401');
});
