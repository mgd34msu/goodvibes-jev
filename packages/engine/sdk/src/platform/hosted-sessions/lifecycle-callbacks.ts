import { AsyncLocalStorage } from 'node:async_hooks';

/** Invocation ownership, not a global "callback is running" shortcut. */
class HostedLifecycleCallbacks {
  private readonly scope = new AsyncLocalStorage<ReadonlyMap<object, { active: boolean }>>();

  active(owner: object): boolean {
    return this.scope.getStore()?.get(owner)?.active === true;
  }

  async run<T>(owner: object, callback: () => T | Promise<T>): Promise<T> {
    const invocation = { active: true };
    const owners = new Map(this.scope.getStore());
    owners.set(owner, invocation);
    try {
      return await this.scope.run(owners, callback);
    } finally {
      invocation.active = false;
    }
  }

  outside<T>(owner: object, callback: () => T): T {
    const owners = new Map(this.scope.getStore());
    owners.delete(owner);
    return this.scope.run(owners, callback);
  }
}

// Internal to the hosted owners. No product callback or public API receives it.
export const hostedLifecycleCallbacks = new HostedLifecycleCallbacks();
