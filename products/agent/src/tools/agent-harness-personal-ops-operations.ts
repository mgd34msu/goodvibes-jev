import { hasMethod } from './agent-harness-personal-ops-discovery.ts';
import type { PersonalOpsLiveRecord } from './agent-harness-personal-ops-types.ts';

export function taskOperationRecords(methodIds: readonly string[]): readonly PersonalOpsLiveRecord[] {
  const records: PersonalOpsLiveRecord[] = [
    {
      id: 'workplan-list',
      label: 'Review visible work plan',
      status: 'ready',
      summary: 'Read Agent-owned work-plan items before starting or switching multi-step work.',
      userRoute: 'Agent Workspace -> Work & Approvals -> Autonomy queue',
      modelRoute: 'agent_work_plan action:"list"',
      tags: ['work-plan', 'task-read'],
      effect: 'read-only',
      capability: 'task-read',
    },
    {
      id: 'workplan-add',
      label: 'Add visible work item',
      status: 'ready',
      summary: 'Create one local Agent work-plan item instead of hiding task state in chat.',
      userRoute: 'Agent Workspace -> Work & Approvals -> Autonomy queue',
      modelRoute: 'agent_work_plan action:"create" title:"..."',
      tags: ['work-plan', 'task-write'],
      effect: 'confirmed-effect',
      capability: 'task-write',
      requiredFields: ['title'],
      optionalFields: ['detail', 'priority', 'status'],
      confirmationRequired: false,
    },
    {
      id: 'workplan-status',
      label: 'Update work item status',
      status: 'ready',
      summary: 'Move one visible work item through pending, active, blocked, done, failed, or cancelled state.',
      userRoute: 'Agent Workspace -> Work & Approvals -> Autonomy queue',
      modelRoute: 'agent_work_plan action:"set_status" id:"..." status:"..."',
      tags: ['work-plan', 'task-write'],
      effect: 'confirmed-effect',
      capability: 'task-write',
      requiredFields: ['id', 'status'],
      confirmationRequired: false,
    },
  ];
  if (hasMethod(methodIds, 'tasks.list')) {
    records.push({
      id: 'host-tasks-list',
      label: 'List connected-host tasks',
      status: 'ready',
      summary: 'Inspect connected-host task state without creating, retrying, or mutating host tasks.',
      userRoute: 'Agent Workspace -> Work & Approvals -> Filter host tasks',
      modelRoute: 'workspace action:"action" actionId:"tasks-list"',
      tags: ['host-task', 'task-read'],
      effect: 'read-only',
      capability: 'host-task-read',
    });
  }
  if (hasMethod(methodIds, 'tasks.get') || hasMethod(methodIds, 'tasks.status')) {
    records.push({
      id: 'host-task-inspect',
      label: 'Inspect connected-host task',
      status: 'ready',
      summary: 'Inspect one exact connected-host task id and output before considering controls.',
      userRoute: 'Agent Workspace -> Work & Approvals -> Inspect host task',
      modelRoute: 'workspace action:"action" actionId:"task-show"',
      tags: ['host-task', 'task-read'],
      effect: 'read-only',
      capability: 'host-task-read',
      requiredFields: ['taskId'],
    });
  }
  if (hasMethod(methodIds, 'tasks.cancel')) {
    records.push({
      id: 'host-task-cancel',
      label: 'Cancel connected-host task',
      status: 'ready',
      summary: 'Cancel one exact connected-host task id only when the user authorizes it.',
      userRoute: 'Agent Workspace -> Work & Approvals',
      modelRoute: 'agent_operator_method methodId:"tasks.cancel" input:{"taskId":"..."} confirm:true explicitUserRequest:"..."',
      tags: ['host-task', 'task-write'],
      effect: 'confirmed-effect',
      capability: 'host-task-control',
      requiredFields: ['taskId'],
      confirmationRequired: true,
    });
  }
  if (hasMethod(methodIds, 'tasks.retry')) {
    records.push({
      id: 'host-task-retry',
      label: 'Retry connected-host task',
      status: 'ready',
      summary: 'Retry one failed or cancelled connected-host task id only after inspection.',
      userRoute: 'Agent Workspace -> Work & Approvals',
      modelRoute: 'agent_operator_method methodId:"tasks.retry" input:{"taskId":"..."} confirm:true explicitUserRequest:"..."',
      tags: ['host-task', 'task-write'],
      effect: 'confirmed-effect',
      capability: 'host-task-control',
      requiredFields: ['taskId'],
      confirmationRequired: true,
    });
  }
  return records;
}

