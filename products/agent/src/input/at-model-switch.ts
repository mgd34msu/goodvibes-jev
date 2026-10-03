/**
 * at-model-switch.ts, the `@model:<id>` inline switch a person can put in the
 * middle of a message.
 *
 * `send this @model:opus and summarize` switches the model and sends
 * "send this and summarize". The switch is applied immediately and the token is
 * stripped from the text, so the model never receives the instruction that
 * chose it.
 *
 * Extracted from the composer because it is a self-contained rewrite of the
 * submitted text with its own failure mode: an id that names no model reports
 * that and leaves the rest of the message intact, rather than refusing the
 * whole submission over one mistyped token.
 */

import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';

const AT_MODEL_RE = /@model:([^\s]+)/g;

export interface AtModelSwitchOptions {
  readonly providerRegistry: Pick<ProviderRegistry, 'setCurrentModel' | 'getCurrentModel'>;
  readonly configManager: Pick<ConfigManager, 'set'>;
  /** Applied for each switch that took, so the surface's own labels follow. */
  readonly onModelChanged: (model: { readonly id: string; readonly provider: string }) => void;
  /** One line per switch, what it became, or that the id named nothing. */
  readonly notify: (message: string) => void;
}

/**
 * Apply every `@model:` token in `text` and return the text with them removed.
 *
 * Returns the input unchanged when there are none, which is the common case.
 */
export function applyAtModelSwitches(text: string, options: AtModelSwitchOptions): string {
  let processedText = text;
  let match: RegExpExecArray | null;
  AT_MODEL_RE.lastIndex = 0;
  while ((match = AT_MODEL_RE.exec(text)) !== null) {
    const modelId = match[1];
    try {
      options.providerRegistry.setCurrentModel(modelId as string);
      const def = options.providerRegistry.getCurrentModel();
      options.onModelChanged({ id: def.id, provider: def.provider });
      options.configManager.set('provider.model', def.registryKey);
      options.notify(`[Model] Switched to ${def.displayName} (${def.provider}) via @model:`);
    } catch {
      options.notify(`[Model] Unknown model: ${modelId}`);
    }
    processedText = processedText.replace(match[0], '').trim();
  }
  return processedText;
}
