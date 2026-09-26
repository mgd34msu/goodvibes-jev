import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, type EntryType, type JudgmentPort } from '../port/types.ts';
import { LIMITS } from '../port/limits.ts';
import type { Outcome } from '../readings/bands.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../patterns/common.ts';

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

export function defineHierarchyWalker(spec: HierarchySpec): HierarchyWalker {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  if (!(Number.isInteger(spec.beamWidth) && spec.beamWidth >= 1)) throw new RangeError(`hierarchy ${spec.name}: beamWidth must be a positive integer`);
  if (!(spec.confirmAt <= spec.actAt)) throw new RangeError(`hierarchy ${spec.name}: confirmAt must not exceed actAt`);
  assertTree(spec.name, spec.tree);
  if (Object.keys(spec.tree).length === 0) throw new RangeError(`hierarchy ${spec.name}: the tree is empty`);
  const leaves = new Set(leafPaths(spec.tree).map((path) => path.join(' > ')));
  for (const fixture of spec.fixtures) {
    if (!leaves.has(fixture.expect)) throw new RangeError(`hierarchy ${spec.name}: fixture ${fixture.name} expects a path that is not a leaf`);
  }

  async function choose(port: JudgmentPort, state: EntryType, path: readonly string[], options: CallOptions) {
    const labels = Object.keys(subtree(spec.tree, path));
    if (labels.length === 1) return { [labels[0]!]: 1 } as Record<string, number>;
    const question = choice(
      path.length === 0 ? (spec.instructions ?? DEFAULT_INSTRUCTIONS) : { question: spec.instructions ?? DEFAULT_INSTRUCTIONS, under: path.join(' > ') },
      Object.fromEntries(labels.map((label) => [label, null])),
    );
    const result = await askAs(port, spec, 'hierarchy', state, { child: question }, options);
    const probabilities = result.answers.child.probabilities as Readonly<Record<string, number>>;
    recordReadings(port, result, { path, child: result.answers.child.choice, confidence: result.answers.child.confidence });
    return probabilities;
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
      for (;;) {
        const open = beam.filter((candidate) => Object.keys(subtree(spec.tree, candidate.path)).length > 0);
        if (open.length === 0) break;
        const done = beam.filter((candidate) => Object.keys(subtree(spec.tree, candidate.path)).length === 0);
        const expanded = await Promise.all(
          open.map(async (candidate) => {
            const probabilities = await choose(port, state, candidate.path, options);
            const labels = Object.keys(probabilities);
            const deciding = labels.length > 1;
            return labels.map((label) => ({
              path: [...candidate.path, label],
              logSum: candidate.logSum + (deciding ? Math.log(Math.max(probabilities[label]!, EPSILON)) : 0),
              decisions: candidate.decisions + (deciding ? 1 : 0),
            }));
          }),
        );
        beam = [...done, ...expanded.flat()].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, spec.beamWidth);
      }
      const ranked = beam.map((candidate) => ({ path: candidate.path, score: scoreOf(candidate) }));
      const best = ranked[0]!;
      const runnerUp = ranked[1];
      const separation = runnerUp === undefined ? Number.POSITIVE_INFINITY : best.score / Math.max(runnerUp.score, EPSILON);
      const outcome: Outcome = best.score >= spec.actAt ? 'act' : best.score >= spec.confirmAt ? 'confirm' : 'escalate';
      return { best, beam: ranked, separation, outcome };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const walk = await walker.walk(port, fixture.state, { site: 'calibration', ...options });
        const got = walk.best.path.join(' > ');
        checks.push({
          fixture: fixture.name,
          aspect: 'leaf',
          expected: fixture.expect,
          got,
          correct: got === fixture.expect,
          signal: walk.best.score,
          outcome: walk.outcome,
        });
      }
      return checks;
    },
  };
  return walker;
}
