/** Existing canonical UUID fixture whose digits incidentally satisfy the raw PAN guard. */
export const PAN_SHAPED_PROTOCOL_UUID = '01a10407-1f79-7006-8320-47790069cb8a';
export const selectedDiffSource = () => ({ goal: 'Use the supplied display name Bob for the requested project change', criteria: [],
  selectedDiffContext: { kind: 'session' as const, revision: 'a'.repeat(64), fileIndex: 0, hunkIndex: 0,
    unifiedDiff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n',
    provenance: { kind: 'session' as const, sessionId: PAN_SHAPED_PROTOCOL_UUID, baselineCheckpointId: 'baseline', latestCheckpointId: 'latest' } } });
