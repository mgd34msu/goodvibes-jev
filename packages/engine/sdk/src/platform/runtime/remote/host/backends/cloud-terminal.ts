import { join } from 'node:path';
import type { CloudTerminalBackendConfig } from '../peer-registry.js';
import { type Backend, type BackendContext, BackendDispatchError, resolveTimeout, buildRemoteShellCommand } from './types.js';
import { runProcess } from './process-runner.js';
import { tokenizeCommand } from './local-process.js';
import { BackendLifetime } from './backend-lifetime.js';
import { OwnedCredentialDirectory } from './owned-credential-directory.js';
import { redactOwnedCredential } from './credential-output.js';

/** Pinned cloud CLI command shapes with single-use, owned credential scratch. */
export function createCloudTerminalBackend(ctx: BackendContext): Backend {
  const lifetime = new BackendLifetime();
  const scratch = new OwnedCredentialDirectory({
    rootDirectory: join(ctx.homeDirectory, '.goodvibes', 'tui', 'operator', 'cloud-creds'),
    logger: ctx.logger,
  });

  function buildArgs(
    config: CloudTerminalBackendConfig,
    remoteCommand: string,
  ): { args: string[]; credEnvKey?: string } {
    switch (config.provider) {
      case 'gcp': {
        // gcloud compute ssh runs `command` on the target Cloud Shell / instance.
        const args = ['gcloud', 'compute', 'ssh'];
        if (config.projectId) args.push('--project', config.projectId);
        if (config.location) args.push('--zone', config.location);
        args.push(config.instance ?? 'cloudshell', '--command', remoteCommand);
        return { args, credEnvKey: 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE' };
      }
      case 'aws': {
        // aws ssm send-command style: run shell command on a managed instance.
        const args = ['aws', 'ssm', 'start-session'];
        if (config.location) args.push('--region', config.location);
        if (config.instance) args.push('--target', config.instance);
        args.push(
          '--document-name', 'AWS-StartInteractiveCommand',
          '--parameters', `command=${remoteCommand}`,
        );
        return { args, credEnvKey: 'AWS_SHARED_CREDENTIALS_FILE' };
      }
      case 'azure': {
        // az vm run-command invoke executes a script on the target VM.
        const args = ['az', 'vm', 'run-command', 'invoke'];
        if (config.projectId) args.push('--resource-group', config.projectId);
        if (config.instance) args.push('--name', config.instance);
        args.push(
          '--command-id', 'RunShellScript',
          '--scripts', remoteCommand,
        );
        return { args, credEnvKey: 'AZURE_AUTH_LOCATION' };
      }
      default:
        throw new BackendDispatchError(
          `Unsupported cloud provider: ${String(config.provider)}`,
          'REMOTE_BACKEND_UNSUPPORTED_PROVIDER',
        );
    }
  }

  return {
    kind: 'cloud-terminal',
    dispatch(peer, command, payload) {
      return lifetime.run(async (signal) => {
        if (peer.backendConfig.kind !== 'cloud-terminal') {
          throw new BackendDispatchError(`Peer '${peer.peerId}' is not a cloud-terminal peer.`, 'REMOTE_BACKEND_KIND_MISMATCH');
        }
        const config = { ...peer.backendConfig };
        if (tokenizeCommand(command).length === 0) {
          throw new BackendDispatchError('Empty command.', 'REMOTE_BACKEND_BAD_COMMAND');
        }
        const remoteCommand = buildRemoteShellCommand(command, payload?.args);
        const { args, credEnvKey } = buildArgs(config, remoteCommand);
        let credential: string | null;
        try {
          credential = await lifetime.waitFor(() => ctx.credentials.resolveRef(config.credentialRef));
        } catch {
          lifetime.assertOpen();
          throw new BackendDispatchError(`Could not read cloud credential for peer '${peer.peerId}'.`, 'REMOTE_BACKEND_CREDENTIAL_FAILED');
        }
        if (typeof credential !== 'string' || credential.length === 0) {
          throw new BackendDispatchError(`Could not resolve cloud credential for peer '${peer.peerId}'.`, 'REMOTE_BACKEND_CREDENTIAL_MISSING');
        }
        const credPath = await scratch.write(credential, 'cred');
        try {
          lifetime.assertOpen();
          const env: Record<string, string> = { ...(payload?.env ?? {}) };
          if (credEnvKey) env[credEnvKey] = credPath;
          ctx.logger.info('remote cloud-terminal dispatch', { peerId: peer.peerId, provider: config.provider });
          let result;
          try {
            result = await runProcess({
              args, timeoutMs: resolveTimeout(payload), env, signal,
              ...(payload?.stdin !== undefined ? { stdin: payload.stdin } : {}),
            });
          } catch {
            lifetime.assertOpen();
            throw new BackendDispatchError(`Could not execute the ${config.provider} CLI for peer '${peer.peerId}'.`);
          }
          const stderr = redactOwnedCredential(result.stderr, credential);
          return {
            exitCode: result.timedOut ? 124 : result.exitCode,
            stdout: redactOwnedCredential(result.stdout, credential),
            stderr: result.timedOut ? `${stderr}\n[remote] cloud command timed out` : stderr,
          };
        } finally { await scratch.remove(credPath); }
      });
    },
    teardown: () => lifetime.close(() => scratch.close()),
  };
}
