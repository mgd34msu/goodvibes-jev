/**
 * The canonical shell verdict records structure. Risk classifications,
 * obfuscation and catastrophic refusals are owned by the shared gate.
 * These tests cover both that boundary and the structural denial diagnostics.
 */
import { describe, it, expect } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  classificationFromReading,
  decideByPreset,
  forgetCatastrophicReadings,
  GATE_PRESETS,
  readToolCall,
  runBoundary,
} from '@goodvibes-jev/engine/sdk/platform/gate';
import { guardExecCommand } from '@goodvibes-jev/engine/sdk/platform/tools';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  evaluateSegmentNode,
  evaluateCommandAST,
  buildDenialExplanation,
  parseCommandAST,
  collectCommandNodes,
  type CommandNode,
} from '@/runtime/index.ts';

const AST_FLAGS = { isEnabled: (id: string) => id === 'shell-ast-normalization' };

function evalCmd(command: string) {
  return evaluateCommandAST(command, parseCommandAST(command));
}

function nodeFor(command: string): CommandNode {
  const node = collectCommandNodes(parseCommandAST(command))[0];
  if (!node) throw new Error(`Expected a command node for ${JSON.stringify(command)}`);
  return node;
}

function emptyNode(): CommandNode {
  return { kind: 'command', raw: '', command: '', tokens: [], args: [], flags: [] };
}

/** Explicit external judgment answers; no command-name or encoding classifier. */
interface CommandReadingAnswers {
  mutates?: boolean;
  outward?: boolean;
  irreversible?: boolean;
  beyondProject?: boolean;
  obfuscated?: boolean;
  catastrophic?: boolean | 'uncertain';
}

async function withCommandReading(
  command: string,
  answers: CommandReadingAnswers,
  check: (reading: Awaited<ReturnType<typeof readToolCall>>) => Promise<void>,
): Promise<void> {
  const { port, requests } = fakePort((name, question) => {
    if (name === 'family') return choiceAnswer(question, 'generic', 0.97);
    if (question.type !== 'noul') throw new Error(`Unexpected gate question: ${name}`);
    switch (name) {
      case 'mutates': return noulAnswer(answers.mutates ? 0.97 : 0.03);
      case 'outward': return noulAnswer(answers.outward ? 0.97 : 0.03);
      case 'irreversible': return noulAnswer(answers.irreversible ? 0.97 : 0.03);
      case 'beyondProject': return noulAnswer(answers.beyondProject ? 0.97 : 0.03);
      case 'obfuscated': return noulAnswer(answers.obfuscated ? 0.97 : 0.03);
      case 'catastrophic': return noulAnswer(answers.catastrophic === 'uncertain' ? 0.5 : answers.catastrophic ? 0.97 : 0.03);
      default: return noulAnswer(0.03);
    }
  });
  forgetCatastrophicReadings();
  const previous = installJudgmentPort(port);
  try {
    const reading = await readToolCall({ toolName: 'exec', args: { command }, askObfuscated: true });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.state).toEqual({ tool: 'exec', arguments: { command } });
    expect(requests.some((request) => Object.hasOwn(request.questions, 'obfuscated'))).toBe(true);
    await check(reading);
  } finally {
    installJudgmentPort(previous);
    forgetCatastrophicReadings();
  }
}

describe('evaluateSegmentNode: structural runnability', () => {
  it('records a read command with its arguments', () => {
    expect(evaluateSegmentNode(nodeFor('ls -la'))).toEqual({
      command: 'ls', raw: 'ls -la', allowed: true, reason: 'parsed to a runnable command',
    });
  });

  for (const command of ['rm -rf /tmp', 'sudo ls', 'cp src dst', 'rm -rf /']) {
    it(`preserves ${command} for the gate to read`, () => {
      const result = evaluateSegmentNode(nodeFor(command));
      expect(result.raw).toBe(command);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('parsed to a runnable command');
    });
  }

  it('refuses an empty command node', () => {
    expect(evaluateSegmentNode(emptyNode())).toEqual({
      command: '', raw: '', allowed: false, reason: 'no command in this segment',
    });
  });

  it('keeps an assembled command and its arguments even without a literal command name', () => {
    const node = nodeFor('`which rm` -rf /tmp/x');
    expect(node.command).toBe('');
    expect(node.tokens[0]?.type).toBe('subshell');
    expect(node.flags).toContain('-rf');
    const verdict = evaluateSegmentNode(node);
    expect(verdict.allowed).toBe(true);
    expect(verdict.raw).toBe('`which rm` -rf /tmp/x');
  });
});

