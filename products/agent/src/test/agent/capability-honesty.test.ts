/**
 * Capability readiness registry pins: every entry declares an allowed level,
 * advertised nouns resolve to their registry entry, certified entries map to a
 * passing live-verification scenario, and onboarding copy renders readiness
 * from the registry.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_REGISTRY,
  CAPABILITY_READINESS_LEVELS,
  capabilityReadinessUserLabel,
  getCapabilityByAdvertisedName,
  renderCapabilityReadinessLine,
} from '../../agent/capability-registry.ts';
import { LIVE_VERIFICATION_SCENARIO_IDS } from '../../verification/live-verifier.ts';
import { AGENT_WORKSPACE_ONBOARDING_DETAIL_CATEGORIES } from '../../input/agent-workspace-onboarding-categories.ts';

const SRC_ROOT = join(import.meta.dir, '..', '..');
const REPO_ROOT = join(SRC_ROOT, '..');

/**
 * Capability nouns as they appear in advertised onboarding copy, each mapped
 * to the registry id that must own it. Every noun must resolve to a declared
 * readiness level.
 */
const ADVERTISED_CAPABILITY_NOUNS: ReadonlyArray<readonly [noun: string, capabilityId: string]> = [
  ['voice', 'voice'],
  ['text-to-speech', 'text-to-speech'],
  ['TTS', 'text-to-speech'],
  ['image input', 'image-input'],
  ['media generation', 'media-generation'],
  ['telephony', 'telephony'],
  ['Messaging', 'messaging-channels'],
  ['Memory', 'local-context-memory'],
  ['Knowledge', 'agent-knowledge'],
  ['email', 'email'],
  ['calendar', 'calendar'],
  ['Research', 'deep-research'],
  ['Documents', 'documents'],
  ['Schedules', 'schedules-automation'],
  ['local model', 'local-model-cookbook'],
  ['model comparison', 'blind-model-comparison'],
];

describe('capability readiness registry', () => {
  test('every registry entry declares one of the four allowed levels and a unique id', () => {
    const ids = new Set<string>();
    for (const capability of CAPABILITY_REGISTRY) {
      expect(CAPABILITY_READINESS_LEVELS).toContain(capability.level);
      expect(capability.title.length).toBeGreaterThan(0);
      expect(capability.surfaces.length).toBeGreaterThan(0);
      expect(capability.advertisedNames.length).toBeGreaterThan(0);
      expect(capability.readinessNote.length).toBeGreaterThan(0);
      expect(ids.has(capability.id)).toBe(false);
      ids.add(capability.id);
    }
    // The level set is closed: nothing else, no "planning-only" level exists.
    expect([...CAPABILITY_READINESS_LEVELS].sort()).toEqual(
      ['certified', 'needs-setup', 'preview', 'working'],
    );
  });

  // Every capability noun the advertised surfaces use resolves to its
  // registry entry with a declared level.
  test('every advertised capability noun resolves to a registry entry', () => {
    const missingFromRegistry: string[] = [];
    for (const [noun, capabilityId] of ADVERTISED_CAPABILITY_NOUNS) {
      const capability = getCapabilityByAdvertisedName(noun);
      if (!capability || capability.id !== capabilityId) {
        missingFromRegistry.push(`${noun} -> ${capability?.id ?? 'none'} (expected ${capabilityId})`);
      }
    }
    expect(missingFromRegistry).toEqual([]);
  });

  // (b): every `certified` entry maps to a real live-verification scenario id
  // that passed in the current committed report; no other level carries a
  // scenario id.
  test('certified capabilities map to a live-verification scenario that passed', () => {
    const reportPath = join(REPO_ROOT, 'release', 'live-verification', 'live-verification.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      checks: ReadonlyArray<{ id: string; status: string }>;
    };
    const passedScenarioIds = new Set(
      report.checks.filter((check) => check.status === 'pass').map((check) => check.id),
    );

    for (const capability of CAPABILITY_REGISTRY) {
      if (capability.level === 'certified') {
        expect(capability.scenarioId).toBeDefined();
        expect(LIVE_VERIFICATION_SCENARIO_IDS).toContain(capability.scenarioId!);
        expect(passedScenarioIds.has(capability.scenarioId!)).toBe(true);
      } else {
        // Only certified entries may claim a live scenario.
        expect(capability.scenarioId).toBeUndefined();
      }
    }
  });

  // The onboarding copy renders the level FROM the registry rather than
  // hand-writing a duplicate claim.
  test('onboarding copy renders each capability readiness level from the registry', () => {
    const voiceMedia = AGENT_WORKSPACE_ONBOARDING_DETAIL_CATEGORIES.find(
      (category) => category.id === 'onboarding-voice-media',
    );
    expect(voiceMedia).toBeDefined();

    const readinessLine = renderCapabilityReadinessLine('onboarding-voice-media');
    expect(readinessLine).toContain('Readiness:');
    // The rendered line, not a hand-written string, is what the surface shows.
    expect(voiceMedia!.detail).toContain(readinessLine);

    // Voice is needs-setup and must render with that plain label.
    expect(readinessLine).toContain(`Voice controls (${capabilityReadinessUserLabel('needs-setup')})`);

    // Certified Agent Knowledge renders its verified-live label on its surface.
    const contextLine = renderCapabilityReadinessLine('onboarding-context');
    expect(contextLine).toContain(`Agent Knowledge (${capabilityReadinessUserLabel('certified')})`);
  });
});
