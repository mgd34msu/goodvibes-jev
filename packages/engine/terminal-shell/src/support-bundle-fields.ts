import { CONFIG_SCHEMA, isDeclaredSecretBearingConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { StructuredRedactionOptions } from '@goodvibes-jev/engine/sdk/platform/utils';
import { captureOwnedJson } from '@goodvibes-jev/engine/sdk/platform/gate';

type Declaration = NonNullable<StructuredRedactionOptions['declaredFields']>[number];

/** Only native bundle fields and platform-declared config paths gain structure.
 * Extension fields keep the shared default of withholding unknown values. */
export function supportBundleFields(): readonly Declaration[] {
  const fields = new Map<string, Declaration>();
  const add = (path: readonly string[], kind: Declaration['kind'] = 'content') => {
    const previous = fields.get(JSON.stringify(path));
    if (previous?.kind === 'secret' || previous?.kind === 'owner_profile') return;
    fields.set(JSON.stringify(path), { path, kind });
  };
  const section = (parent: readonly string[], names: readonly string[]) => {
    for (const name of names) add([...parent, name]);
  };
  section([], ['version', 'type', 'capturedAt', 'package', 'roots', 'config', 'redaction', 'diagnostics', 'secrets', 'onboarding']);
  section(['package'], ['name', 'version']);
  section(['roots'], ['workingDirectory', 'homeDirectory']);
  section(['redaction'], ['sentinel', 'redactedConfigPaths']);
  section(['onboarding'], ['userMarker', 'projectMarker']);
  section(['diagnostics'], ['service', 'auth', 'providers']);
  section(['diagnostics', 'auth'], ['userStorePath', 'userStorePresent', 'bootstrapCredentialPath',
    'bootstrapCredentialPresent', 'operatorTokenPath', 'operatorTokenPresent']);
  const service = ['diagnostics', 'service'];
  section(service, ['config', 'managed', 'endpoints', 'log', 'issues', 'advisories']);
  section([...service, 'config'], ['enabled', 'autostart', 'restartOnFailure', 'daemonEnabled', 'connectedHostDialEnabled']);
  section([...service, 'managed'], ['platform', 'serviceName', 'path', 'installed', 'autostart', 'running', 'pid',
    'logPath', 'commandPreview', 'contents', 'suggestedCommands', 'lastAction', 'actionError', 'lingerNote', 'pidPath', 'lastError']);
  section([...service, 'endpoints', '*'], ['id', 'label', 'enabled', 'binding', 'bindPosture', 'networkFacing', 'reachable']);
  section([...service, 'endpoints', '*', 'binding'], ['host', 'port']);
  section([...service, 'log'], ['path', 'exists', 'size', 'modifiedAt', 'tail', 'readError']);
  section(['diagnostics', 'providers', '*'], ['provider', 'active', 'configured', 'configuredVia', 'models', 'setup']);
  section(['diagnostics', 'providers', '*', 'setup'], ['setupClass', 'setupLabel', 'setupDetail']);
  section(['secrets'], ['policy', 'secureAvailable', 'storedKeys', 'envBackedKeys', 'secureKeys', 'plaintextKeys', 'warnings', 'locations']);
  section(['secrets', 'locations', '*'], ['source', 'path', 'exists', 'readable']);
  for (const setting of CONFIG_SCHEMA) {
    const kind = isDeclaredSecretBearingConfigKey(setting.key) ? 'secret' : 'content';
    // The serializer also serves native config snapshots without a bundle envelope.
    for (const prefix of [[], ['config']]) {
      const path = [...prefix, ...setting.key.split('.')];
      for (let length = 1; length < path.length; length++) add(path.slice(0, length));
      add(path, kind);
      add([...prefix, setting.key], kind);
    }
  }
  // These declarations are code-owned, not mutable caller policy. The native
  // capture lets downstream ownership checks reuse their immutable slots.
  return captureOwnedJson([...fields.values()]) as readonly Declaration[];
}
