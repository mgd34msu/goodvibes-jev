import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA_ENTRIES } from '../../../lib/generated/config-schema';
import { buildSettingsModel } from '../../../lib/settings-model';
import {
  SETTINGS_PAGES,
  SETTINGS_SECTIONS,
  groupsForSection,
  matchSettingsPages,
  matchSettingsSections,
  pageOfSection,
  resolveSettingsSection,
  sectionForNamespace,
  sectionsOfPage,
} from './sections';

const groups = buildSettingsModel({ display: { theme: 'nord' }, mystery: { key: 1 } });

describe('settings dialog sections', () => {

  test('every section lives on exactly one page, and each page opens on the section named like it', () => {
    const placed = SETTINGS_PAGES.flatMap((p) => sectionsOfPage(p.id).map((s) => s.id));
    expect([...placed].sort()).toEqual(SETTINGS_SECTIONS.map((s) => s.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
    for (const page of SETTINGS_PAGES) {
      expect(sectionsOfPage(page.id)[0].id).toBe(page.id);
      for (const section of sectionsOfPage(page.id)) expect(pageOfSection(section.id)).toBe(page.id);
    }
  });

  test('deep links: known ids, old names and unknown values', () => {
    expect(resolveSettingsSection('models')).toBe('models');
    expect(resolveSettingsSection('providers')).toBe('models');
    expect(resolveSettingsSection('admin')).toBe('account');
    expect(resolveSettingsSection('principals')).toBe('people');
    // Every older section link still resolves to its section, now on a page.
    for (const id of ['devices', 'people', 'credentials', 'usage', 'network', 'about', 'all', 'checkins'] as const) {
      expect(resolveSettingsSection(id)).toBe(id);
    }
    expect(resolveSettingsSection('checkin')).toBe('checkins');
    expect(pageOfSection(resolveSettingsSection('devices'))).toBe('account');
    expect(pageOfSection(resolveSettingsSection('checkins'))).toBe('notifications');
    expect(pageOfSection(resolveSettingsSection('all'))).toBe('general');
    expect(resolveSettingsSection('nonsense')).toBe('general');
    expect(resolveSettingsSection('')).toBe('general');
  });

  test('every config group renders in exactly one section, nothing unreachable', () => {
    const seen = new Map<string, string>();
    for (const section of SETTINGS_SECTIONS) {
      for (const group of groupsForSection(section.id, groups)) {
        expect(seen.has(group.id)).toBe(false);
        seen.set(group.id, section.id);
      }
    }
    for (const group of groups) expect(seen.has(group.id)).toBe(true);
    // A live namespace the schema has never heard of lands in All settings.
    expect(seen.get('mystery')).toBe('all');
  });

  test('no section claims a namespace the schema does not define', () => {
    const schemaNamespaces = new Set(CONFIG_SCHEMA_ENTRIES.map((e) => e.key.split('.')[0]));
    for (const section of SETTINGS_SECTIONS) {
      for (const ns of section.namespaces) {
        expect(schemaNamespaces.has(ns)).toBe(true);
      }
    }
  });

  test('namespaces land where a person would look', () => {
    expect(sectionForNamespace('voice')).toBe('voice');
    expect(sectionForNamespace('permissions')).toBe('permissions');
    expect(sectionForNamespace('learning')).toBe('memory');
    expect(sectionForNamespace('provider')).toBe('models');
    expect(sectionForNamespace('payments')).toBe('usage');
    expect(sectionForNamespace('relay')).toBe('network');
    expect(sectionForNamespace('orchestration')).toBe('all');
    expect(sectionForNamespace('checkin')).toBe('checkins');
  });

  test('search matches section words whole, and counts matching settings elsewhere', () => {
    const all = buildSettingsModel({});
    const byLabel = matchSettingsSections('tailscale', all);
    expect(byLabel.find((m) => m.id === 'network')?.whole).toBe(true);

    const bySetting = matchSettingsSections('consolidation', all);
    const memory = bySetting.find((m) => m.id === 'memory');
    expect(memory).toBeDefined();
    expect(memory?.settingCount).toBeGreaterThan(0);

    expect(matchSettingsSections('zzzz-no-such-setting', all)).toEqual([]);
    expect(matchSettingsSections('', all)).toHaveLength(SETTINGS_SECTIONS.length);
  });

  test('pages match through their sections, in nav order, summing setting counts', () => {
    const all = buildSettingsModel({});
    expect(matchSettingsPages(matchSettingsSections('', all)).map((p) => p.id)).toEqual(SETTINGS_PAGES.map((p) => p.id));
    const tailscale = matchSettingsPages(matchSettingsSections('tailscale', all));
    expect(tailscale[0]?.id).toBe('general');
    expect(tailscale[0]?.sections.map((m) => m.id)).toContain('network');
    const checkins = matchSettingsPages(matchSettingsSections('quiet hours', all));
    expect(checkins.map((p) => p.id)).toContain('notifications');
    expect(matchSettingsPages([])).toEqual([]);
  });
});
