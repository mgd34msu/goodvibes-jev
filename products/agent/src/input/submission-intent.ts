export type SubmissionIntentKind =
  | 'empty'
  | 'prompt'
  | 'slash-command'
  | 'orchestration'
  | 'delegation'
  | 'plan'
  | 'shell'
  | 'memory-pin';

export interface SubmissionIntent {
  readonly kind: SubmissionIntentKind;
  readonly label: string;
  readonly commandName?: string;
  readonly hasAttachments: boolean;
}
