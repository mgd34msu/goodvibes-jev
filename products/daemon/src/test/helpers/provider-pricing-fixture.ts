/** Only the external catalog transport is synthetic; product pricing and registry code run unchanged. */
import { spyOn } from 'bun:test';
export function installProviderPricingFixture(): () => void {
  const original = globalThis.fetch;
  const urls = new Set(['https://aihubmix.com/api/v1/models', 'https://ai-gateway.vercel.sh/v1/models']);
  const fixture = Object.assign(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const input = args[0];
    const url = input instanceof Request ? input.url : String(input);
    if (urls.has(url)) return Response.json({ data: [] });
    return original(...args);
  }, { preconnect: original.preconnect });
  const spy = spyOn(globalThis, 'fetch').mockImplementation(fixture);
  return () => spy.mockRestore();
}
