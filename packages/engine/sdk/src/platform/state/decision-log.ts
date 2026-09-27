import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog } from '@goodvibes-jev/judgment';

/**
 * The state layer's decision log: every Jev reading the engine takes,
 * answered or failed, in one SQLite file at the state root, beside the memory
 * and code-index stores. A composition opens it when it opens its state and
 * closes it when its disposal scope runs; runtime/judgment-services.ts wraps
 * the judgment port so every call is recorded here.
 */
export const DECISION_LOG_FILE = 'decisions.sqlite';

/** Where the decision log lives under a state root (`<workspace>/.goodvibes/<surface root>`). */
export function decisionLogPath(stateRoot: string): string {
  return join(stateRoot, DECISION_LOG_FILE);
}

/** Opens (creating when absent) the state root's decision log. Close it with `[Symbol.dispose]()`. */
export function openStateDecisionLog(stateRoot: string): SqliteDecisionLog {
  mkdirSync(stateRoot, { recursive: true });
  return new SqliteDecisionLog(decisionLogPath(stateRoot));
}
