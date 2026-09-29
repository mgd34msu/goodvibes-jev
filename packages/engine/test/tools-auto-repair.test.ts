import { describe, test, expect } from 'bun:test';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { repairToolCall } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ToolDefinition } from '@goodvibes-jev/engine/sdk/platform/types';

// Jev picks which spare argument fills a missing parameter; these fakes stand
// in for it. A call no entry names reads as "no spare argument fits".
const readings = useToolReadings([
  ['"argument":"pathValue"', { fill: 'pathValue' }],
  ['"argument":"file_path"', { fill: 'file_path' }],
]);

// ---------------------------------------------------------------------------
// Test schema helpers
// ---------------------------------------------------------------------------

const AGENT_SCHEMA: ToolDefinition = {
  name: 'agent',
  description: 'Manages in-process subagents.',
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message'],
      },
      task: { type: 'string' },
      template: { type: 'string', enum: ['engineer', 'reviewer', 'general'] },
      agentId: { type: 'string' },
      timeoutMs: { type: 'number' },
      outsideContract: { type: 'boolean' },
    },
  },
};

const STRING_SCHEMA: ToolDefinition = {
  name: 'read',
  description: 'Read a file.',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string' },
      encoding: { type: 'string' },
    },
  },
};

const NUMBER_SCHEMA: ToolDefinition = {
  name: 'wait',
  description: 'Wait for a duration.',
  parameters: {
    type: 'object',
    required: ['duration'],
    properties: {
      duration: { type: 'number' },
    },
  },
};

const BOOL_SCHEMA: ToolDefinition = {
  name: 'toggle',
  description: 'Toggle a feature.',
  parameters: {
    type: 'object',
    required: ['enabled'],
    properties: {
      enabled: { type: 'boolean' },
    },
  },
};

const ENUM_SCHEMA: ToolDefinition = {
  name: 'set_level',
  description: 'Set log level.',
  parameters: {
    type: 'object',
    required: ['level'],
    properties: {
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
    },
  },
};

// ---------------------------------------------------------------------------
// Rule 1: Missing `mode` on agent tool
// ---------------------------------------------------------------------------

