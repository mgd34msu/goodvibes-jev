import { OwnedWork } from '../utils/owned-work.js';
import type { HookEvent, HookResult } from './types.js';

/** In-process ownership only. Never serialized in HookEvent or hook input. */
export interface HookDispatchOptions {
  readonly owner?: TurnHookOwner | undefined;
}

export interface TurnHookDispatcher {
  fire(event: HookEvent, options?: HookDispatchOptions): Promise<HookResult>;
}

export interface HookWorkAdmission {
  <T>(start: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T>;
}

/** One execution's admitted hook work; never stored on a shared dispatcher. */
export class TurnHookOwner {
  readonly sessionId: string;
  readonly turnId: string;
  private readonly controller = new AbortController();
  private readonly work = new OwnedWork();
  private accepting = true;
  private drained = false;
  private draining: Promise<void> | undefined;
  private readonly detach: () => void;

  constructor(sessionId: string, turnId: string, parentSignal: AbortSignal) {
    this.sessionId = sessionId;
    this.turnId = turnId;
    const abort = () => {
      this.accepting = false;
      this.controller.abort(parentSignal.reason);
    };
    parentSignal.addEventListener('abort', abort, { once: true });
    this.detach = () => parentSignal.removeEventListener('abort', abort);
    if (parentSignal.aborted) abort();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get isAccepting(): boolean { return this.accepting && !this.signal.aborted; }

  /** Reserve BEFORE entering any hook runner, callback, or reentrant host code. */
  admit<T>(start: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
    return this.reserve(start, this.isAccepting);
  }

  /** A dispatch admitted before normal drain may finish scheduling its hooks. */
  dispatch<T>(start: (admitHook: HookWorkAdmission) => T | PromiseLike<T>): Promise<T> {
    return this.admit(() => {
      let active = true;
      const admitHook: HookWorkAdmission = (run) => this.reserve(run, active && !this.drained && !this.signal.aborted);
      try { return Promise.resolve(start(admitHook)).finally(() => { active = false; }); }
      catch (error) { active = false; throw error; }
    });
  }

  private reserve<T>(start: (signal: AbortSignal) => T | PromiseLike<T>, admitted: boolean): Promise<T> {
    if (!admitted) return Promise.reject(new DOMException('Turn hook admission is closed', 'AbortError'));
    return this.work.run(() => start(this.signal));
  }

  /** No deadline races: an abort-ignoring hook remains owned until it settles. */
  closeAndDrain(): Promise<void> {
    if (this.draining) return this.draining;
    this.accepting = false;
    let resolve!: () => void;
    this.draining = new Promise<void>((accept) => { resolve = accept; });
    // Publish the stable drain promise before any completion continuation runs.
    void (async () => {
      // A previously admitted dispatch may register its later hooks while
      // draining. Its own promise keeps the join open until those are owned.
      await this.work.join();
      this.drained = true;
      this.detach();
      resolve();
    })();
    return this.draining;
  }
}

/** Track even custom dispatchers that do not understand the optional owner. */
export function bindTurnHookDispatcher(dispatcher: TurnHookDispatcher | null, owner: TurnHookOwner | null): TurnHookDispatcher | null {
  if (!dispatcher || !owner) return dispatcher;
  return { fire: (event) => {
    if (event.sessionId !== owner.sessionId) return Promise.reject(new Error('Hook event session does not match its turn owner'));
    return owner.admit(() => dispatcher.fire(event, { owner }));
  } };
}
