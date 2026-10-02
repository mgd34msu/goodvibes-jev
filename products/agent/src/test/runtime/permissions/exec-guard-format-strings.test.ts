/**
 * Format and encoded arguments reach the canonical gate unchanged. The AST
 * verdict describes runnable segments; Jev reads obfuscation and the preset
 * asks the owner at critical stakes. The exec guard repeats only catastrophe.
 *
 * Scripted judgments test that composition, not a replacement text classifier.
 */
import { describe, it, expect } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  decideByPreset,
  forgetCatastrophicReadings,
  GATE_PRESETS,
  readToolCall,
} from '@goodvibes-jev/engine/sdk/platform/gate';
import { guardExecCommand } from '@goodvibes-jev/engine/sdk/platform/tools';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { parseCommandAST, evaluateCommandAST } from '@/runtime/index.ts';

const AST_FLAGS = { isEnabled: (id: string) => id === 'shell-ast-normalization' };

async function withCommandReading(
  command: string,
  obfuscated: boolean | 'uncertain',
  check: (reading: Awaited<ReturnType<typeof readToolCall>>) => Promise<void>,
): Promise<void> {
  const { port, requests } = fakePort((name, question) => {
    if (name === 'family') return choiceAnswer(question, 'generic', 0.97);
    if (question.type !== 'noul') throw new Error(`Unexpected gate question: ${name}`);
    return noulAnswer(name === 'obfuscated'
      ? obfuscated === 'uncertain' ? 0.5 : obfuscated ? 0.97 : 0.03
      : 0.03);
  });
  forgetCatastrophicReadings();
  const previous = installJudgmentPort(port);
  try {
    const reading = await readToolCall({ toolName: 'exec', args: { command }, askObfuscated: true });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.state).toEqual({ tool: 'exec', arguments: { command } });
    }
    expect(requests.some((request) => Object.hasOwn(request.questions, 'obfuscated'))).toBe(true);
    await check(reading);
  } finally {
    installJudgmentPort(previous);
    forgetCatastrophicReadings();
  }
}

const formatCommands: ReadonlyArray<[label: string, command: string]> = [
  ['printf width specifiers', 'printf "%4d %4d %-20s\\n" 1 2 three'],
  ['printf zero-padded pairs', 'printf "%02d:%02d\\n" 7 5'],
  ['printf short width', 'printf "%2d\\n" 9'],
  ['printf hex-float conversion', 'printf "%0a\\n" 1'],
  ['date strftime specifier', 'date +%ad'],
  ['date full timestamp', 'date +%Y%m%d'],
  ['awk formatted report', 'awk "{printf \\"%20s %02d\\", $1, $2}" report.txt'],
  ['seq format', 'seq -f "%02g" 1 5'],
  ['bare percent-two-hex token', 'echo %4d'],
];

const encodedCommands: ReadonlyArray<[label: string, command: string]> = [
  ['percent-encoded path in a URL', 'curl http://example.com/path%2Fetc%2Fpasswd'],
  ['encoded path separator without a scheme', 'bash %2Fbin%2Fsh'],
  ['encoded backslash separator', 'cat %5Cetc%5Cpasswd'],
  ['encoded null byte', 'curl http://example.com/a%00b'],
];

describe('exec guard: format specifiers are not an independent denial rule', () => {
  for (const [label, command] of formatCommands) {
    it(`runs ${label} when the gate reads it as ordinary formatting`, async () => {
      const verdict = evaluateCommandAST(command, parseCommandAST(command));
      expect(verdict.allowed).toBe(true);
      expect(verdict.segments).toHaveLength(1);
      await withCommandReading(command, false, async (reading) => {
        expect(reading.stakes).toBe('low');
        expect(decideByPreset(GATE_PRESETS.auto, {
          stakes: reading.stakes,
          family: reading.family,
          changesState: reading.mutates || reading.outward,
        }).action).toBe('allow');
        const guarded = await guardExecCommand(command, AST_FLAGS);
        expect(guarded.allowed).toBe(true);
        expect(guarded.astModeActive).toBe(true);
        expect(guarded.verdict?.segments).toEqual(verdict.segments);
      });
    });
  }
});

describe('encoded arguments: obfuscation readings still require the owner', () => {
  for (const [label, command] of encodedCommands) {
    it(`escalates a reading of ${label} to critical stakes`, async () => {
      // These bytes must survive parsing so the gate can interpret their use.
      const verdict = evaluateCommandAST(command, parseCommandAST(command));
      expect(verdict.allowed).toBe(true);
      expect(verdict.segments[0]?.raw).toBe(command);
      await withCommandReading(command, true, async (reading) => {
        expect(reading.stakes).toBe('critical');
        for (const preset of Object.values(GATE_PRESETS)) {
          expect(decideByPreset(preset, {
            stakes: reading.stakes,
            family: reading.family,
            changesState: reading.mutates || reading.outward,
          }).action).toBe('ask');
        }
        // After gate approval, exec must not add the retired percent regex.
        expect((await guardExecCommand(command, AST_FLAGS)).allowed).toBe(true);
      });
    });
  }

  it('asks the owner when the obfuscation reading is uncertain', async () => {
    await withCommandReading('bash %2Fbin%2Fsh', 'uncertain', async (reading) => {
      expect(reading.uncertain).toContain('obfuscated');
      expect(reading.stakes).toBe('critical');
      expect(decideByPreset(GATE_PRESETS.auto, {
        stakes: reading.stakes,
        family: reading.family,
        changesState: reading.mutates || reading.outward,
      }).action).toBe('ask');
    });
  });
});
