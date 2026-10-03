/**
 * The provider/model picker, drawn with the modal surface kit.
 *
 *   ✦ Models › Main Chat › Select Model                           esc
 *     Main Chat   Helper Model   Tool LLM   TTS LLM         (target tabs)
 *
 *   ▏Search models                                        12 of 240
 *
 *   ✦ anthropic                         element panel
 *     Claude Sonnet   200k · paid         Target: Main Chat (enabled)
 *     ...                                 Selected: ...
 *
 *   ↑↓ move   ⏎ select   tab target   ctrl+t price   ctrl+k caps ...
 *
 * The model targets are tabs across the top (tab / ←→ switch), the search
 * row is always live, the list groups models under ✦ headers, and the
 * element panel beside it explains the target and the selected row in full.
 * Effort and context-cap steps are sub-levels (Esc goes back one).
 */

import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelPickerModal } from '../input/model-picker.ts';
import type { ModelPickerTargetInfo } from '../input/model-picker.ts';
import { isLocalFitRecommendation, isProviderSignInRow, LOCAL_REC_PROVIDER } from '../input/model-picker-local-fit.ts';
import { estimateModelBytes, fitAssessment, fitVerdictLabel, paramCountFromModel, readHardwareProfileSync, REPRESENTATIVE_7B_PARAMS } from '../core/hardware-profile.ts';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, scrollCountText, searchRow, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { panel, panelLines, type PanelLine } from './surface-kit-parts.ts';
import { drawTabRows, splitPanes, drawTextBlock } from './surface-kit-extra.ts';

/**
 * Rows the picker's chrome takes (title, tabs, search, padding, hints); the
 * key route subtracts it from the viewport height for page-sized moves.
 */
export const MODEL_PICKER_CHROME_LINES = 7;

const MODEL_WORKSPACE_TITLE = 'Models';
const MODEL_WORKSPACE_TARGETS_TITLE = 'Targets';
const MODEL_WORKSPACE_MODE_LABELS = {
  provider: 'Provider list',
  model: 'Model list',
  effort: 'Reasoning effort',
  contextCap: 'Context cap',
} as const;
const MODEL_WORKSPACE_TABLE_HEADERS = {
  provider: 'Provider                         Configuration       Catalog',
  effort: 'Reasoning effort                 Meaning',
  contextCap: 'Context cap input',
  modelKey: 'Model key',
  displayName: 'Display name',
  providerColumn: 'Provider',
  context: 'Context',
  tier: 'Tier',
  caps: 'Caps',
} as const;
const MODEL_WORKSPACE_REASONING_EFFORT_DETAIL = 'Reasoning effort applies to the main chat model. Select the default effort for this model.';
const MODEL_WORKSPACE_CONTEXT_CAP_DETAIL = 'Context cap overrides the detected local-model context window for this selection.';
const MODEL_WORKSPACE_CONTEXT_CAP_INPUT_HELP = 'Type digits to set a cap. Enter confirms; Esc returns to the model list.';
const MODEL_WORKSPACE_LOCAL_ONLY_HEADER = 'No provider signed in, these run on your machine';
const MODEL_WORKSPACE_LOCAL_ONLY_SIGN_IN = 'Sign in instead: select "Sign in to a provider" in the list below to connect a cloud or local provider.';

/**
 * Returns true when every model in the picker's list is a synthetic local
 * fit recommendation (no real credentials configured).
 */
function isLocalOnlyList(picker: ModelPickerModal): boolean {
  if (picker.mode !== 'model') return false;
  const models = picker.models;
  return models.length > 0 && models.every((m) => m.provider === LOCAL_REC_PROVIDER || isLocalFitRecommendation(m));
}

