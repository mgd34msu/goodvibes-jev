# SDK update checklist

Use this checklist for routine `@pellux/goodvibes-sdk` updates.

## Preconditions

- The SDK version is published on npm.
- If the update depends on daemon/TUI runtime behavior, wait for a TUI/daemon
  handoff confirming the installed daemon reports the expected SDK version.
- Do not use a local SDK checkout. If the local overlay was linked for
  development, restore it first (`bun run sdk:status`, then
  `bun run sdk:restore`); the build refuses to ship while the overlay is
  active.
- Do not edit package versions by hand and assume the install happened.

## Commands

Check npm latest:

```bash
npm view @pellux/goodvibes-sdk version
```

Install the exact version:

```bash
bun add @pellux/goodvibes-sdk@<version>
```

Verify the installed package:

```bash
node -p "require('./node_modules/@pellux/goodvibes-sdk/package.json').version"
```

Verify `package.json`:

```bash
node -p "require('./package.json').dependencies['@pellux/goodvibes-sdk']"
```

Verify `bun.lock`:

```bash
rg -n "<version>|@pellux/goodvibes-sdk" bun.lock package.json
```

Clear Vite optimized deps:

```bash
rm -rf node_modules/.vite
```

Regenerate what the SDK and the version feed (below), then check the change
locally; CI runs the full suites:

```bash
bun run test:changed
bun run typecheck
```

## Version and changelog

Bump the version and regenerate everything derived from the SDK and the
version (the config schema and ownership modules, the presentation tokens, the
`index.html` cache-bust values, the README badges, the CHANGELOG section):

```bash
bun run release:prepare --patch
```

Write the scaffolded `CHANGELOG.md` entry:

```md
## [<webui-version>] - YYYY-MM-DD

### Changed

- Updated `@pellux/goodvibes-sdk` to `<version>`.
```


## Source checks

Confirm no accidental local SDK or extension-specific code was introduced:

```bash
rg -n "file:|link:|\\.\\./.*goodvibes-sdk" package.json bun.lock
rg -n "homeassistant|homeGraph|HomeGraph|includeAllSpaces|knowledgeSpaceId" src || true
rg -n "wrfc|workmap|owner_decision|owner decision|route selector|resume hooks" src || true
```

The second and third checks are not always errors, but they force an explicit
review. Do not add WRFC/workmap surfaces unless there is a WebUI-facing product
request and SDK handoff. Do not add Home Graph behavior to regular Knowledge.

## Commit and push (CI cuts the tag)

```bash
git add CHANGELOG.md README.md bun.lock index.html package.json src/lib/generated src/styles/generated
git commit -m "Update GoodVibes SDK to <version>"
git push origin main
```

Do not tag by hand. The auto-release job tags the commit after a green CI run
and attaches the built bundle to the GitHub Release; a manually pushed tag
makes that job skip the release, which ships no bundle asset for the
installer.

If code changes are required by the SDK handoff, include those files in the
commit and use a message that names the behavior, not only the dependency bump.

## Restart dev server

Stop existing Vite processes and restart with fresh optimized deps:

```bash
pgrep -af "node .*vite|vite --force|bun.*vite" || true
kill <pid>
rm -rf node_modules/.vite
setsid node ./node_modules/.bin/vite --force > /tmp/goodvibes-webui-vite.log 2>&1 < /dev/null &
```

Verify:

```bash
sed -n '1,120p' /tmp/goodvibes-webui-vite.log
ss -ltnp | rg ':3423'
curl -sS --max-time 3 http://127.0.0.1:3423/ | rg '<webui-version>'
node -p "require('./node_modules/@pellux/goodvibes-sdk/package.json').version"
```

## GitHub CI

Check the pushed run:

```bash
gh run list --limit 5
gh run watch <run-id> --exit-status
```

Do not call an SDK update complete until:

- `node_modules` reports the new SDK version
- `bun.lock` changed
- local CI passed
- GitHub CI passed
- the dev server was restarted and is serving the new WebUI version
