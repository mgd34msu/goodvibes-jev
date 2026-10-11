/** Original five route seams, strengthened to actual product HTTP composition. */
import { expect, test } from 'bun:test';
import { listProviderRuntimeSnapshots } from '@goodvibes-jev/engine/sdk/platform/providers';
import { getKnowledgeGraphqlSchemaText } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { useGatewayFixture } from '../helpers/gateway-route-fixture.js';
const fixture = useGatewayFixture({ hostSessions: false });

test('channel route observes the composed real surface registry', async () => {
  const response = await fixture().fetch('/api/surfaces'); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ surfaces: fixture().services.surfaceRegistry.list() });
  expect(fixture().services.surfaceRegistry.list().length).toBeGreaterThan(0);
});
test('integration route observes provider runtime snapshots from the real registry', async () => {
  const response = await fixture().fetch('/api/providers'); expect(response.status).toBe(200);
  const expected = await listProviderRuntimeSnapshots(fixture().services.providerRegistry);
  const received = await response.json() as { providers: Array<{ providerId: string }> };
  expect(received.providers.map(provider => provider.providerId).sort()).toEqual(expected.map(provider => provider.providerId).sort());
  expect(received.providers.some(provider => provider.providerId === 'mock')).toBe(true);
});
test('system service status exposes actual configured TLS inspector state', async () => {
  const response = await fixture().fetch('/api/service/status'); expect(response.status).toBe(200);
  const body = await response.json() as { installed: boolean; network: { controlPlane: { mode: string }; httpListener: { mode: string }; outbound: { mode: string } } };
  expect(typeof body.installed).toBe('boolean');
  expect(body.network).toMatchObject({ controlPlane: { mode: 'off' }, httpListener: { mode: 'off' }, outbound: { mode: 'bundled' } });
});
test('knowledge route serves the real schema and executes it through the real knowledge service', async () => {
  const response = await fixture().fetch('/api/knowledge/graphql/schema'); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ language: 'graphql', domain: 'knowledge', schema: getKnowledgeGraphqlSchemaText() });
  const query = await fixture().fetch('/api/knowledge/graphql', { method: 'POST', body: JSON.stringify({ query: '{ __typename }' }) });
  expect(query.status).toBe(200); expect(await query.json()).toEqual({ data: { __typename: 'Query' } });
});
test('media route lists and reads bytes retained by the actual product artifact store', async () => {
  const created = await fixture().fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ kind: 'attachment', mimeType: 'text/plain', filename: 'route-proof.txt', text: 'exact route-seam bytes' }) });
  expect(created.status).toBe(201); const { artifact } = await created.json() as { artifact: { id: string } };
  const response = await fixture().fetch('/api/artifacts'); expect(response.status).toBe(200);
  expect((await response.json() as { artifacts: { id: string }[] }).artifacts.some(row => row.id === artifact.id)).toBe(true);
  const read = await fixture().services.artifactStore.readContent(artifact.id);
  expect(Buffer.from(read!.buffer).toString()).toBe('exact route-seam bytes');
});
