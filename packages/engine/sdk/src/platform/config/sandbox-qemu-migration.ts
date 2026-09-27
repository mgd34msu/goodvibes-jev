/**
 * Retiring the QEMU sandbox backend from settings files.
 *
 * The QEMU backend is gone, and with it every setting that only configured it:
 * the binary, the disk image, the host wrapper, the guest host, port, user and
 * workspace, the guest session mode, and the guest JavaScript command the REPL
 * ran inside the VM. `sandbox.vmBackend` stays, with `local` as its one value.
 *
 * Without this pass an old settings file would keep those keys forever: the
 * ingestion screen leaves unknown keys in the file untouched, and it would drop
 * `sandbox.vmBackend: "qemu"` on every load with a warning about a value the
 * platform itself retired. So the retired keys are removed, `"qemu"` is
 * rewritten to `"local"`, and the owner gets one receipt saying what changed.
 *
 * Nothing is carried to a new name. There is no setting left that means what
 * the QEMU keys meant, and the backend they configured no longer exists.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The retired leaf names under `sandbox`, in the order the schema declared them. */
export const RETIRED_SANDBOX_QEMU_FIELDS: readonly string[] = [
  'qemuBinary',
  'qemuImagePath',
  'qemuExecWrapper',
  'qemuGuestHost',
  'qemuGuestPort',
  'qemuGuestUser',
  'qemuWorkspacePath',
  'qemuSessionMode',
  'replJavaScriptCommand',
];

/** The retired keys as full dot-paths, for receipts and the settings screen. */
export const RETIRED_SANDBOX_QEMU_KEYS: readonly string[] =
  RETIRED_SANDBOX_QEMU_FIELDS.map((field) => `sandbox.${field}`);

/** Outcome of removing the QEMU sandbox settings from one parsed file. */
export interface SandboxQemuMigrationResult {
  readonly config: Record<string, unknown>;
  /** True when a retired key was removed or `sandbox.vmBackend` was rewritten. */
  readonly migrated: boolean;
  /** The retired dot-path keys that were present and removed, in schema order. */
  readonly removedKeys: readonly string[];
  /** True when `sandbox.vmBackend` was `"qemu"` and now reads `"local"`. */
  readonly rewroteVmBackend: boolean;
}

/**
 * Remove the retired `sandbox.qemu*` and `sandbox.replJavaScriptCommand` keys
 * and rewrite `sandbox.vmBackend: "qemu"` to `"local"`.
 *
 * Every other `sandbox` key is left exactly as written. A `sandbox` section left
 * empty goes too, so the file does not keep an empty `sandbox: {}` behind.
 *
 * Idempotent; a file with none of the retired state is returned untouched,
 * same reference.
 */
export function migrateSandboxQemuRemoval(parsed: Record<string, unknown>): SandboxQemuMigrationResult {
  const sandbox = parsed['sandbox'];
  if (!isPlainObject(sandbox)) {
    return { config: parsed, migrated: false, removedKeys: [], rewroteVmBackend: false };
  }
  const presentFields = RETIRED_SANDBOX_QEMU_FIELDS.filter((field) => field in sandbox);
  const rewroteVmBackend = sandbox['vmBackend'] === 'qemu';
  if (presentFields.length === 0 && !rewroteVmBackend) {
    return { config: parsed, migrated: false, removedKeys: [], rewroteVmBackend: false };
  }

  const config = structuredClone(parsed);
  const section = config['sandbox'] as Record<string, unknown>;
  for (const field of presentFields) delete section[field];
  if (rewroteVmBackend) section['vmBackend'] = 'local';
  if (Object.keys(section).length === 0) delete config['sandbox'];
  return {
    config,
    migrated: true,
    removedKeys: presentFields.map((field) => `sandbox.${field}`),
    rewroteVmBackend,
  };
}
