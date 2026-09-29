/**
 * A GET to the knowledge GraphQL route is refused with 405 when the operation
 * that would run is a mutation, decided from the parsed document (operationName
 * picks the operation), not from how the document text starts.
 */
import { describe, expect, test } from 'bun:test';
import { createDaemonKnowledgeRouteHandlers } from '../daemon-sdk/src/knowledge-routes.ts';
import type { DaemonKnowledgeRouteContext } from '../daemon-sdk/src/knowledge-route-types.ts';
import { inspectKnowledgeGraphqlAccess } from '../sdk/src/platform/knowledge/graphql.ts';

const DOCUMENT = 'query Read { status } mutation Write { reindex { ok } }';

function handlers(executed: string[]) {
  // Only the members the GraphQL route reads are supplied; the rest of the
  // context belongs to other knowledge routes this test does not call.
  const context = {
    inspectGraphqlAccess: inspectKnowledgeGraphqlAccess,
    parseOptionalJsonBody: async () => null,
    parseJsonText: (raw: string) => JSON.parse(raw) as Record<string, unknown>,
    resolveAuthenticatedPrincipal: () => ({ admin: true, scopes: ['read:knowledge', 'write:knowledge'] }),
    knowledgeGraphqlService: {
      schemaText: '',
      execute: async (input: { operationName?: string }) => {
        executed.push(input.operationName ?? '');
        return { data: { ok: true } };
      },
    },
  } as unknown as DaemonKnowledgeRouteContext;
  return createDaemonKnowledgeRouteHandlers(context);
}

function get(operationName: string): Request {
  const url = new URL('http://daemon.local/api/knowledge/graphql');
  url.searchParams.set('query', DOCUMENT);
  url.searchParams.set('operationName', operationName);
  return new Request(url, { method: 'GET' });
}

describe('knowledge GraphQL over GET', () => {
  test('a document that starts with a query but selects a mutation is refused', async () => {
    const executed: string[] = [];
    const response = await handlers(executed).executeKnowledgeGraphql(get('Write'));
    expect(response.status).toBe(405);
    expect(executed).toEqual([]);
  });

  test('the query operation of the same document runs', async () => {
    const executed: string[] = [];
    const response = await handlers(executed).executeKnowledgeGraphql(get('Read'));
    expect(response.status).toBe(200);
    expect(executed).toEqual(['Read']);
  });
});
