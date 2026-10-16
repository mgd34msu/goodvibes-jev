import type { OperatorSdkOptions } from '@goodvibes-jev/engine/operator-sdk';

type NativeHostFetch = NonNullable<OperatorSdkOptions['fetchImpl']>;

/** Enforce the exact authority at the final network boundary, after asynchronous
 * SDK middleware and on every transport retry. Redirects must never forward
 * original source/mutation bodies or substitute another authority's response.
 */
export function createNativeHostFetch(options: { readonly current: () => boolean; readonly fetchImpl?: NativeHostFetch }): NativeHostFetch {
  return async (input, init) => {
    if (!options.current()) throw new Error('Native host selection changed.');
    const response = await (options.fetchImpl ?? fetch)(input, { ...init, redirect: 'error' });
    if (!options.current()) throw new Error('Native host selection changed.');
    return response;
  };
}
