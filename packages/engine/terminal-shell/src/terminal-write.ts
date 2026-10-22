import { terminalOutputState } from './terminal-output-state.js';

/** Permit one compositor write through the installed guard without loading its logging graph. */
export function allowTerminalWrite<T>(fn: () => T): T {
  return terminalOutputState.current ? terminalOutputState.current.allowTerminalWrite(fn) : fn();
}
