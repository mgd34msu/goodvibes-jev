/**
 * General: appearance (theme with GoodVibes Neon, density), language, the
 * code-block line-number preference (formerly Admin's "Display Preferences"),
 * then the display / ui / behavior / daemon / update config groups.
 */
import { useTheme } from '../../../../hooks/useTheme';
import { useWebUiPreferences } from '../../../../lib/ui-preferences';
import type { Theme } from '../../../../lib/theme';
import { Segmented } from '../../../ui/Segmented';
import { Toggle } from '../../../ui/Toggle';
import { ConfigGroupList, useConfigSettings } from '../ConfigSettings';
import { SettingRow, SettingsBlock } from '../parts';
import { groupsForSection } from '../sections';

type BaseTheme = Exclude<Theme, 'neon'>;

const THEME_OPTIONS: readonly { value: BaseTheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
];

export function GeneralSection() {
  const { theme, setTheme, density, setDensity } = useTheme();
  const [preferences, setPreference] = useWebUiPreferences();
  const { groups } = useConfigSettings();
  const neon = theme === 'neon';

  return (
    <>
      <SettingsBlock title="Appearance" description="Applies to this browser only.">
        <div className="settings-rows">
          <SettingRow
            label="Theme"
            description={neon ? 'GoodVibes Neon is on; picking a theme turns it off.' : 'Auto follows your system setting.'}
            control={(
              <Segmented<BaseTheme | ''>
                label="Theme"
                value={neon ? '' : theme}
                options={THEME_OPTIONS}
                onChange={(next) => { if (next) setTheme(next); }}
              />
            )}
          />
          <SettingRow
            label="GoodVibes Neon"
            description="The original neon look: cyan and magenta on a dark grid."
            control={<Toggle checked={neon} aria-label="GoodVibes Neon" onChange={(on) => setTheme(on ? 'neon' : 'dark')} />}
          />
          <SettingRow
            label="Density"
            description="Compact tightens rows and spacing."
            control={(
              <Segmented
                label="Density"
                value={density}
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'compact', label: 'Compact' },
                ]}
                onChange={setDensity}
              />
            )}
          />
          <SettingRow
            label="Language"
            description="The interface is in English. Dates, times and numbers follow this browser's regional settings."
            control={<span className="settings-row__value">English</span>}
          />
          <SettingRow
            label="Line numbers in code blocks"
            description="Decorative only: copy buttons and whole-message copy use the raw text without line numbers."
            control={(
              <Toggle
                checked={preferences.codeBlockLineNumbers}
                aria-label="Show line numbers in rendered code blocks"
                onChange={(on) => setPreference('codeBlockLineNumbers', on)}
              />
            )}
          />
        </div>
      </SettingsBlock>
      <ConfigGroupList groups={groupsForSection('general', groups)} />
    </>
  );
}
