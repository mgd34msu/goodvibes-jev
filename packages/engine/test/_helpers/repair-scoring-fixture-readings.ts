import type { Question } from '@goodvibes-jev/judgment';
import { scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { repairFactScoring } from '../../sdk/src/platform/knowledge/semantic/repair-fact-scoring/battery.js';
import { repairUsefulFixtureReading, type RepairProfileFixtureValues, type RepairUsefulFixtureValues } from './repair-profile-fixture-readings.js';

/** Authored support tuples admit only the existing exact synthetic claims. */
export function repairScoringFixtureReading(name: string, question: Question, state: unknown,
  profiles: RepairProfileFixtureValues = [], claims: RepairUsefulFixtureValues = []) {
  if (name !== 'factTrust' && name !== 'sourceSupport' && name !== 'subjectSupport') return undefined;
  if (question !== repairFactScoring.items[name].question) return undefined;
  if (repairUsefulFixtureReading(state, profiles, claims) !== 0.99) throw new Error('Unscripted exact repair scoring fixture.');
  return scoreAnswer(question, 4, 0.99);
}
