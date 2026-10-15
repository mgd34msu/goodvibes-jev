/**
 * A denied exec command reports its reason at every verbosity.
 *
 * Nothing runs when the guard refuses a command, so the reason IS the result.
 * Verbosity is an output-volume control and used to be applied to it anyway:
 * `minimal` cut the reason to its first line and `count_only` dropped it
 * entirely, so a caller was told only that something failed. A model cannot
 * correct what it cannot see.
 *
 * An empty command exercises parser rejection without attempting a destructive action.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

// The tools batteries exec reads (credential names, prompts, retries) and,
// forwarded with EXEC_GATE_TABLE, the gate's questions, in one fake port.
useToolReadings([], EXEC_GATE_TABLE);

const DENIED = '   ';

interface DenialOutput {
  denied?: boolean;
  denial_reason?: string;
  segments?: Array<{ command: string; classification: string; reason: string }>;
}

function makeTool() {
  const root = mkdtempSync(join(tmpdir(), 'gv-exec-denial-'));
  return { root, tool: createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }), featureFlags: { isEnabled: id => id === 'shell-ast-normalization' } }) };
}

async function denialAt(verbosity: string): Promise<DenialOutput> {
  const { root, tool } = makeTool();
  const result = await tool.execute({ working_dir: root, commands: [{ cmd: DENIED }], verbosity });
  return JSON.parse(result.output ?? '{}') as DenialOutput;
}

describe('exec: a denial keeps its reason at every verbosity', () => {
  for (const verbosity of ['count_only', 'minimal', 'standard', 'verbose']) {
    test(`${verbosity} names the denial and why`, async () => {
      const output = await denialAt(verbosity);

      expect(output.denied).toBe(true);
      expect(typeof output.denial_reason).toBe('string');
      expect(output.denial_reason).toContain('no command in this segment');
      // The reason must actually explain, not just restate the outcome.
      expect((output.denial_reason ?? '').length).toBeGreaterThan(
        'Command denied by policy'.length,
      );
    });
  }

  test('minimal preserves the reason to its first line', async () => {
    const output = await denialAt('minimal');
    expect(output.denial_reason).toContain('no command in this segment');
  });

  test('count_only still carries the reason instead of dropping it', async () => {
    const output = await denialAt('count_only');
    expect(output.denial_reason).toBeDefined();
    expect(output.denial_reason).not.toBe('');
  });
});
