/**
 * `engine.state.memory-usage`: did a model response actually use one memory
 * that was injected into its prompt, read by Jev in place of the stopword
 * list, distinctive-token overlap count (two shared tokens, or one of six
 * letters or more) and shared two-word phrase test memory-usage-detection.ts
 * used to guess with.
 *
 * One request per injected memory. State: `{ memory, response }` where
 * `memory` is the record's summary and detail and `response` is the model's
 * output text.
 *
 * Band: low stakes. The answer only feeds usage counters that order the idle
 * consolidation's decay, and decay is reversible (a lowered confidence or a
 * stale mark, never a delete).
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const K8S_MEMORY = {
  summary: 'Kubernetes rollouts use the blue-green strategy via deploy/rollout.sh',
  detail: 'Never run kubectl apply directly against production.',
};

const PORT_MEMORY = { summary: 'The daemon listens on port 3421 unless daemon.port is set in settings.json' };

export const memoryUsage = defineBattery({
  name: 'engine.state.memory-usage',
  version: 1,
  description: 'Whether a model response shows it used the specific information in one injected memory, as opposed to the memory merely being present in its prompt.',
  accuracyFloor: 0.9,
  items: {
    used: yesNo(
      'Does `response` use the specific information in `memory`: stating it, applying it, or acting on it?',
      STAKES_BANDS.low.yesNo,
      {
        true: 'The response contains or relies on something only this memory supplies.',
        false: 'The response does not draw on this memory; at most it touches the same general topic or shares common words with it.',
      },
    ),
  },
  fixtures: [
    {
      name: 'rollout done the remembered way',
      state: { memory: K8S_MEMORY, response: 'I ran deploy/rollout.sh, which does a blue-green switch, instead of applying the manifests with kubectl.' },
      expect: { used: 'yes' },
    },
    {
      name: 'port stated from memory',
      state: { memory: PORT_MEMORY, response: 'The daemon is listening on 3421, the default, since settings.json has no daemon.port entry.' },
      expect: { used: 'yes' },
    },
    {
      name: 'same topic, remembered procedure ignored',
      state: { memory: K8S_MEMORY, response: 'I updated the Kubernetes deployment manifest to raise the replica count to 4.' },
      expect: { used: 'no' },
    },
    {
      name: 'common words only',
      state: { memory: PORT_MEMORY, response: 'The settings page now lists every option unless it is hidden by the admin.' },
      expect: { used: 'no' },
    },
    {
      name: 'unrelated answer',
      state: { memory: K8S_MEMORY, response: 'Renamed the helper to formatDuration and updated its three call sites.' },
      expect: { used: 'no' },
    },
  ],
});
