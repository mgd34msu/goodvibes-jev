import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import {
  writeOnboardingCheckMarker,
  writeOnboardingCompletionMarker,
} from '../../runtime/onboarding/index.ts';
import { wireSetupIncompleteHint } from '../../shell/startup-wiring.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createShellPaths() {
  const root = makeProjectTempDir(`gv-startup-wiring-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createShellPathService({
    workingDirectory: join(root, 'workspace'),
    homeDirectory: join(root, 'home'),
  });
}

interface CapturedMessages {
  low: string[];
}

function makeRouter(): { router: { low(msg: string): void }; captured: CapturedMessages } {
  const captured: CapturedMessages = { low: [] };
  return {
    router: { low: (msg: string) => { captured.low.push(msg); } },
    captured,
  };
}

// ---------------------------------------------------------------------------
// Phase gating
// ---------------------------------------------------------------------------

describe('wireSetupIncompleteHint: phase gating', () => {
  test('fresh phase, no markers, does not push any message', () => {
    const shellPaths = createShellPaths();
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: true, systemMessageRouter: router });
    expect(captured.low).toHaveLength(0);
  });

  test('complete phase, completion marker present, does not push any message', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCompletionMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: true, systemMessageRouter: router });
    expect(captured.low).toHaveLength(0);
  });

  test('in-progress phase, with a check marker present but no completion marker, pushes at least one message', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: true, systemMessageRouter: router });
    expect(captured.low.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// in-progress content
// ---------------------------------------------------------------------------

describe('wireSetupIncompleteHint: in-progress message content', () => {
  test('message includes /agent', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: true, systemMessageRouter: router });
    const allText = captured.low.join(' ');
    expect(allText).toContain('/agent');
  });

  test('message is prefixed with [Setup]', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: true, systemMessageRouter: router });
    expect(captured.low[0]).toMatch(/^\[Setup\]/);
  });

  test('providerReady false: message leads with model prompt', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: false, systemMessageRouter: router });
    const allText = captured.low.join(' ').toLowerCase();
    expect(allText).toMatch(/model|pick/);
  });

  test('providerReady true: message says chat still works', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: true, systemMessageRouter: router });
    const allText = captured.low.join(' ').toLowerCase();
    // Should indicate chat is possible
    expect(allText).toMatch(/chat|now/);
  });

  test('hostReady omitted: only one low message (no host line)', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: true, systemMessageRouter: router });
    expect(captured.low).toHaveLength(1);
  });

  test('no jargon in any pushed message', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: true, systemMessageRouter: router });
    const allText = captured.low.join(' ');
    expect(allText).not.toMatch(/\bdaemon\b/i);
    expect(allText).not.toMatch(/\bWRFC\b/);
    expect(allText).not.toMatch(/\bmodelRoute\b/);
    expect(allText).not.toMatch(/action:"/);
  });
});

// ---------------------------------------------------------------------------
// MINOR-1: localReady signal, local model route detected, no cloud provider
// ---------------------------------------------------------------------------

describe('wireSetupIncompleteHint: localReady signal', () => {
  test('providerReady:false + localReady:true: does NOT lead with pick-a-model', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: false, localReady: true, systemMessageRouter: router });
    // When the local route is ready, readyToChat is true, so we must NOT say 'pick a model'
    expect(captured.low.length).toBeGreaterThanOrEqual(1);
    const allText = captured.low.join(' ').toLowerCase();
    expect(allText).not.toMatch(/pick a model/);
  });

  test('providerReady:false + localReady:true: says chat works', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: false, localReady: true, systemMessageRouter: router });
    const allText = captured.low.join(' ').toLowerCase();
    // Local model is ready so chat is possible, hint must convey this
    expect(allText).toMatch(/chat|now/);
  });

  test('providerReady:false + localReady:false: still leads with pick-a-model', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: false, localReady: false, systemMessageRouter: router });
    const allText = captured.low.join(' ').toLowerCase();
    // Neither provider nor local is ready, must still prompt to pick a model
    expect(allText).toMatch(/model|pick/);
  });

  test('providerReady:false + localReady omitted: leads with pick-a-model (backward compat)', () => {
    const shellPaths = createShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
    const { router, captured } = makeRouter();
    wireSetupIncompleteHint({ shellPaths, providerReady: false, systemMessageRouter: router });
    const allText = captured.low.join(' ').toLowerCase();
    expect(allText).toMatch(/model|pick/);
  });
});

// ---------------------------------------------------------------------------
// Error resilience: bad shellPaths should not throw
// ---------------------------------------------------------------------------

describe('wireSetupIncompleteHint: error resilience', () => {
  test('does not throw when shellPaths resolveUserPath throws', () => {
    const badShellPaths = {
      resolveUserPath: () => { throw new Error('path service unavailable'); },
      resolveProjectPath: () => { throw new Error('path service unavailable'); },
      workingDirectory: '/tmp/fake',
    } as unknown as Parameters<typeof wireSetupIncompleteHint>[0]['shellPaths'];

    const { router } = makeRouter();
    expect(() =>
      wireSetupIncompleteHint({ shellPaths: badShellPaths, providerReady: true, systemMessageRouter: router })
    ).not.toThrow();
  });
});
