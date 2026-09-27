/**
 * The dependency graph for a batch of tasks that run as one elastic
 * workstream (docs/design/contract-runner.md sections 5.2 and 7.5): the
 * contract runner's planned-fix groups use it to serialize fix units that
 * touch the same file.
 *
 * Edges (from DEPENDS ON to):
 * - declared: a task's own `dependsOn`, kept as given;
 * - shared-file: tasks naming the same file serialize, most severe first, then
 *   in the order given, so a critical fix lands before a minor one touches the
 *   same file;
 * - extra: edges a caller adds on top (a planner's prerequisites).
 *
 * An edge that would close a cycle is dropped rather than added (the graph's
 * own cycle test), so declared order always wins over a shared-file edge.
 * Everything here is graph arithmetic over ids and paths.
 */
import { wouldCreateCycle } from './graph-dynamics.js';
import type { WorkItemSpec } from './types.js';

/** Per-phase capacity for elastic graphs: the fleet ceiling is the real limiter. */
export const ELASTIC_PHASE_CAPACITY = 64;

export type TaskSeverity = 'critical' | 'major' | 'minor';

/** One task to place in the graph. */
export interface GraphTask {
  readonly id: string;
  readonly title: string;
  /** The brief the task's agent receives. */
  readonly task: string;
  readonly severity: TaskSeverity;
  /** Files the task will change: they drive shared-file edges and the cluster. */
  readonly files: readonly string[];
  /** Tasks this one must wait for, as planned. */
  readonly dependsOn?: readonly string[] | undefined;
}

/** Edges a caller adds beyond the declared and shared-file ones. */
export type ExtraEdges = (tasks: readonly GraphTask[]) => ReadonlyArray<{ readonly from: string; readonly to: string }>;

const SEVERITY_RANK: Readonly<Record<TaskSeverity, number>> = { critical: 0, major: 1, minor: 2 };

/** File-cluster label: the first two path segments (subsystem granularity), or 'general'. */
export function clusterOf(files: readonly string[]): string {
  const first = files[0];
  if (!first) return 'general';
  const segments = first.split('/').filter(Boolean);
  return segments.slice(0, Math.min(2, Math.max(1, segments.length - 1))).join('/') || segments[0] || 'general';
}

/**
 * Places the tasks in one dependency graph and returns their work item specs
 * (id, title, task, dependsOn, cluster, files) with the number of edges.
 */
export function planTaskGraph(tasks: readonly GraphTask[], extraEdges?: ExtraEdges): { specs: WorkItemSpec[]; edgeCount: number } {
  const ids = new Set(tasks.map((task) => task.id));
  const nodes = tasks.map((task) => ({ id: task.id, title: task.title, dependsOn: [] as string[] }));
  const graph = { items: nodes };
  const addEdge = (from: string, to: string): void => {
    if (from === to || !ids.has(from) || !ids.has(to)) return;
    const node = nodes.find((entry) => entry.id === from)!;
    if (node.dependsOn.includes(to) || wouldCreateCycle(graph, from, to) !== null) return;
    node.dependsOn.push(to);
  };

  for (const task of tasks) for (const dep of task.dependsOn ?? []) addEdge(task.id, dep);

  const byFile = new Map<string, GraphTask[]>();
  for (const task of tasks) {
    for (const file of task.files) byFile.set(file, [...(byFile.get(file) ?? []), task]);
  }
  const order = new Map(tasks.map((task, index) => [task.id, index]));
  for (const sameFile of byFile.values()) {
    if (sameFile.length < 2) continue;
    const ordered = [...sameFile].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || order.get(a.id)! - order.get(b.id)!);
    for (let index = 1; index < ordered.length; index += 1) addEdge(ordered[index]!.id, ordered[index - 1]!.id);
  }

  for (const edge of extraEdges?.(tasks) ?? []) addEdge(edge.from, edge.to);

  const specs: WorkItemSpec[] = tasks.map((task, index) => ({
    id: task.id,
    title: task.title,
    task: task.task,
    dependsOn: [...nodes[index]!.dependsOn],
    cluster: clusterOf(task.files),
    files: task.files,
  }));
  return { specs, edgeCount: nodes.reduce((sum, node) => sum + node.dependsOn.length, 0) };
}
