/** Read-only credential capability required by inbound provider adapters. */
export interface IntakeCredentialStore {
  resolveRef(ref: string): Promise<string | null>;
  resolveConfigSecret(configKey: string): Promise<string | null>;
}

/** Inbound logging port; resolved credentials and message content stay private. */
export interface IntakeLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}
