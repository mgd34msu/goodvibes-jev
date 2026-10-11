# Configuration

The daemon's `config` commands read and write settings on this machine. They work
without a running daemon and do not accept the remote `--host`, `--port`, or
`--token` options. Use the same selected homes and workspace as the daemon whose
settings you intend to change.

## Homes and workspace

The tree root is the directory containing `.goodvibes`. The daemon identity
directory and workspace are separate selections:

| Selection | Default | Override |
| --- | --- | --- |
| Tree root | Login home | `GOODVIBES_HOME` |
| Daemon identity directory | `<tree-root>/.goodvibes/daemon` | `--daemon-home`, otherwise `GOODVIBES_DAEMON_HOME` |
| Workspace | Invocation's current directory | `-C`, `--cd`, or `--working-dir`, otherwise `GOODVIBES_WORKING_DIR` |

`GOODVIBES_HOME` names the parent of `.goodvibes`, not `.goodvibes` itself.
Changing only the daemon identity directory does not move the whole tree.
Relative overrides resolve from the invocation's current directory, before the
selected workspace is applied. Blank home environment overrides are ignored.
The CLI does not change the parent process's environment or working directory.
See [CLI ownership](../src/cli/configuration.ts) and
[home resolution](../../../packages/engine/sdk/src/platform/config/goodvibes-home.ts).

## Settings files and precedence

The daemon still uses the `tui` surface directory for its surface settings and
workspace state. Changing that directory name would require a state migration.
Its daemon-owned settings have a separate store.
See the [surface declaration](../src/config/surface.ts).

| Settings tier | File | Role |
| --- | --- | --- |
| Global surface | `<tree-root>/.goodvibes/tui/settings.json` | Local surface preferences |
| Project surface | `<workspace>/.goodvibes/tui/settings.json` | Workspace overrides of surface preferences |
| Shared | `<tree-root>/.goodvibes/shared/settings.json` | The shared speech settings listed below |
| Daemon | `<daemon-identity-directory>/settings.json` | Settings owned by the daemon |

Settings start with schema defaults, then load the global and project surface
files. The shared tier overlays only `tts.provider`, `tts.voice`, `tts.speed`,
`tts.llmProvider`, and `tts.llmModel`. The daemon tier overlays daemon-owned keys
after those files. An absent stored value leaves the earlier value in effect.
Launch overrides take precedence over the resolved settings.

This is a precedence rule for the keys each tier owns, not permission for every
tier to override every key. In particular, the current shared-file reader does
not automatically load `provider.model` or `provider.reasoningEffort` as shared
defaults. Ordinary `config set` writes those keys to the global surface file.
See [settings loading and writes](../../../packages/engine/sdk/src/platform/config/manager.ts),
[shared settings](../../../packages/engine/sdk/src/platform/config/shared-config-tier.ts),
and [key ownership](../../../packages/engine/sdk/src/platform/config/config-ownership.ts).

An existing settings file that cannot be safely read is not a fresh installation.
The command can fail instead of replacing that file or silently using defaults.

## Persistent changes

```sh
goodvibes-daemon config list --json
goodvibes-daemon config get controlPlane.port --json
goodvibes-daemon config set controlPlane.port 4321
goodvibes-daemon config unset controlPlane.port
```

`list` reports schema settings and their effective values. `get` reads one known
key. `set` parses JSON values, booleans, and numbers before applying the schema's
validation and managed-setting locks. Otherwise, the value remains a string.
Unknown keys, invalid values, missing arguments, and write failures are refused.

The owning key determines where a persistent `set` writes:

| Key group | Destination |
| --- | --- |
| Daemon-owned keys, including `controlPlane.*`, `surfaces.*`, `hostedSessions.*`, and `cluster.*` | Daemon settings file |
| The five shared speech keys | Shared settings file |
| Other builtin keys, including model and local presentation settings | Global surface settings file |

The ownership source defines the complete set. The CLI has no project-write flag
and does not edit the project settings file. A project value can therefore
override a global `set` when settings are next loaded. `unset` removes the global
preference and applicable daemon or shared preference, and resets the command's
current value. It also leaves project settings untouched; an existing project
override can return on reload.

Normal CLI construction runs the daemon-owned settings migration against the
selected daemon store before loading settings. A migration failure is logged;
it does not guarantee that every legacy value was moved.
See [selected-store migration](../src/config/run-daemon-config-migration.ts) and
the [daemon settings store](../../../packages/engine/sdk/src/platform/config/daemon-config-tier.ts).

## Overrides for one launch

`serve` accepts repeatable `-c` or `--config key=value`, `--enable`, `--disable`,
`--provider`, `-m` or `--model`, and endpoint flags. They change the running
configuration without persisting those values to settings files.

The daemon applies explicit config values first, feature toggles next,
provider/model selection next, and host/port flags last. An explicit provider
wins over the provider embedded in the model argument, regardless of argv order.
Unknown features, keys, or invalid values refuse serving. Reloading settings
preserves active launch overrides. Starting without those flags omits them.
An explicit setting write or reset on the same running configuration manager
also supersedes the affected override.
These flags do not establish the account or runtime authority needed to activate
a configured service. See [serve preparation](../src/cli/serve.ts),
[override parsing](../../../packages/engine/terminal-shell/src/cli-config-overrides.ts),
and the [command reference](commands-reference.md#serve-default).

## Output and running services

Credential settings are redacted in text and JSON output, including nested
values. A supported `goodvibes://secrets/` reference can remain visible because
it is a pointer. Redaction cleans the output; it does not change the value being
stored. If safe output cannot be prepared before a write, settings remain
unchanged. If reporting fails after a completed write, the receipt preserves the
write outcome with a redacted value.

JSON `list` includes `data.settingsFile`, the global surface settings path. That
field is not the destination of every key. Current CLI receipts do not enumerate
per-key origins, destination tiers, or completed runtime reloads.
See [config commands](../src/daemon/config-command.ts) and
[recursive output](cli-and-package-contracts.md#recursive-config-output).

The runtime watches its settings files, but a successful write does not prove a
listener has rebound or a provider is usable. Inspect `status` for the actual
bound endpoint and service health. Plain-text `config set` output includes a
general restart warning. Service restart requires the supported installed
service composition.
See [deployment boundaries](../README.md) and
[troubleshooting](troubleshooting.md#port-conflicts-and-webui-exposure).

## Verification limits

Existing [command tests](../src/test/daemon/config-command.test.ts) cover settings
verbs and recursive output. [Safety tests](../src/test/daemon/config-command-safety.test.ts)
cover real-manager validation, refusal before mutation, unchanged stored bytes,
and honest post-write receipts. [Emitted CLI tests](../src/test/cli/entrypoint.test.ts)
cover the selected daemon store across processes and selected-store migration.
These are bounded fixture contracts, not live-provider or release acceptance.
See [testing and validation](testing-and-validation.md) for the supported runner.
