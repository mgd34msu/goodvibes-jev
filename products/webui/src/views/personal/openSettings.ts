/**
 * Open the settings dialog on a section from inside a view. The dialog lives in
 * the URL (`?settings=<section>`, App.tsx), so this pushes that state and tells
 * the URL hook to re-read it, the same thing the browser's Back button does.
 */
import { getCurrentUrlState, pushState } from '../../lib/router';

export function openSettingsSection(section: string): void {
  pushState({ ...getCurrentUrlState(), settings: section });
  window.dispatchEvent(new PopStateEvent('popstate'));
}