export function reminderOperationRecords(methodIds: readonly string[], deliveryConfigured: boolean): readonly PersonalOpsLiveRecord[] {
  const records: PersonalOpsLiveRecord[] = [
    {
      id: 'reminder-create',
      label: 'Create confirmed reminder',
      status: hasMethod(methodIds, 'automation.schedules.create') ? deliveryConfigured ? 'ready' : 'attention' : 'needs-setup',
      summary: deliveryConfigured
        ? 'Create one connected reminder schedule with real timing and a visible delivery path.'
        : 'Create one reminder only after confirming timing and delivery scope; no configured delivery target was detected.',
      userRoute: 'Agent Workspace -> Personal Ops -> Create reminder',
      modelRoute: 'schedule action:"remind" message:"..." scheduleKind:"..." scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      tags: ['reminder', 'schedule-write'],
      effect: 'confirmed-effect',
      capability: 'reminder-create',
      requiredFields: ['title', 'scheduleKind', 'scheduleValue'],
      optionalFields: ['deliveryTargetId', 'timezone', 'message'],
      confirmationRequired: true,
    },
    {
      id: 'autonomous-schedule-create',
      label: 'Create autonomous schedule',
      status: hasMethod(methodIds, 'automation.schedules.create') ? 'ready' : 'needs-setup',
      summary: 'Create one visible autonomous schedule only when task, cadence, success criteria, and user request provenance are explicit.',
      userRoute: 'Agent Workspace -> Automation',
      modelRoute: 'schedule action:"create" task:"..." successCriteria:"..." scheduleKind:"..." scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      tags: ['autonomy', 'schedule-write'],
      effect: 'confirmed-effect',
      capability: 'schedule-create',
      requiredFields: ['task', 'successCriteria', 'scheduleKind', 'scheduleValue'],
      confirmationRequired: true,
    },
  ];
  if (hasMethod(methodIds, 'automation.schedules.list')) {
    records.push({
      id: 'schedule-list',
      label: 'List connected schedules',
      status: 'ready',
      summary: 'Inspect configured schedules and history before running or mutating one.',
      userRoute: 'Agent Workspace -> Automation -> Autonomy queue',
      modelRoute: 'workspace action:"action" actionId:"schedule-list"',
      tags: ['schedule', 'schedule-read'],
      effect: 'read-only',
      capability: 'schedule-read',
    });
    records.push({
      id: 'schedule-edit',
      label: 'Edit connected schedule',
      status: 'ready',
      summary: 'Preview and edit one exact connected schedule id with before/after diff context.',
      userRoute: 'Agent Workspace -> Automation -> Edit schedule',
      modelRoute: 'schedule action:"edit" scheduleId:"..." confirm:true explicitUserRequest:"..."',
      tags: ['schedule', 'schedule-write'],
      effect: 'confirmed-effect',
      capability: 'schedule-control',
      requiredFields: ['scheduleId'],
      optionalFields: ['name', 'scheduleKind', 'scheduleValue', 'prompt'],
      confirmationRequired: true,
    });
  }
  if (hasMethod(methodIds, 'automation.schedules.run')) {
    records.push({
      id: 'schedule-run-now',
      label: 'Run schedule now',
      status: 'ready',
      summary: 'Run one exact connected schedule id now after the user confirms.',
      userRoute: 'Agent Workspace -> Automation -> Run job now',
      modelRoute: 'schedule action:"run" scheduleId:"..." confirm:true explicitUserRequest:"..."',
      tags: ['schedule', 'schedule-write'],
      effect: 'confirmed-effect',
      capability: 'schedule-control',
      requiredFields: ['scheduleId'],
      confirmationRequired: true,
    });
  }
  if (hasMethod(methodIds, 'automation.schedules.disable')) {
    records.push({
      id: 'schedule-pause',
      label: 'Pause connected schedule',
      status: 'ready',
      summary: 'Disable one exact connected schedule id after reviewing current state.',
      userRoute: 'Agent Workspace -> Automation -> Pause job',
      modelRoute: 'schedule action:"pause" scheduleId:"..." confirm:true explicitUserRequest:"..."',
      tags: ['schedule', 'schedule-write'],
      effect: 'confirmed-effect',
      capability: 'schedule-control',
      requiredFields: ['scheduleId'],
      confirmationRequired: true,
    });
  }
  if (hasMethod(methodIds, 'automation.schedules.enable')) {
    records.push({
      id: 'schedule-resume',
      label: 'Resume connected schedule',
      status: 'ready',
      summary: 'Enable one exact connected schedule id after reviewing current state.',
      userRoute: 'Agent Workspace -> Automation -> Resume job',
      modelRoute: 'schedule action:"resume" scheduleId:"..." confirm:true explicitUserRequest:"..."',
      tags: ['schedule', 'schedule-write'],
      effect: 'confirmed-effect',
      capability: 'schedule-control',
      requiredFields: ['scheduleId'],
      confirmationRequired: true,
    });
  }
  if (hasMethod(methodIds, 'automation.schedules.delete')) {
    records.push({
      id: 'schedule-delete',
      label: 'Delete connected schedule',
      status: 'ready',
      summary: 'Delete one exact connected schedule id only after explicit user confirmation.',
      userRoute: 'Agent Workspace -> Automation',
      modelRoute: 'schedule action:"delete" scheduleId:"..." confirm:true explicitUserRequest:"..."',
      tags: ['schedule', 'schedule-write'],
      effect: 'confirmed-effect',
      capability: 'schedule-control',
      requiredFields: ['scheduleId'],
      confirmationRequired: true,
    });
  }
  return records;
}
