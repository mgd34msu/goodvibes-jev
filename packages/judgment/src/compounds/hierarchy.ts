import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, type EntryType, type JudgmentPort } from '../port/types.ts';
import { LIMITS } from '../port/limits.ts';
import type { Outcome } from '../readings/bands.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/** A taxonomy: each label maps to its children; a leaf maps to an empty object. */
export interface Tree {
  readonly [label: string]: Tree;
}

/**
 * Hierarchical walk with a beam (the hierarchical classification cookbook):
 * one Choice per node over its direct children, the best `beamWidth` paths
 * kept by geometric-mean edge probability, every path in the beam expanded
 * in parallel. Deeper evidence can repair an early ambiguous step that a
 * greedy walk would have committed to.
 */
export interface HierarchySpec extends PatternHeader {
  readonly tree: Tree;
  /** The per-node question; defaults to asking for the best direct child. */
  readonly instructions?: EntryType;
  readonly beamWidth: number;
  /** Path score below which the leaf is escalated. */
  readonly actAt: number;
  readonly confirmAt: number;
  readonly fixtures: readonly { readonly name: string; readonly state: EntryType; readonly expect: string }[];
}

export interface WalkPath {
  readonly path: readonly string[];
  /** Geometric mean of the edge probabilities on the path. */
  readonly score: number;
}

export interface Walk {
  readonly best: WalkPath;
  readonly beam: readonly WalkPath[];
  /** Best score over the runner-up's: near 1 is ambiguous, large is clear. */
  readonly separation: number;
  readonly outcome: Outcome;
}

export interface HierarchyWalker extends NamedDecision {
  walk(port: JudgmentPort, state: EntryType, options?: CallOptions): Promise<Walk>;
}

const EPSILON = 1e-9;
const DEFAULT_INSTRUCTIONS = 'Which direct child category best matches this document?';

function subtree(tree: Tree, path: readonly string[]): Tree {
  let node = tree;
  for (const label of path) node = node[label]!;
  return node;
}

function leafPaths(tree: Tree, prefix: readonly string[] = []): string[][] {
  const labels = Object.keys(tree);
  if (labels.length === 0) return [[...prefix]];
  return labels.flatMap((label) => leafPaths(tree[label]!, [...prefix, label]));
}

function assertTree(name: string, tree: Tree, path: readonly string[] = []): void {
  const labels = Object.keys(tree);
  if (labels.length > LIMITS.maxChoiceOptions) {
    throw new RangeError(`hierarchy ${name}: node ${path.join(' > ') || '(root)'} has ${labels.length} children; one Choice takes ${LIMITS.maxChoiceOptions}`);
  }
  for (const label of labels) assertTree(name, tree[label]!, [...path, label]);
}

interface Candidate {
  readonly path: readonly string[];
  readonly logSum: number;
  readonly decisions: number;
}

const scoreOf = (candidate: Candidate): number =>
  candidate.decisions === 0 ? 1 : Math.exp(candidate.logSum / candidate.decisions);

const isLeaf = (tree: Tree, path: readonly string[]): boolean => Object.keys(subtree(tree, path)).length === 0;

/** A path extended by one child; a node with one child decides nothing and does not count. */
function extend(candidate: Candidate, label: string, probabilities: Readonly<Record<string, number>>): Candidate {
  const deciding = Object.keys(probabilities).length > 1;
  const logP = deciding ? Math.log(Math.max(probabilities[label]!, EPSILON)) : 0;
  return { path: [...candidate.path, label], logSum: candidate.logSum + logP, decisions: candidate.decisions + (deciding ? 1 : 0) };
}

function outcomeOf(score: number, spec: HierarchySpec): Outcome {
  if (score >= spec.actAt) return 'act';
  return score >= spec.confirmAt ? 'confirm' : 'escalate';
}

function assertHierarchySpec(spec: HierarchySpec): void {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  const positiveBeam = Number.isInteger(spec.beamWidth) && spec.beamWidth >= 1;
  if (!positiveBeam) throw new RangeError(`hierarchy ${spec.name}: beamWidth must be a positive integer`);
  if (!(spec.confirmAt <= spec.actAt)) throw new RangeError(`hierarchy ${spec.name}: confirmAt must not exceed actAt`);
  assertTree(spec.name, spec.tree);
  if (Object.keys(spec.tree).length === 0) throw new RangeError(`hierarchy ${spec.name}: the tree is empty`);
  const leaves = new Set(leafPaths(spec.tree).map((path) => path.join(' > ')));
  const offLeaf = spec.fixtures.find((fixture) => !leaves.has(fixture.expect));
  if (offLeaf !== undefined) throw new RangeError(`hierarchy ${spec.name}: fixture ${offLeaf.name} expects a path that is not a leaf`);
}

function leafCheck(fixture: HierarchySpec['fixtures'][number], walk: Walk): FixtureCheck {
  const got = walk.best.path.join(' > ');
  return { fixture: fixture.name, aspect: 'leaf', expected: fixture.expect, got, correct: got === fixture.expect, signal: walk.best.score, outcome: walk.outcome };
}

export function defineHierarchyWalker(spec: HierarchySpec): HierarchyWalker {
  assertHierarchySpec(spec);
  const instructions = spec.instructions ?? DEFAULT_INSTRUCTIONS;

  async function childProbabilities(port: JudgmentPort, state: EntryType, path: readonly string[], options: CallOptions) {
    const labels = Object.keys(subtree(spec.tree, path));
    if (labels.length === 1) return { [labels[0]!]: 1 } as Record<string, number>;
    const asked = path.length === 0 ? instructions : { question: instructions, under: path.join(' > ') };
    const question = choice(asked, Object.fromEntries(labels.map((label) => [label, null])));
    const result = await askAs(port, spec, 'hierarchy', state, { child: question }, options);
    const { choice: picked, confidence, probabilities } = result.answers.child;
    recordReadings(port, result, { path, child: picked, confidence });
    return probabilities as Readonly<Record<string, number>>;
  }

  async function expand(port: JudgmentPort, state: EntryType, candidate: Candidate, options: CallOptions): Promise<Candidate[]> {
    const probabilities = await childProbabilities(port, state, candidate.path, options);
    return Object.keys(probabilities).map((label) => extend(candidate, label, probabilities));
  }

  const walker: HierarchyWalker = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async walk(port, state, options = {}) {
      let beam: Candidate[] = [{ path: [], logSum: 0, decisions: 0 }];
      for (let open = beam; open.length > 0; open = beam.filter((c) => !isLeaf(spec.tree, c.path))) {
        const done = beam.filter((c) => isLeaf(spec.tree, c.path));
        const expanded = await Promise.all(open.map((candidate) => expand(port, state, candidate, options)));
        beam = [...done, ...expanded.flat()].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, spec.beamWidth);
      }
      const ranked = beam.map((candidate) => ({ path: candidate.path, score: scoreOf(candidate) }));
      const [best, runnerUp] = ranked as [WalkPath, WalkPath | undefined];
      const separation = runnerUp === undefined ? Number.POSITIVE_INFINITY : best.score / Math.max(runnerUp.score, EPSILON);
      return { best, beam: ranked, separation, outcome: outcomeOf(best.score, spec) };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) checks.push(leafCheck(fixture, await walker.walk(port, fixture.state, { ...options, site: 'calibration' })));
      return checks;
    },
  };
  return walker;
}