describe('Rule 1: infer agent mode', () => {
  test('infers spawn when task is present', async () => {
    const result = await repairToolCall('agent', { task: 'Write a test' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('spawn');
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toContain('spawn');
  });

  test('infers spawn when template is present (no task)', async () => {
    const result = await repairToolCall('agent', { template: 'engineer' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('spawn');
  });

  test('infers spawn when both task and template are present', async () => {
    const result = await repairToolCall('agent', { task: 'Build it', template: 'engineer' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('spawn');
  });

  test('does not guess a mode from agentId alone (seven modes take it)', async () => {
    const result = await repairToolCall('agent', { agentId: 'abc-123' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['mode']).toBeUndefined();
  });

  test('does not guess a mode for an empty call', async () => {
    const result = await repairToolCall('agent', {}, AGENT_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['mode']).toBeUndefined();
  });

  test('does not overwrite mode when already present', async () => {
    const result = await repairToolCall('agent', { mode: 'cancel', agentId: 'abc-123' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['mode']).toBe('cancel');
  });

  test('does not infer mode for non-agent tools', async () => {
    const result = await repairToolCall('read', { task: 'Build it' }, STRING_SCHEMA);
    // 'task' is not in STRING_SCHEMA, no mode inference attempted
    expect(result.fixed['mode']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 2: Fill missing required string param from non-required param
// ---------------------------------------------------------------------------

describe('Rule 2: fill missing required string params', () => {
  test('fills missing required path from the spare argument Jev picks', async () => {
    const result = await repairToolCall(
      'read',
      { pathValue: '/etc/hosts' },
      {
        name: 'read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            pathValue: { type: 'string' },
          },
        },
      },
    );
    expect(result.repaired).toBe(true);
    expect(result.fixed['path']).toBe('/etc/hosts');
    expect(result.repairs[0]).toContain('pathValue');
  });

  test('does not fill when Jev picks no spare argument', async () => {
    const result = await repairToolCall(
      'read',
      { encoding: '/etc/hosts' },
      STRING_SCHEMA,
    );
    expect(result.repaired).toBe(false);
    expect(result.fixed['path']).toBeUndefined();
  });

  test('removes source key from fixed after copying to missing required param', async () => {
    const result = await repairToolCall(
      'read',
      { pathValue: '/etc/hosts' },
      {
        name: 'read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            pathValue: { type: 'string' },
          },
        },
      },
    );
    expect(result.repaired).toBe(true);
    expect(result.fixed['path']).toBe('/etc/hosts');
    // Source key must be removed to avoid dual values
    expect(result.fixed['pathValue']).toBeUndefined();
    // Original must be unchanged
    expect(result.original['pathValue']).toBe('/etc/hosts');
  });

  test('does not fill when no non-required string args present', async () => {
    const result = await repairToolCall('read', {}, STRING_SCHEMA);
    // No candidates available: nothing is read, missing path stays missing
    expect(readings.requests).toHaveLength(0);
    expect(result.fixed['path']).toBeUndefined();
    expect(result.repaired).toBe(false);
  });

  test('does not fill required param from another required param', async () => {
    const schema: ToolDefinition = {
      name: 'copy',
      description: 'Copy a file.',
      parameters: {
        type: 'object',
        required: ['src', 'dst'],
        properties: {
          src: { type: 'string' },
          dst: { type: 'string' },
        },
      },
    };
    // Both required, should not fill dst from src
    const result = await repairToolCall('copy', { src: '/a/b' }, schema);
    expect(result.fixed['dst']).toBeUndefined();
  });
});

describe('Rule 2: the param-fill reading', () => {
  test('a pick with no name overlap is still filled when Jev picks it', async () => {
    const result = await repairToolCall('read', { file_path: 'src/a.ts', encoding: 'utf-8' }, {
      name: 'read',
      description: 'Read a file.',
      parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, encoding: { type: 'string' } } },
    });
    expect(result.fixed['path']).toBe('src/a.ts');
    expect(result.fixed['file_path']).toBeUndefined();
    expect(result.fixed['encoding']).toBe('utf-8');
  });

  test('the selection offers only spare non-empty strings, with the tool and parameter as context', async () => {
    await repairToolCall('read', { encoding: 'utf-8', empty: '', count: 3 }, STRING_SCHEMA);
    expect(readings.requests).toHaveLength(1);
    const state = readings.requests[0]!.state as { context: { tool: string; missingParameter: string }; candidates: Array<{ id: string }> };
    expect(state.context.tool).toBe('read');
    expect(state.context.missingParameter).toBe('path');
    expect(state.candidates.map((candidate) => candidate.id)).toEqual(['encoding']);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: String → number coercion
// ---------------------------------------------------------------------------

describe('Rule 3: string-to-number coercion', () => {
  test('coerces numeric string to number', async () => {
    const result = await repairToolCall('wait', { duration: '30000' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['duration']).toBe(30000);
    expect(typeof result.fixed['duration']).toBe('number');
    expect(result.repairs[0]).toContain('30000');
  });

  test('coerces zero string', async () => {
    const result = await repairToolCall('wait', { duration: '0' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['duration']).toBe(0);
  });

  test('coerces float string', async () => {
    const result = await repairToolCall('wait', { duration: '1.5' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['duration']).toBe(1.5);
  });

  test('does not coerce non-numeric string', async () => {
    const result = await repairToolCall('wait', { duration: 'forever' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['duration']).toBe('forever');
  });

  test('leaves actual number unchanged', async () => {
    const result = await repairToolCall('wait', { duration: 5000 }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['duration']).toBe(5000);
  });

  test('does not coerce empty string to 0', async () => {
    const result = await repairToolCall('wait', { duration: '' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['duration']).toBe('');
  });

  test('does not coerce whitespace-only string to 0', async () => {
    const result = await repairToolCall('wait', { duration: '   ' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['duration']).toBe('   ');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: Boolean coercion
// ---------------------------------------------------------------------------

describe('Rule 4: boolean coercion', () => {
  test('coerces "true" to true', async () => {
    const result = await repairToolCall('toggle', { enabled: 'true' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['enabled']).toBe(true);
  });

  test('coerces "false" to false', async () => {
    const result = await repairToolCall('toggle', { enabled: 'false' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['enabled']).toBe(false);
  });

  test('coerces "yes" to true', async () => {
    const result = await repairToolCall('toggle', { enabled: 'yes' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['enabled']).toBe(true);
  });

  test('coerces "no" to false', async () => {
    const result = await repairToolCall('toggle', { enabled: 'no' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['enabled']).toBe(false);
  });

  test('coerces case-insensitive variants (TRUE, YES)', async () => {
    const r1 = await repairToolCall('toggle', { enabled: 'TRUE' }, BOOL_SCHEMA);
    expect(r1.fixed['enabled']).toBe(true);
    const r2 = await repairToolCall('toggle', { enabled: 'YES' }, BOOL_SCHEMA);
    expect(r2.fixed['enabled']).toBe(true);
  });

  test('leaves actual boolean unchanged', async () => {
    const result = await repairToolCall('toggle', { enabled: true }, BOOL_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['enabled']).toBe(true);
  });

  test('leaves unrecognised string unchanged', async () => {
    const result = await repairToolCall('toggle', { enabled: 'maybe' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['enabled']).toBe('maybe');
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Enum normalization
// ---------------------------------------------------------------------------

describe('Rule 5: enum normalization', () => {
  test('normalizes wrong-case enum value', async () => {
    const result = await repairToolCall('set_level', { level: 'Debug' }, ENUM_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['level']).toBe('debug');
  });

  test('normalizes all-caps enum value', async () => {
    const result = await repairToolCall('set_level', { level: 'ERROR' }, ENUM_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['level']).toBe('error');
  });

  test('normalizes agent mode enum (Spawn -> spawn)', async () => {
    const result = await repairToolCall('agent', { mode: 'Spawn', task: 'Do it' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('spawn');
  });

  test('leaves exact enum value unchanged', async () => {
    const result = await repairToolCall('set_level', { level: 'warn' }, ENUM_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['level']).toBe('warn');
  });

  test('does not normalize completely wrong enum value', async () => {
    const result = await repairToolCall('set_level', { level: 'verbose' }, ENUM_SCHEMA);
    // 'verbose' not in enum, case-insensitive still no match -> unchanged
    expect(result.repaired).toBe(false);
    expect(result.fixed['level']).toBe('verbose');
  });
});

// ---------------------------------------------------------------------------
// RepairResult contract
// ---------------------------------------------------------------------------

describe('RepairResult contract', () => {
  test('original is always preserved unchanged', async () => {
    const args = { duration: '5000' };
    const result = await repairToolCall('wait', args, NUMBER_SCHEMA);
    expect(result.original).toEqual({ duration: '5000' });
    expect(result.fixed['duration']).toBe(5000);
  });

  test('returns repaired=false and fixed===original when nothing to fix', async () => {
    const args = { duration: 5000 };
    const result = await repairToolCall('wait', args, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.repairs).toHaveLength(0);
    expect(result.fixed).toEqual(args);
  });

  test('repairs array lists all fixes when multiple repairs apply', async () => {
    // duration: string number + agent mode missing
    const result = await repairToolCall(
      'agent',
      { task: 'Do work', timeoutMs: '30000', outsideContract: 'true' },
      AGENT_SCHEMA,
    );
    expect(result.repaired).toBe(true);
    // mode inferred + timeoutMs coerced + outsideContract coerced
    expect(result.repairs.length).toBeGreaterThanOrEqual(2);
    expect(result.fixed['mode']).toBe('spawn');
    expect(result.fixed['timeoutMs']).toBe(30000);
    expect(result.fixed['outsideContract']).toBe(true);
  });

  test('structuredClone protects nested objects from mutation', async () => {
    const nested = { meta: { retries: 3 } };
    const schema: ToolDefinition = {
      name: 'task',
      description: 'Run a task.',
      parameters: {
        type: 'object',
        required: ['duration'],
        properties: {
          duration: { type: 'number' },
          config: { type: 'object' },
        },
      },
    };
    const result = await repairToolCall('task', { duration: '1000', config: nested }, schema);
    // Mutate the fixed copy, original must not be affected
    (result.fixed['config'] as Record<string, unknown>)['extra'] = true;
    expect((nested as Record<string, unknown>)['extra']).toBeUndefined();
  });

  test('never throws on garbage input', async () => {
    const schema: ToolDefinition = {
      name: 'bad',
      description: 'Bad schema.',
      parameters: { type: 'object' }, // no properties, no required
    };
    expect(await repairToolCall('bad', {}, schema)).toBeDefined();
    // Also with null-ish values in args
    expect(await repairToolCall('bad', { a: null, b: undefined } as Record<string, unknown>, schema)).toBeDefined();
  });
});
