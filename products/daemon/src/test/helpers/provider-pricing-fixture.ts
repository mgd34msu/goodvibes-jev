/** Catalog replies and explicitly supplied transport replies are synthetic; other requests use guarded fetch. */
import { spyOn } from 'bun:test';
export function installProviderPricingFixture(additionalResponse?: (request: {
  readonly url: string; readonly method: string;
}) => Response | undefined): () => void {
  const original = globalThis.fetch;
  const urls = new Set(['https://aihubmix.com/api/v1/models', 'https://ai-gateway.vercel.sh/v1/models']);
  const fixture = Object.assign(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const input = args[0];
    const url = input instanceof Request ? input.url : String(input);
    if (urls.has(url)) return Response.json({ data: [] });
    const response = additionalResponse?.({ url, method: args[1]?.method ?? (input instanceof Request ? input.method : 'GET') });
    if (response) return response;
    return original(...args);
  }, { preconnect: original.preconnect });
  const spy = spyOn(globalThis, 'fetch').mockImplementation(fixture);
  return () => spy.mockRestore();
}
