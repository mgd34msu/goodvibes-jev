/**
 * `errors.stale-server-kind`: whether a window of a consumer-facing error doc
 * or worker test still presents 'server' as an SDK error kind. It replaces six
 * shape regexes in error-contract-check.ts (`case 'server'`, `kind: 'server'`,
 * 'server' within 240 characters of `SDKErrorKind` or `validKinds`, "typed
 * 'server' kind", "use 'server' for"), which flagged a migration note saying
 * 'server' was replaced and missed any other phrasing of the same advice.
 *
 * Read by `bun run error-kinds:read` for each checked file whose content has
 * no stored reading; error-contract-check.ts compares the stored readings
 * (etc/stale-server-kind-readings.json) offline.
 *
 * State: `{ path, currentKinds, text }`, the file's repo-relative path, the
 * members of the current `SDKErrorKind` union, and one window of the file.
 *
 * Band: low stakes. A wrong yes blocks a commit with a message a person can
 * check; a wrong no lets a stale sentence into a doc, with no runtime effect.
 * The gate passes only a settled no.
 */
import { defineBattery, PINNED_MODEL, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** A type alias rather than an interface, so it is assignable to the port's JSON state type. */
export type StaleServerKindState = {
  readonly path: string;
  readonly currentKinds: string[];
  readonly text: string;
};

const KINDS = ['auth', 'config', 'contract', 'network', 'not-found', 'protocol', 'rate-limit', 'service', 'internal', 'tool', 'validation', 'unknown'];
const at = (path: string, text: string): StaleServerKindState => ({ path, currentKinds: KINDS, text });

export const staleServerKind = defineBattery({
  name: 'errors.stale-server-kind',
  version: 1,
  description: "Whether a doc or test window presents 'server' as an SDK error kind callers should use today.",
  accuracyFloor: 0.9,
  model: PINNED_MODEL,
  items: {
    stale: yesNo(
      "`currentKinds` lists every error kind the SDK has today; 'server' is not one of them. Does `text` present 'server' as an error kind that callers of the SDK should use, match on or expect today, for example a kind table or list that includes it, a code sample that sets or switches on `kind` 'server' as a live value, or advice to handle or use the 'server' kind? Text that says 'server' was an old kind that was removed or replaced, text that checks it is absent, and text that uses the word server for a remote server, a server process or a server-side component rather than as an error kind are not.",
      STAKES_BANDS.low.yesNo,
    ),
  },
  fixtures: [
    {
      name: 'switch on the old kind',
      state: at('docs/error-handling.md', "```ts\nswitch (err.kind) {\n  case 'auth': return relogin();\n  case 'server': return retryLater();\n}\n```"),
      expect: { stale: 'yes' },
    },
    {
      name: 'kind table row',
      state: at('docs/error-kinds.md', "| Kind | When it fires |\n| --- | --- |\n| `'network'` | The transport could not reach the daemon. |\n| `'server'` | The daemon returned a 5xx response. |"),
      expect: { stale: 'yes' },
    },
    {
      name: 'advice to use the kind',
      state: at('docs/web-ui-integration.md', "When the daemon answers with a 5xx status, the SDK raises an error of kind 'server'; show a retry banner for it."),
      expect: { stale: 'yes' },
    },
    {
      name: 'worker test expecting the kind',
      state: at('test/workers/workers.test.ts', "const err = await call().catch((e) => e);\nexpect(err.kind).toBe('server');"),
      expect: { stale: 'yes' },
    },
    {
      name: 'object literal with the kind',
      state: at('docs/react-native-integration.md', "Errors arrive as `{ kind: 'server', status: 503, recoverable: true }`; branch on `kind`."),
      expect: { stale: 'yes' },
    },
    {
      name: 'migration note',
      state: at('docs/error-kinds.md', "Earlier releases had a typed 'server' kind for every 5xx. It was split into 'service' for upstream failures and 'internal' for daemon faults; code that matched 'server' should match those two instead."),
      expect: { stale: 'no' },
    },
    {
      name: 'remote server prose',
      state: at('docs/error-kinds.md', '**When it fires:** The remote server returned HTTP 404.\n\n**Remediation:** The resource does not exist at the server. Verify identifiers and do not retry.'),
      expect: { stale: 'no' },
    },
    {
      name: 'current kinds only',
      state: at('docs/browser-integration.md', "```ts\nif (err.kind === 'service' || err.kind === 'network') scheduleRetry();\n```\nA dev server on port 5173 proxies to the daemon."),
      expect: { stale: 'no' },
    },
    {
      name: 'test asserting absence',
      state: at('test/workers-wrangler/wrangler.test.ts', "// Assert 'kind' is a typed SDKErrorKind, never the removed 'server'.\nexpect(kinds).not.toContain('server');"),
      expect: { stale: 'no' },
    },
    {
      name: 'server version alignment',
      state: at('docs/error-kinds.md', 'Check server/client version alignment and transport logs. `hint` is a human-readable remediation hint from the server.'),
      expect: { stale: 'no' },
    },
  ],
});
