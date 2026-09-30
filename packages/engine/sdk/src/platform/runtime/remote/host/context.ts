/** Minimum credential capability used by host remote-execution backends. */
export interface RemoteHostCredentialStore {
  resolveRef(ref: string): Promise<string | null>;
}

/** Logging port; backends must never place resolved credentials in metadata. */
export interface RemoteHostLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}
