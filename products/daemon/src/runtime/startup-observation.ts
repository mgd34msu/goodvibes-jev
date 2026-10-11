import { writeSync } from 'node:fs';
import type { DeviceHousekeepingOptions } from '@goodvibes-jev/engine/sdk/platform/devices';

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
  | 'device-grant-sweep'
  | 'device-capture-sweep'
  | 'device-disclosure-read'
  | 'device-disclosure-persist'
  | 'listener-startup'
  | 'secondary-listener-startup'
  | 'boot-tasks'
  | 'foreground-ready';

/** Fixed, best-effort observations for the native execution consumer only. */
export function observeNativeStartupPhase(phase: NativeStartupPhase): void {
  if (!OBSERVATION_ENABLED || stopped || observed.has(phase) || observed.size >= 16) return;
  observed.add(phase);
  try { writeSync(2, `[goodvibes-daemon:native-startup-phase] ${phase}\n`); }
  catch { stopped = true; }
}

/** The daemon passes no device observer in ordinary launches. */
export const nativeDeviceRecoveryObserver: DeviceHousekeepingOptions['observeRecovery'] = OBSERVATION_ENABLED
  ? stage => {
    switch (stage) {
      case 'grant-sweep': observeNativeStartupPhase('device-grant-sweep'); return;
      case 'capture-sweep': observeNativeStartupPhase('device-capture-sweep'); return;
      case 'disclosure-read': observeNativeStartupPhase('device-disclosure-read'); return;
      case 'disclosure-persist': observeNativeStartupPhase('device-disclosure-persist'); return;
      default: { const unreachable: never = stage; return unreachable; }
    }
  }
  : undefined;