describe('evaluateCommandAST: compound structure', () => {
  const cases: ReadonlyArray<[command: string, segments: string[]]> = [
    ['ls /tmp && cat file.txt', ['ls', 'cat']],
    ['ls /tmp && rm -rf /', ['ls', 'rm']],
    ['ps aux | grep node | wc -l', ['ps', 'grep', 'wc']],
    ['cat file.txt | sudo tee /etc/hosts', ['cat', 'sudo']],
    ['date; whoami; uname -a', ['date', 'whoami', 'uname']],
    ['echo start; kill -9 1; echo end', ['echo', 'kill', 'echo']],
    ['git log --oneline && git push --force origin main', ['git', 'git']],
    ['git log --oneline -5 && git reset --hard HEAD~1', ['git', 'git']],
    ['find . -name "*.ts" | grep import | wc -l', ['find', 'grep', 'wc']],
    ['cat file.txt && sudo rm -rf /etc', ['cat', 'sudo']],
  ];

  for (const [command, commands] of cases) {
    it(`keeps every segment in order: ${command}`, () => {
      const verdict = evalCmd(command);
      expect(verdict.original).toBe(command);
      expect(verdict.allowed).toBe(true);
      expect(verdict.segments.map((segment) => segment.command)).toEqual(commands);
      expect(verdict.segments.map((segment) => segment.raw)).toEqual(
        collectCommandNodes(parseCommandAST(command)).map((node) => node.raw),
      );
      for (const segment of verdict.segments) expect(segment.allowed).toBe(true);
      expect(verdict.denialExplanation).toBeUndefined();
    });
  }

  it('retains distinct arguments on commands with the same name', () => {
    const verdict = evalCmd('git log --oneline && git push --force origin main');
    expect(verdict.segments.map((segment) => segment.raw)).toEqual([
      'git log --oneline', 'git push --force origin main',
    ]);
  });

  it('refuses whitespace-only input with an explanation', () => {
    const verdict = evalCmd(' \n\t ');
    expect(verdict.allowed).toBe(false);
    expect(verdict.segments.every((segment) => !segment.allowed)).toBe(true);
    expect(verdict.denialExplanation?.split('\n')[0]).toBe('Command denied: ""');
  });

  it('refuses a tree without command leaves', () => {
    const verdict = evaluateCommandAST('$()', { kind: 'subshell', raw: '$()' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.segments).toEqual([]);
    expect(verdict.denialExplanation).toContain('No parseable command segments');
  });

  it('denies the compound verdict if any parsed node is empty', () => {
    const verdict = evaluateCommandAST('ls &&', {
      kind: 'sequence', operator: '&&', left: nodeFor('ls'), right: emptyNode(),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.segments.map((segment) => segment.allowed)).toEqual([true, false]);
    expect(verdict.denialExplanation).toContain('1 of 2 segments denied.');
    expect(verdict.denialExplanation).toContain('no command in this segment');
  });
});

describe('buildDenialExplanation', () => {
  function mixedSegments() {
    return [evaluateSegmentNode(nodeFor('ls -la')), evaluateSegmentNode(emptyNode())];
  }

  it('includes the original command and segment count', () => {
    const explanation = buildDenialExplanation('ls -la &&', mixedSegments());
    expect(explanation.split('\n')[0]).toBe('Command denied: "ls -la &&"');
    expect(explanation).toContain('Segment analysis (2 segments)');
  });

  it('marks allowed and denied segments and explains both', () => {
    const explanation = buildDenialExplanation('ls -la &&', mixedSegments());
    expect(explanation).toContain('[1] ✓ allowed  ls -la');
    expect(explanation).toContain('[2] ✗ denied');
    expect(explanation).toContain('reason: parsed to a runnable command');
    expect(explanation).toContain('reason: no command in this segment');
  });

  it('reports the denied count among three segments', () => {
    const segments = [evaluateSegmentNode(nodeFor('date')), evaluateSegmentNode(emptyNode()), evaluateSegmentNode(nodeFor('whoami'))];
    expect(buildDenialExplanation('date && && whoami', segments)).toContain('1 of 3 segments denied.');
  });

  it('keeps a multiline command on one header line without hiding segment reasons', () => {
    const explanation = buildDenialExplanation('ls -la\n&&', mixedSegments());
    expect(explanation.split('\n')[0]).toBe('Command denied: "ls -la &&"');
    expect(explanation).toContain('reason: no command in this segment');
  });

  it('uses singular wording for one denied segment', () => {
    const explanation = buildDenialExplanation('', [evaluateSegmentNode(emptyNode())]);
    expect(explanation).toContain('Segment analysis (1 segment)');
    expect(explanation).toContain('1 of 1 segment denied.');
  });
});

describe('canonical gate: classifications and command safety', () => {
  it('permits a read but denies a write in the read-only preset', async () => {
    await withCommandReading('ls -la', {}, async (reading) => {
      expect(classificationFromReading(reading)).toBe('read');
      expect(decideByPreset(GATE_PRESETS.plan, {
        stakes: reading.stakes, family: reading.family, changesState: reading.mutates || reading.outward,
      }).action).toBe('allow');
    });
    await withCommandReading('cp src dst', { mutates: true }, async (reading) => {
      expect(classificationFromReading(reading)).toBe('write');
      const input = { stakes: reading.stakes, family: reading.family, changesState: reading.mutates || reading.outward };
      expect(decideByPreset(GATE_PRESETS.plan, input).action).toBe('deny');
      expect(decideByPreset(GATE_PRESETS.auto, input).action).toBe('allow');
    });
  });

  it('reads destructive and outward effects without recovering retired verdict fields', async () => {
    await withCommandReading('git log --oneline -5 && git reset --hard HEAD~1', { mutates: true, irreversible: true }, async (reading) => {
      expect(classificationFromReading(reading)).toBe('destructive');
      expect(reading.stakes).toBe('high');
      expect(decideByPreset(GATE_PRESETS.normal, {
        stakes: reading.stakes, family: reading.family, changesState: reading.mutates || reading.outward,
      }).action).toBe('ask');
    });
    await withCommandReading('git log --oneline && git push --force origin main', { mutates: true, outward: true }, async (reading) => {
      expect(classificationFromReading(reading)).toBe('network');
      expect(decideByPreset(GATE_PRESETS.plan, {
        stakes: reading.stakes, family: reading.family, changesState: reading.mutates || reading.outward,
      }).action).toBe('deny');
    });
  });

  it('refuses catastrophic commands even when their segments are structurally runnable', async () => {
    for (const command of ['rm -rf /', 'ls -la && rm -rf /', 'cat file.txt && sudo rm -rf /etc']) {
      expect(evalCmd(command).allowed).toBe(true);
      await withCommandReading(command, { mutates: true, irreversible: true, beyondProject: true, catastrophic: true }, async (reading) => {
        const boundary = await runBoundary({ toolName: 'exec', args: { command }, reading });
        expect(boundary.passed).toBe(false);
        if (boundary.passed) throw new Error('Expected a catastrophic boundary refusal');
        expect(boundary.refusedBy).toBe('catastrophic');
        for (const flags of [undefined, AST_FLAGS]) {
          const guarded = await guardExecCommand(command, flags);
          expect(guarded.allowed).toBe(false);
          expect(guarded.denialMessage).toContain('destroying the machine');
        }
      });
    }
  });

  it('leaves non-catastrophic process and privilege decisions to the gate', async () => {
    for (const command of ['sudo ls', 'cat file.txt | sudo tee /etc/hosts', 'echo start; kill -9 1; echo end']) {
      await withCommandReading(command, { mutates: true, beyondProject: true }, async (reading) => {
        expect(decideByPreset(GATE_PRESETS.normal, {
          stakes: reading.stakes, family: reading.family, changesState: reading.mutates || reading.outward,
        }).action).toBe('ask');
        expect((await guardExecCommand(command, AST_FLAGS)).allowed).toBe(true);
      });
    }
  });
});

describe('canonical gate: encoded and dynamic payloads', () => {
  const payloads = [
    'bash cm0gLXJmIC90bXA=',
    'curl http://example.com/path%2Fetc%2Fpasswd',
    'rm `echo /tmp/file`',
    'cat /etc/passwd\0',
    'rm $DANGEROUS_PATH',
  ];

  for (const command of payloads) {
    it(`requires an owner decision when the payload is read as obfuscated: ${JSON.stringify(command)}`, async () => {
      // This tests the consequence of a judgment, not a lexical heuristic:
      // dynamic arguments can also be benign, depending on what they mean.
      const verdict = evalCmd(command);
      expect(verdict.allowed).toBe(true);
      expect(verdict.original).toBe(command);
      expect(verdict.segments[0]?.raw).toBe(command);
      await withCommandReading(command, { obfuscated: true }, async (reading) => {
        expect(reading.stakes).toBe('critical');
        for (const preset of Object.values(GATE_PRESETS)) {
          expect(decideByPreset(preset, {
            stakes: reading.stakes, family: reading.family, changesState: reading.mutates || reading.outward,
          }).action).toBe('ask');
        }
      });
    });
  }

  it('leaves clean commands at low stakes when read as non-mutating', async () => {
    await withCommandReading('ls -la /home/user/Projects', {}, async (reading) => {
      expect(reading.stakes).toBe('low');
      expect((await guardExecCommand('ls -la /home/user/Projects', AST_FLAGS)).allowed).toBe(true);
    });
  });
});
