export type { UiReadModel } from '@/runtime/index.ts';
export type {
  UiCoreReadModels,
  UiProvidersSnapshot,
  UiSessionSnapshot,
  UiAgentsSnapshot,
  UiTasksSnapshot,
} from '@/runtime/index.ts';
export type {
  UiOperationsReadModels,
  UiAutomationSnapshot,
  UiRoutesSnapshot,
  UiWatchersSnapshot,
  UiOrchestrationSnapshot,
  UiCommunicationSnapshot,
  UiControlPlaneSnapshot,
} from '@/runtime/index.ts';
export type {
  UiObservabilityReadModels,
  UiRemoteSnapshot,
  UiIntelligenceSnapshot,
  UiMarketplaceSnapshot,
  UiCockpitSnapshot,
  UiSecuritySnapshot,
  UiHealthSnapshot,
  UiMcpServerSnapshot,
  UiMcpSnapshot,
  UiLocalAuthSnapshot,
  UiSettingsSnapshot,
  UiContinuitySnapshot,
  UiWorktreeSnapshot,
} from '@/runtime/index.ts';
export type { UiObservabilityReadModelOptions } from '@/runtime/index.ts';

import type { RuntimeServices } from './services.ts';
import { createCoreReadModels, type UiCoreReadModels } from '@/runtime/index.ts';
import {
  createOperationsReadModels,
  type UiOperationsReadModels,
  type UiOperationsReadModelOptions,
} from '@/runtime/index.ts';
import {
  createObservabilityReadModels,
  type UiObservabilityReadModels,
  type UiObservabilityReadModelOptions,
} from '@/runtime/index.ts';

export type UiReadModelOptions = UiOperationsReadModelOptions & UiObservabilityReadModelOptions;

export type UiReadModels = UiCoreReadModels & UiOperationsReadModels & UiObservabilityReadModels;

export function createUiReadModels(
  runtimeServices: RuntimeServices,
  options: UiReadModelOptions = {},
): UiReadModels {
  // Read models READ. Every one of them wants the session register (session
  // rows, approval counts, observability snapshots), never the dispatch seam,
  // so they are handed the daemon-grade view rather than each being taught the
  // substitution.
  const daemonGradeView = runtimeServices.asDaemonGradeView();
  return {
    ...createCoreReadModels(daemonGradeView),
    ...createOperationsReadModels(daemonGradeView, options),
    ...createObservabilityReadModels(daemonGradeView, options),
  };
}
