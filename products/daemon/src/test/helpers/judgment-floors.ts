import { spyOn } from 'bun:test';
import type { JudgmentRequest, JudgmentResult, Questions } from '@goodvibes-jev/judgment';
import * as runtime from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';

/** Each real hosted floor owns its own port and log. Script that floor's
 * semantic endpoint without replacing its authority or runtime services. */
export function observeFixtureJudgmentFloors(read: <Q extends Questions>(
  request: JudgmentRequest<Q>,
  judgment: ReturnType<typeof runtime.createClientRuntimeServices>['judgment'],
) => Promise<JudgmentResult<Q>>) {
  const create = runtime.createClientRuntimeServices;
  const endpoints: { mockRestore(): void }[] = [];
  const construction = spyOn(runtime, 'createClientRuntimeServices').mockImplementation(options => {
    const floor = create(options);
    endpoints.push(spyOn(floor.judgment.port, 'ask').mockImplementation(request => read(request, floor.judgment)));
    return floor;
  });
  return () => { for (const endpoint of endpoints) endpoint.mockRestore(); construction.mockRestore(); };
}
