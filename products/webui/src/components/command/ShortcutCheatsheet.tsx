/**
 * ShortcutCheatsheet: the "?" dialog listing every registered command that has a
 * shortcut, in the palette's sections. A kit Dialog: glass over the scrim, focus
 * trapped and returned, Escape or the scrim closes it.
 */
import { useEffect, useMemo, useState } from 'react';
import { type CommandDef, getCommands, subscribeCommands } from '../../lib/commands';
import { buildPaletteSections, PALETTE_SECTION_LABELS } from '../../lib/command-groups';
import { Dialog } from '../ui/Dialog';
import { formatShortcut } from './CommandPalette';

interface ShortcutCheatsheetProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutCheatsheet({ open, onClose }: ShortcutCheatsheetProps) {
  const [allCommands, setAllCommands] = useState<CommandDef[]>(() => getCommands());

  useEffect(() => subscribeCommands(() => setAllCommands(getCommands())), []);

  const sections = useMemo(
    () => buildPaletteSections(allCommands.filter((cmd) => Boolean(cmd.shortcut))),
    [allCommands],
  );

  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" className="cheat-sheet">
      {sections.length === 0 ? (
        <p className="cheat-empty">No shortcuts registered.</p>
      ) : (
        sections.map(({ section, commands }) => (
          <section key={section} className="cheat-group" aria-label={PALETTE_SECTION_LABELS[section]}>
            <h3 className="cheat-group-label">{PALETTE_SECTION_LABELS[section]}</h3>
            <dl className="cheat-list">
              {commands.map((cmd) => (
                <div key={cmd.id} className="cheat-row">
                  <dt className="cheat-action">{cmd.title}</dt>
                  <dd className="cheat-keys">
                    <kbd>{formatShortcut(cmd.shortcut ?? '')}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))
      )}
    </Dialog>
  );
}
