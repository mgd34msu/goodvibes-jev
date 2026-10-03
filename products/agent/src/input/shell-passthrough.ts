/**
 * ShellPassthrough, runs user-typed `!<command>` shell escapes.
 *
 * The composer routes a leading `!` to "shell" mode; this runs the command
 * directly (a user-initiated terminal escape, not an agent tool call), shows
 * its output, and buffers a context block that is prepended to the user's next
 * real message, making the result visible to the model on the next turn
 * without triggering a turn of its own.
 *
 * A buffer is used rather than appending a conversation message because the
 * SDK drops `system` messages from the LLM view and does not merge consecutive
 * `user` messages (which would trip a consecutive-user-message API error).
 */

const MAX_SHELL_OUTPUT = 16_000;

export const SHELL_USAGE_HINT =
  '[Shell] Usage: !<command>, runs a shell command; its output is shown and added as context for your next message.';

export interface ShellRunResult {
  /** Formatted output for the conversation/activity feed. */
  readonly display: string;
  /** Context block buffered for the user's next turn. */
  readonly context: string;
}

export class ShellPassthrough {
  private pending: string[] = [];

  /** Run `command` in `cwd`, returning display + model-context renderings. */
  async run(command: string, cwd: string): Promise<ShellRunResult> {
    const proc = Bun.spawn(['bash', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const combined = [out, err].filter((s) => s.trim().length > 0).join('\n').trimEnd();
    const truncated = combined.length > MAX_SHELL_OUTPUT
      ? `${combined.slice(0, MAX_SHELL_OUTPUT)}\n… [truncated ${combined.length - MAX_SHELL_OUTPUT} chars]`
      : combined;
    const body = truncated.length > 0 ? truncated : '(no output)';
    const result: ShellRunResult = {
      display: `[Shell] ${body}\n(exit ${exitCode})`,
      context: `The user ran a shell command via the \`!\` prefix:\n$ ${command}\n--- output (exit ${exitCode}) ---\n${body}`,
    };
    this.pending.push(result.context);
    return result;
  }

  /** Prepend (and clear) any buffered shell context onto an outgoing message. */
  consumeContext(text: string): string {
    if (this.pending.length === 0) return text;
    const context = this.pending.join('\n\n');
    this.pending = [];
    return text ? `${context}\n\n${text}` : context;
  }
}
