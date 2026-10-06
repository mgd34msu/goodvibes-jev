import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ScheduleManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { getTestScheduleManager, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

let scheduleManager: ScheduleManager;

beforeEach(() => {
  resetTestRuntimeServices();
  scheduleManager = getTestScheduleManager();
});

afterEach(() => {
  // Resetting the runtime graph drops its reference without stopping its timers.
  scheduleManager.destroy();
});

// ---------------------------------------------------------------------------
// ScheduleManager
// ---------------------------------------------------------------------------

describe('ScheduleManager', () => {
  test('add returns entry with correct fields', () => {
    const sm = getTestScheduleManager();
    const entry = sm.add('health-check', '5m', 'echo ok');
    expect(entry.name).toBe('health-check');
    expect(entry.interval).toBe('5m');
    expect(entry.command).toBe('echo ok');
    expect(entry.enabled).toBe(true);
  });

  test('add sets nextRun for parseable interval', () => {
    const sm = getTestScheduleManager();
    const before = Date.now();
    const entry = sm.add('task', '1m', 'echo hi');
    const after = Date.now();
    expect(entry.nextRun!).toBeGreaterThanOrEqual(before + 60_000);
    expect(entry.nextRun!).toBeLessThanOrEqual(after + 60_000);
  });

  test('add with unparseable interval sets nextRun undefined', () => {
    const sm = getTestScheduleManager();
    const entry = sm.add('task2', 'badinterval', 'echo x');
    expect(entry.nextRun).toBeUndefined();
  });

  test('list returns added entries', () => {
    const sm = getTestScheduleManager();
    sm.add('a', '10s', 'cmd-a');
    sm.add('b', '2m', 'cmd-b');
    const list = sm.list();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.name).sort()).toEqual(['a', 'b']);
  });

  test('remove deletes entry and stops timer', () => {
    const sm = getTestScheduleManager();
    sm.add('temp', '30s', 'echo temp');
    expect(sm.list()).toHaveLength(1);
    const removed = sm.remove('temp');
    expect(removed).toBe(true);
    expect(sm.list()).toHaveLength(0);
  });

  test('remove returns false for unknown name', () => {
    const sm = getTestScheduleManager();
    expect(sm.remove('nonexistent')).toBe(false);
  });

  test('disable sets enabled=false and clears nextRun', () => {
    const sm = getTestScheduleManager();
    sm.add('sched', '1m', 'echo sched');
    const disabled = sm.disable('sched');
    expect(disabled).toBe(true);
    const entry = sm.list()[0];
    expect(entry.enabled).toBe(false);
    expect(entry.nextRun).toBeUndefined();
  });

  test('disable returns false for unknown name', () => {
    const sm = getTestScheduleManager();
    expect(sm.disable('unknown')).toBe(false);
  });

  test('enable re-enables a disabled schedule', () => {
    const sm = getTestScheduleManager();
    sm.add('sched2', '1m', 'echo sched2');
    sm.disable('sched2');
    const enabled = sm.enable('sched2');
    expect(enabled).toBe(true);
    const entry = sm.list()[0];
    expect(entry.enabled).toBe(true);
  });

  test('enable returns false for unknown name', () => {
    const sm = getTestScheduleManager();
    expect(sm.enable('unknown')).toBe(false);
  });

  test('re-adding same name replaces existing entry', () => {
    const sm = getTestScheduleManager();
    sm.add('dup', '5m', 'cmd-v1');
    const entry = sm.add('dup', '1h', 'cmd-v2');
    expect(entry.command).toBe('cmd-v2');
    expect(entry.interval).toBe('1h');
    expect(sm.list()).toHaveLength(1);
  });

  test('test helper reuses one schedule manager inside the same runtime graph', () => {
    const sm1 = getTestScheduleManager();
    const sm2 = getTestScheduleManager();
    sm1.add('shared', '10s', 'echo shared');
    expect(sm2.list()).toHaveLength(1);
  });
});
