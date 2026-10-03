- **Added: themes.** display.theme picks goodvibes (the default), goodvibes-neon, catppuccin, tokyonight, dracula, nord, gruvbox, one-dark, rosepine, solarized, github, or system, which follows the terminal's own palette, under tmux too. A theme you already chose is kept.
- **Added: a calmer screen.** Modals on one surface kit replace the sidebar and tab strip (an Activity modal holds them), a one-row header with an empty row under it, an input area that holds only input, a status line with the context bar, and the throbber on its own row above the input area with half-row gaps around it.
- **Added: a back-to-bottom pill** while the output is scrolled back. Esc returns to the live output and never interrupts the turn.
- **Added: notifications name the work** on every channel, including Slack and Discord. The behavior.notificationsMetadataOnly setting sends metadata only and is off by default. System notices become toasts kept in a /notifications history, one entry per event.
- **Added: /context window and /status** show the model's context window and where it came from; a remote model with no real window takes it from the models.dev catalog.
- Changed: WRFC chains run isolated in their own git worktree, automatically, with no step for you. A passed chain commits only its own changes plus edits made by GoodVibes' own tools, runs your git hooks, and leaves your other uncommitted edits in place.
- Fixed: indented read bodies, wrapped code lines, finished turn headers, ended processes no longer counted as running, and printed command output that survives resizes.
- Changed: every open dependency advisory is closed; undici, brace-expansion, the Anthropic client (0.92), qs, body-parser, ip-address, fflate, fast-uri, js-yaml and sharp move to patched versions.
- Changed: pins move to sdk/terminal-shell/toolchain 2.1.0 and daemon 1.29.0; reusable-workflow pins repoint to the 2.1.0 release commit.

GoodVibes Agent 2.1.0 - 2026-09-30
