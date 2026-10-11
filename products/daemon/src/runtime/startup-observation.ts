import { writeSync } from 'node:fs';

const OBSERVATION_ENABLED = process.env['GOODVIBES_NATIVE_STARTUP_OBSERVATION'] === '1';
const observed = new Set<NativeStartupPhase>();
let stopped = false;

export type NativeStartupPhase =
  | 'runtime-base'
  | 'handler-surfaces'
  | 'contract-recovery'
  | 'provider-preload'
  | 'listener-construction'
  | 'secondary-listener-construction'
  | 'cluster-startup'
  | 'device-recovery'
  | 'listener-startup'
  | 'secondary-listener-startup'
  | 'boot-tasks'
  | 'foreground-ready';

/** Fixed, best-effort observations for the native execution consumer only. */
export function observeNativeStartupPhase(phase: NativeStartupPhase): void {
  if (!OBSERVATION_ENABLED || stopped || observed.has(phase) || observed.size >= 12) return;
  observed.add(phase);
  try { writeSync(2, `[goodvibes-daemon:native-startup-phase] ${phase}\n`); }
  catch { stopped = true; }
}
