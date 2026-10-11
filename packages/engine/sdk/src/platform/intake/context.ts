/** Local owner incarnation only; raw values stay inside provider ownership. */
export type IntakeCredentialSnapshot =
  | { readonly state: 'resolved'; readonly value: string; readonly revision: string }
  | { readonly state: 'absent'; readonly revision: string }
  | { readonly state: 'unsupported' };
/** Read-only credential capability required by inbound provider adapters. */
export interface IntakeCredentialStore {
  /** Optional legacy port; production account owners may require this exact local observation. */
  resolveConfigCredentialSnapshot?(configKey: string): IntakeCredentialSnapshot;
  resolveRef(ref: string): Promise<string | null>;
  resolveConfigSecret(configKey: string): Promise<string | null>;
}

/** Inbound logging port; resolved credentials and message content stay private. */
export interface IntakeLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}
