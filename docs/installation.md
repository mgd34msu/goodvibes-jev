# Install and uninstall GoodVibes Jev

The installer builds the daemon, terminal UI, agent and WebUI from your current
checkout of this repository. It supports Linux x64 and arm64 with glibc.
Run it as your normal user, without `sudo`.

You need Git, curl, tar, unzip and sha256sum. The installer supplies private Bun
and Node runtimes when needed, installs workspace dependencies, builds the suite,
verifies the Jev connection, pairs the TUI to the local daemon, registers its project workspace,
and enables a systemd user service. A working systemd user session is required
unless you choose `--no-service`. Allow several minutes for the first build.

```bash
git clone https://github.com/mgd34msu/goodvibes-jev.git
cd goodvibes-jev
read -rsp 'TypeSafe API key: ' TYPESAFE_API_KEY; echo
export TYPESAFE_API_KEY
./install.sh
unset TYPESAFE_API_KEY
```

The checkout must have no uncommitted changes to tracked files. To update, pull
this repository and run `./install.sh` again. The previous installation is kept
until the replacement starts successfully; a startup failure restores it.

## Credentials and commands

Jev uses `jev-latest`. To supply your TypeSafe key during installation without
putting it in shell history:

```bash
read -rsp 'TypeSafe API key: ' TYPESAFE_API_KEY; echo
export TYPESAFE_API_KEY
./install.sh
unset TYPESAFE_API_KEY
```

Installation requires a working Jev connection and stops with a setup error if
the key is missing or rejected. On the first install, an exported key is saved in the private environment file
at `~/.local/share/goodvibes-jev-data/environment`. Existing environment files
are preserved on updates. You can also edit that file afterward, then restart
with `systemctl --user restart goodvibes-jev.service`. Provider accounts and
optional integrations still need their usual setup in the application.

Commands are installed in `~/.local/bin`: `goodvibes`, `goodvibes-agent`,
`goodvibes-daemon` and `goodvibes-uninstall`. If necessary, add
`export PATH="$HOME/.local/bin:$PATH"` to your shell configuration.

The WebUI runs at **http://127.0.0.1:3421**. It is served by the daemon and
requires no separate service. Check status or logs with:

```bash
systemctl --user status goodvibes-jev.service
journalctl --user -u goodvibes-jev.service
```

The service starts with your user session. To start it before login and keep it
running after logout, run `loginctl enable-linger "$USER"`; your distribution
may require administrator authorization for that command.

## Options and storage

```bash
./install.sh --help
./install.sh --no-service             # Install without creating a service
./install.sh --service                # Enable the service on a later run
./install.sh --workspace ~/Projects/my-project  # Set the daemon's project workspace
./install.sh --port 43121             # Choose another local port
```

Programs live under `~/.local/share/goodvibes-jev`. Data, settings and credentials
live separately under `~/.local/share/goodvibes-jev-data`, which is the suite's
`GOODVIBES_HOME`; its application state is in the `.goodvibes` subdirectory.
An existing `~/.goodvibes` tree is left alone.

The daemon uses this checkout as its project workspace by default. Choose another
project with `--workspace`; updates remember that choice. Installation registers
the workspace and saves a private local TUI pairing credential so chat is ready
to connect. Uninstalling, including `--purge`, leaves the project workspace intact.

Use `--prefix DIR`, `--bin-dir DIR` and `--data-dir DIR` to choose different,
non-overlapping directories below your home. These paths must not traverse
symlinks. Repeat a custom install with the same `--prefix`; the other paths
are remembered. Existing commands and services belonging to another installation
are never overwritten. Choose another command directory or remove the previous
installation first.

With `--no-service`, start the daemon using `goodvibes-daemon serve`.
Browser drivers are included; browser engines and optional voice models are
provisioned by the application when those features are used.

## Uninstall

```bash
goodvibes-uninstall                  # Preserve settings, credentials and data
goodvibes-uninstall --purge          # Also delete this installation's data
```

The uninstaller stops and disables the managed service, then removes its unit,
commands, binaries and private runtimes. It works without the source checkout.
It refuses to delete a command or unit that has been replaced or modified.

From the repository, the equivalent commands are:

```bash
./uninstall.sh
./uninstall.sh --prefix "$HOME/custom-program-directory" --purge
```

Choose `--purge` when uninstalling if you want to delete the data. A normal
uninstall preserves it for a later reinstall. These commands do not remove your
source checkout, system runtimes, or other GoodVibes installations.
