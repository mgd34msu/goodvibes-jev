import {
  buildSandboxReview,
  type ConfigManagerLike,
} from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';

/** Product presentation only: all sandbox state comes from the public SDK. */
export function renderSandboxDoctor(manager: ConfigManagerLike): string {
  const review = buildSandboxReview(manager);
  const probe = review.backendProbe;
  return [
    'Sandbox doctor',
    `  backend: ${probe?.resolvedBackend ?? review.config.vmBackend}`,
    '  execution: host-local processes; no VM guest',
    ...(probe?.backends ?? []).map((backend) => `  ${backend.id}: ${backend.available ? 'available' : 'missing'} (${backend.detail})`),
    ...(probe?.warnings ?? []).map((warning) => `  warning: ${warning}`),
    ...review.host.warnings.map((warning) => `  warning: ${warning}`),
  ].join('\n');
}
