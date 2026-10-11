import type { IntakeCredentialStore } from '../../sdk/src/platform/intake/context.js';

/** Mutable setup fixture only. Production consumers receive the read-only port. */
export function triageCredentials(entries: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(entries));
  const revisions = new Map<string, number>();
  const credentials: IntakeCredentialStore = {
    async resolveRef(key) { return values.get(key) ?? null; },
    async resolveConfigSecret(key) { return values.get(key) ?? null; },
  };
  return {
    credentials,
    async has(key: string) { return values.has(key); },
    async put(key: string, value: string) {
      values.set(key, value);
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
    },
    capture(key: string) {
      const value = values.get(key);
      if (!value) throw new Error('Synthetic triage credential absent');
      const revision = revisions.get(key) ?? 0;
      return { value, assertCurrent() {
        if ((revisions.get(key) ?? 0) !== revision) throw new Error('Synthetic triage credential changed');
      } };
    },
  };
}
