/**
 * summarizeCommandError - format a thrown value into a plain-language message
 * suitable for printing directly to the conversation. Matches the style used
 * by routines, personas, and vibe (short prefix + colon + reason).
 */
export function summarizeCommandError(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Command failed: ${reason}`;
}
