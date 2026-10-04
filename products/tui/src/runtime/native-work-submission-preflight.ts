import type { NativeWorkSubmissionState } from './native-work-submission.ts';

/** Single flight and host/workspace fencing start before any file or discovery IO. */
export class NativeWorkSubmissionPreflight {
  private active: AbortController | undefined;
  constructor(private readonly identity: () => string, private readonly invalidate: () => void) {}
  close(): void { this.active?.abort(); this.invalidate(); }
  async run(action: (signal: AbortSignal, current: () => boolean) => Promise<NativeWorkSubmissionState | undefined>): Promise<NativeWorkSubmissionState | undefined> {
    if (this.active) return { status: 'pending', message: 'A native submission action is already in progress.' };
    let identity: string;
    try { identity = this.identity(); } catch { return { status: 'unavailable', message: 'Native submission workspace or host is unavailable.' }; }
    const controller = new AbortController(); this.active = controller;
    const current = (): boolean => {
      if (controller.signal.aborted) return false;
      try { if (this.identity() === identity) return true; } catch { /* Unresolvable workspace revokes the operation. */ }
      controller.abort(); this.invalidate(); return false;
    };
    const timer = setInterval(current, 100); timer.unref?.();
    try {
      const result = await action(controller.signal, current);
      return current() ? result : undefined;
    } finally { clearInterval(timer); if (this.active === controller) this.active = undefined; }
  }
}