function formatContext(value: number | undefined): string {
  if (!value) return '-';
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function modelKey(model: ModelDefinition): string {
  return model.registryKey ?? `${model.provider}:${model.id}`;
}

function targetSummary(info: ModelPickerTargetInfo): string {
  if (!info.enabled) return 'disabled';
  const route = formatRoute(info.provider, info.model);
  if (info.inherited) return `inherits ${route}`;
  return route;
}

function selectedModel(picker: ModelPickerModal): ModelDefinition | null {
  if (picker.mode !== 'model') return null;
  return picker.getSelected();
}

function formatRoute(provider: string, model: string): string {
  if (!provider && !model) return '(not set)';
  if (!provider) return model;
  if (!model) return provider;
  return model.startsWith(`${provider}:`) ? model : `${provider}:${model}`;
}

function targetLabelFor(target: string): string {
  if (target === 'helper') return 'Helper Model';
  if (target === 'tool') return 'Tool LLM';
  if (target === 'tts') return 'TTS LLM';
  return 'Main Chat';
}

function providerSelectionDetail(targetLabel: string): string {
  return `Provider selection: choose a provider, then choose a model for ${targetLabel}.`;
}

function modelSelectionDetail(targetLabel: string): string {
  return `Model selection: choose the model to store for ${targetLabel}. Use filters to narrow large catalogs.`;
}

function modelWorkspaceFilterText(
  query: string,
  price: string,
  capability: string,
  group: string,
  availableOnly: string,
): string {
  return `Search: ${query} | Price: ${price} | Capability: ${capability} | Group: ${group} | Available only: ${availableOnly}`;
}


export function renderModelWorkspacePackageText(): string {
  return [
    MODEL_WORKSPACE_TITLE.trim(),
    MODEL_WORKSPACE_TARGETS_TITLE,
    MODEL_WORKSPACE_MODE_LABELS.provider,
    MODEL_WORKSPACE_MODE_LABELS.model,
    MODEL_WORKSPACE_MODE_LABELS.effort,
    MODEL_WORKSPACE_MODE_LABELS.contextCap,
    'Target: <target> (<state>)',
    'Current: <route>',
    providerSelectionDetail('<target>'),
    'Selected provider: <provider>',
    modelSelectionDetail('<target>'),
    'Selected: <model> | <display> | context <context> | <capabilities>',
    MODEL_WORKSPACE_REASONING_EFFORT_DETAIL,
    MODEL_WORKSPACE_CONTEXT_CAP_DETAIL,
    modelWorkspaceFilterText('<query>', '<price>', '<capability>', '<group>', '<available-only>'),
    MODEL_WORKSPACE_TABLE_HEADERS.provider,
    MODEL_WORKSPACE_TABLE_HEADERS.effort,
    MODEL_WORKSPACE_TABLE_HEADERS.contextCap,
    MODEL_WORKSPACE_TABLE_HEADERS.modelKey,
    MODEL_WORKSPACE_TABLE_HEADERS.displayName,
    MODEL_WORKSPACE_TABLE_HEADERS.providerColumn,
    MODEL_WORKSPACE_TABLE_HEADERS.context,
    MODEL_WORKSPACE_TABLE_HEADERS.tier,
    MODEL_WORKSPACE_TABLE_HEADERS.caps,
    'Model: <model>',
    'Detected context: <context>',
    'Override: <cap>',
    MODEL_WORKSPACE_CONTEXT_CAP_INPUT_HELP,
    MODEL_WORKSPACE_LOCAL_ONLY_HEADER,
    MODEL_WORKSPACE_LOCAL_ONLY_SIGN_IN,
    'Search models',
    'Search providers',
    '<n> of <total>',
    'No models match the search.',
    'No providers match the search.',
    'loading catalog…',
    ...hintsFor('model').map(([, action]) => action),
    ...hintsFor('provider').map(([, action]) => action),
    ...hintsFor('effort').map(([, action]) => action),
    ...hintsFor('contextCap').map(([, action]) => action),
  ].join('\n');
}

/**
 * Returns a plain-language hardware fit line for a local model, or an empty
 * string when the model is not local or when the verdict is unknown.
 * Uses the process-level cached hardware probe, never probes per render.
 */
/**
 * Format a param count (e.g. 70e9) as a human-readable size token (e.g. '70B', '1.5B').
 * Used to build the sizeDescriptor passed to fitVerdictLabel.
 */
function formatParamDescriptor(params: number): string {
  const b = params / 1e9;
  // Avoid floating-point noise: round to 1 decimal, strip trailing .0
  const rounded = Math.round(b * 10) / 10;
  return rounded === Math.floor(rounded) ? `${Math.floor(rounded)}B` : `${rounded}B`;
}

function modelHardwareFitLine(model: ModelDefinition): string {
  const provider = (model.provider ?? '').toLowerCase();
  // Anchor on known local-provider identities only; cloud providers that happen
  // to serve Llama/local-named models (Groq 'llama-3.1-70b', Together
  // 'meta-llama/...') are NOT local and must not be annotated.
  const isLocal =
    provider === 'ollama' ||
    provider === 'vllm' ||
    provider === 'llama-cpp' ||
    provider === 'llama.cpp' ||
    provider === 'lm-studio' ||
    provider === 'lmstudio' ||
    provider === 'localai' ||
    provider === 'tgi' ||
    provider === 'local-openai' ||
    provider === 'openai-compatible-local';
  if (!isLocal) return '';
  // Use the actual param count from the model id/displayName when parseable;
  // fall back to the shared 7B representative constant otherwise.
  const parsedParams = paramCountFromModel(model);
  const params = parsedParams ?? REPRESENTATIVE_7B_PARAMS;
  const sizeBytes = estimateModelBytes(params);
  // Build a human-readable size descriptor only when we could parse the real size.
  const sizeDescriptor = parsedParams !== null
    ? formatParamDescriptor(parsedParams)
    : undefined;
  const label = fitVerdictLabel(fitAssessment(sizeBytes, readHardwareProfileSync()), sizeDescriptor);
  return label ? `Hardware: ${label}` : '';
}

/** The explanation lines for the element panel (wrapped by panelLines). */
function detailLines(picker: ModelPickerModal): string[] {
  const target = picker.getSelectedTargetInfo();
  const targetLabel = target?.label ?? targetLabelFor(picker.target);
  const targetState = target ? (target.enabled ? 'enabled' : 'disabled') : 'active';
  const selected = selectedModel(picker);
  const lines: string[] = [];

  // Local-only header: shown when the list contains only synthetic fit recommendations.
  // Never show when any real provider is configured.
  if (isLocalOnlyList(picker)) {
    lines.push(MODEL_WORKSPACE_LOCAL_ONLY_HEADER);
    lines.push(MODEL_WORKSPACE_LOCAL_ONLY_SIGN_IN);
  }

  lines.push(`Target: ${targetLabel} (${targetState})`);
  if (target) lines.push(`Current: ${targetSummary(target)}`);
  if (picker.mode === 'provider') {
    const provider = picker.getFilteredProviders()[picker.selectedIndex] ?? '';
    lines.push(providerSelectionDetail(targetLabel));
    if (provider) lines.push(`Selected provider: ${provider}`);
  } else if (picker.mode === 'model') {
    lines.push(modelSelectionDetail(targetLabel));
    if (selected) {
      const caps = selected.capabilities ?? {};
      const capText = [
        caps.reasoning ? 'reasoning' : '',
        caps.multimodal ? 'vision' : '',
        caps.toolCalling ? 'tools' : '',
      ].filter(Boolean).join(', ') || 'standard';
      // Suppress the key:id line for synthetic local recommendations, they have
      // no real registry key and displaying the synthetic id would confuse users.
      if (isProviderSignInRow(selected)) {
        lines.push('Sign in to a provider to connect a cloud or local model.');
        if (selected.description) lines.push(selected.description);
      } else if (!isLocalFitRecommendation(selected)) {
        lines.push(`Selected: ${modelKey(selected)} | ${selected.displayName} | context ${formatContext(selected.contextWindow)} | ${capText}`);
      } else {
        lines.push(`Selected: ${selected.displayName}`);
        // Show the fit hint from the description (e.g. "not yet installed (fits in GPU memory)")
        if (selected.description) lines.push(selected.description);
      }
      const fitLine = modelHardwareFitLine(selected);
      if (fitLine) lines.push(fitLine);
    }
  } else if (picker.mode === 'effort') {
    lines.push(MODEL_WORKSPACE_REASONING_EFFORT_DETAIL);
  } else {
    lines.push(MODEL_WORKSPACE_CONTEXT_CAP_DETAIL);
  }
  const filterText = modelWorkspaceFilterText(picker.query || '(none)', picker.categoryFilter, picker.capabilityFilter, picker.groupBy, picker.availableOnly ? 'yes' : 'no');
  lines.push(filterText);
  return lines;
}


/** Keycap hints for a picker step. */
function hintsFor(mode: ModelPickerModal['mode']): KitHint[] {
  if (mode === 'effort') return [['↑↓', 'move'], ['⏎', 'use this effort']];
  if (mode === 'contextCap') return [['0-9', 'type a cap'], ['⏎', 'confirm']];
  if (mode === 'provider') return [['↑↓', 'move'], ['⏎', 'show models'], ['tab', 'target']];
  return [['↑↓', 'move'], ['⏎', 'select'], ['tab', 'target'], ['ctrl+t', 'price'], ['ctrl+k', 'caps'], ['ctrl+a', 'available'], ['ctrl+b', 'benchmark'], ['ctrl+g', 'group'], ['space', 'context cap (local)']];
}

function capabilityText(model: ModelDefinition): string {
  const caps = model.capabilities ?? {};
  return [caps.reasoning ? 'reasoning' : '', caps.multimodal ? 'vision' : '', caps.toolCalling ? 'tools' : ''].filter(Boolean).join(' ');
}

/** The muted row shown while the catalog is still loading behind an open picker. */
const LOADING_ROW: KitRow = { label: 'loading catalog…', muted: true };

function modelRows(picker: ModelPickerModal): KitRow[] {
  const t = activeTokens();
  const rows: KitRow[] = [];
  let lastGroup = '';
  picker.getFilteredModels().forEach((model, index) => {
    const group = picker.getModelGroupKey(model);
    if (group && group !== lastGroup) {
      rows.push({ header: group });
      lastGroup = group;
    }
    const synthetic = isProviderSignInRow(model) || isLocalFitRecommendation(model);
    const right = synthetic ? undefined : [formatContext(model.contextWindow), model.tier ?? 'paid'].join(' · ');
    rows.push({
      label: model.displayName,
      desc: synthetic ? undefined : [modelKey(model), capabilityText(model)].filter(Boolean).join(' · '),
      right,
      rightFg: model.tier === 'free' ? t.success : undefined,
      mark: picker.pinnedIds.has(model.id) ? '★' : undefined,
      markFg: t.warning,
      selected: index === picker.selectedIndex,
    });
  });
  return rows;
}

function providerRows(picker: ModelPickerModal): KitRow[] {
  const t = activeTokens();
  const counts = new Map<string, number>();
  for (const model of picker.models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  return picker.getFilteredProviders().map((provider, index) => {
    const configured = picker.configuredProviders.has(provider);
    const via = picker.configuredViaMap.get(provider) ?? (configured ? 'configured' : 'not configured');
    return {
      label: provider,
      desc: via,
      right: `${counts.get(provider) ?? 0} models`,
      mark: configured ? '●' : '○',
      markFg: configured ? t.success : t.textFaint,
      selected: index === picker.selectedIndex,
    };
  });
}

function effortRows(picker: ModelPickerModal): KitRow[] {
  return picker.effortLevels.map((effort, index) => ({
    label: effort,
    desc: picker.effortDetails.get(effort),
    selected: index === picker.selectedIndex,
  }));
}

/**
 * Render the model picker as a SurfaceLayer in screen coordinates.
 */
export function renderModelWorkspace(picker: ModelPickerModal, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const target = picker.getSelectedTargetInfo();
  const targetLabel = target?.label ?? targetLabelFor(picker.target);
  const f = beginModal(screenWidth, screenHeight, {
    title: MODEL_WORKSPACE_TITLE,
    crumbs: [targetLabel, MODEL_WORKSPACE_MODE_LABELS[picker.mode]],
    hints: hintsFor(picker.mode),
  });

  let top = f.top;
  // Target tabs: the active target carries the gradient.
  if (picker.targetInfos.length > 0) {
    const labels = picker.targetInfos.map((info) => `${info.label}${info.enabled ? '' : ' (off)'}`);
    top += drawTabRows(f.canvas, f.l, top, labels, picker.targetIndex, f.r) + 1;
  }

  const searchable = picker.mode === 'model' || picker.mode === 'provider';
  if (searchable) {
    const total = picker.mode === 'model' ? picker.models.length : picker.providers.length;
    const count = picker.query.length > 0 ? `${picker.mode === 'model' ? picker.getFilteredModels().length : picker.getFilteredProviders().length} of ${total}` : `${total} ${picker.mode === 'model' ? 'models' : 'providers'}`;
    searchRow(f, top, picker.query, picker.mode === 'model' ? 'Search models' : 'Search providers', count);
    top += 2;
  }

  const split = splitPanes(f.l, f.r, top, f.bottom, 0.5);
  const p = panel(f.canvas, split.panelX, split.panelY, split.panelW, split.panelH);
  const details: PanelLine[] = detailLines(picker).map((text, k) => ({
    text,
    style: { fg: k === 0 ? t.text : text.startsWith('Hardware:') ? t.info : t.textMuted, bold: k === 0 },
  }));
  panelLines(f.canvas, p, p.l, p.top, details);

  if (picker.mode === 'contextCap') {
    const model = picker.contextCapPendingModel;
    const input = picker.contextCapQuery.length > 0 ? `${picker.contextCapQuery}▏` : '▏(use detected context)';
    drawTextBlock(f.canvas, split.x0, split.top, split.x1 - split.x0 + 1, [
      { text: `Model: ${model ? modelKey(model) : '(none)'}`, style: { fg: t.text } },
      { text: `Detected context: ${formatContext(model?.contextWindow)}`, style: { fg: t.textMuted } },
      { text: `Override: ${input}`, style: { fg: t.brand, bold: true } },
      { text: '' },
      { text: MODEL_WORKSPACE_CONTEXT_CAP_INPUT_HELP, style: { fg: t.textFaint } },
    ], split.bottom);
    return finishModal(f);
  }

  const listed = picker.mode === 'model' ? modelRows(picker) : picker.mode === 'provider' ? providerRows(picker) : effortRows(picker);
  // The picker opens on its cached catalog; the rest fills in while this row shows.
  const rows = picker.catalogLoading && picker.mode !== 'effort' ? [LOADING_ROW, ...listed] : listed;
  if (rows.length === 0) {
    const message = picker.mode === 'provider' ? 'No providers match the search.' : 'No models match the search.';
    drawTextBlock(f.canvas, split.x0, split.top, split.x1 - split.x0 + 1, [{ text: message, style: { fg: t.textMuted } }], split.bottom);
    return finishModal(f);
  }
  const res = drawList(f.canvas, { rows, top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1, scrollKey: { owner: picker, name: picker.mode } });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}

