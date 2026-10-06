/** Declared provenance shared by one runtime occurrence and all its notice/replay deliveries. */
export interface RuntimeEventProvenance {
  readonly type: string;
  /** Missing on legacy events. Never derive this from entity ids, text, trace ids or time. */
  readonly occurrenceId?: string | undefined;
}
