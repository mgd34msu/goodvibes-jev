import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Exact authored readings for the Isolation Home synthetic snapshot only.
 * Generic prose/empty excerpts receive negative relevance, never invented evidence.
 * Unrelated provider-route probes and every unknown knowledge input are rejected.
 */
interface FixtureInput {
  sample?: unknown;
  query?: unknown;
  subject?: { kind?: string; title?: string; homeAssistant?: { objectId?: string } };
  candidate?: {
    kind?: string; nodeKind?: string; title?: string; text?: string;
    sourceType?: string; excerpts?: unknown[]; facts?: unknown[];
  };
  candidates?: Array<{ kind?: string; title?: string }>;
}

export function knowledgeIsolationAnswer(name: string, state: unknown) {
  const input = state as FixtureInput;
  if (name === 'readable' && input.sample === 'Home Assistant entity, device, area, automation, script, scene, label, and integration snapshot.') return noulAnswer(0.99);
  const deviceReadings: Readonly<Record<string, number>> = {
    batteryApplicable: 0.01, manualApplicable: 0.01, manufacturerPresent: 0.01, modelPresent: 0.01, batteryTypePresent: 0.01,
  };
  if (Object.hasOwn(deviceReadings, name) && input.subject?.kind === 'ha_device' && input.subject.title === 'Isolation Light' && input.subject.homeAssistant?.objectId === 'device-light') return noulAnswer(deviceReadings[name]!);
  const relevance: Readonly<Record<string, number>> = {
    'source::Isolation Home': 0.95,
    'node:ha_entity:Isolation Light': 0.99,
    'node:ha_device:Isolation Light': 0.98,
    'node:ha_integration:Light Integration': 0.01,
    'node:ha_area:Lab': 0.99,
    'node:ha_home:Isolation Home': 0.9,
  };
  const candidateKey = `${input.candidate?.kind ?? ''}:${input.candidate?.nodeKind ?? ''}:${input.candidate?.title ?? ''}`;
  if (name === 'useful' && input.query === 'where is the isolation light?' && Object.hasOwn(relevance, candidateKey)) return noulAnswer(relevance[candidateKey]!);
  // Complete HomeGraph discovery also reads this exact unindexed suggestion.
  // It supplies no location evidence for the Isolation Light question.
  if (name === 'useful' && input.query === 'where is the isolation light?'
    && input.candidate?.kind === 'source' && input.candidate.sourceType === 'url'
    && input.candidate.title === 'integration-light Home Assistant documentation'
    && input.candidate.text === [
      'integration-light Home Assistant documentation',
      'Suggested documentation source for the integration-light Home Assistant integration.',
      'https://www.home-assistant.io/integrations/integration-light/',
      'homeassistant home-graph documentation suggested-source integration-light home-assistant-docs',
    ].join('\n\n')
    && input.candidate.facts?.length === 0) return noulAnswer(0.01);
  if (name === 'excerptUseful' && input.query === 'where is the isolation light?' && input.candidate?.text === 'Home Assistant entity, device, area, automation, script, scene, label, and integration snapshot.') return noulAnswer(0.01);
  const objects: Readonly<Record<string, Readonly<Record<string, number>>>> = {
    'ha_entity:Isolation Light': { concreteObject: 0.99, integrationObject: 0.01, aligned: 0.99 },
    'ha_device:Isolation Light': { concreteObject: 0.99, integrationObject: 0.01, aligned: 0.99 },
    'ha_integration:Light Integration': { concreteObject: 0.01, integrationObject: 0.99, aligned: 0.01 },
  };
  if (input.query === 'where is the isolation light?') {
    if (name === 'integrationIntent' && input.candidates?.length === 3 && new Set(input.candidates.map(candidate => `${candidate.kind}:${candidate.title}`)).size === 3 && input.candidates.every(candidate => Object.hasOwn(objects, `${candidate.kind}:${candidate.title}`))) return noulAnswer(0.01);
    const alignment = objects[`${input.candidate?.kind}:${input.candidate?.title}`]?.[name];
    if (alignment !== undefined) return noulAnswer(alignment);
  }
  if (name === 'match' && input.query === 'where is the isolation light?' && input.candidate?.title === 'Isolation Home' && input.candidate.sourceType === 'dataset' && input.candidate.excerpts?.length === 0 && input.candidate.facts?.length === 0) return noulAnswer(0.01);
  throw new Error(`Unexpected knowledge fixture question: ${name}`);
}

export function knowledgeIsolationReadings() {
  const rejected: string[] = [];
  const fake = fakePort((name, _question, state) => {
    try { return knowledgeIsolationAnswer(name, state); }
    catch (error) { rejected.push(name); throw error; }
  });
  return { ...fake, rejected };
}
