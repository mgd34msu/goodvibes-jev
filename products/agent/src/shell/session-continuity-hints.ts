interface ShellSessionSnapshot {
  readonly pendingApproval?: unknown;
}

interface ShellTaskRecord {
  readonly status?: string;
}

interface ShellTaskSnapshot {
  readonly tasks: readonly ShellTaskRecord[];
}

interface ShellRemoteContract {
  readonly runnerId: string;
}

interface ShellRemoteSnapshot {
  readonly contracts: readonly ShellRemoteContract[];
}

export function buildShellSessionContinuityHints(
  sessionSnapshot: ShellSessionSnapshot,
  tasksSnapshot: ShellTaskSnapshot,
  remoteSnapshot: ShellRemoteSnapshot,
) {
  return {
    pendingApprovals: sessionSnapshot.pendingApproval ? 1 : 0,
    activeTasks: tasksSnapshot.tasks.filter((task) => task.status === 'running' || task.status === 'queued').length,
    blockedTasks: tasksSnapshot.tasks.filter((task) => task.status === 'blocked').length,
    remoteContracts: remoteSnapshot.contracts.length,
    remoteRunners: remoteSnapshot.contracts.slice(0, 4).map((contract) => contract.runnerId),
  };
}
