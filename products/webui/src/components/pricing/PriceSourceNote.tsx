/**
 * PriceSourceNote, the provenance line under a dollar display: whose price
 * produced the number and, where the wire serves one, the date that price was
 * captured. The source and date are FACTS on the record now (a cost row / a
 * fleet node's `costSource` + `pricingAsOf`), so this component only formats
 * them, it no longer re-derives provenance from the live config or a
 * providers.usage probe.
 *
 *   - "your price"                     , costSource 'user' (the operator's own
 *                                         manual entry won the resolver).
 *   - "catalog price, as of <date>"    , costSource 'catalog'.
 *   - "provider-served price[, as of …]", costSource 'provider'.
 *   - "mixed pricing sources[, as of …]", costSource 'mixed' (an aggregate).
 *   - (no label)                       , source absent/unknown; the dollar
 *                                         display's own "price unknown" marker
 *                                         carries the honesty.
 *
 * Always offers the one-action path into manual-price editing, seeded with
 * this display's provider:model key when both are known. A 'user' source means
 * a manual entry already exists → "Edit price"; otherwise → "Set price".
 */
import { useState } from 'react';
import { manualPriceKey, priceSourceLabel, type WireCostSource } from '../../lib/cost-source';
import { Button } from '../ui/Button';
import { ModelPricesModal } from './ModelPricesModal';
import '../../styles/components/pricing.css';

export interface PriceSourceNoteProps {
  /** The wire's pricing provenance for the dollar figure this note annotates. */
  readonly costSource?: WireCostSource | null | undefined;
  /** The wire's dated as-of stamp for that price, when served. */
  readonly pricingAsOf?: string | null | undefined;
  /** Provider/model identity, only used to seed the manual-price editor. */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}

export function PriceSourceNote({ costSource, pricingAsOf, provider, model }: PriceSourceNoteProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const sourceText = priceSourceLabel(costSource, pricingAsOf);
  const manual = costSource === 'user';
  const modelKey = manualPriceKey(provider, model);

  return (
    <span className="price-source-note" data-testid="price-source-note">
      {sourceText && <span className="price-source-note__label">{sourceText}</span>}
      <Button
        size="sm"
        variant="ghost"
        className="price-source-note__edit"
        onClick={() => setEditorOpen(true)}
      >
        {manual ? 'Edit price' : 'Set price'}
      </Button>
      {/* Mounted only while open, so a closed note stays inert (no toast/query
          context needed until the user actually reaches for the editor). */}
      {editorOpen && (
        <ModelPricesModal
          open
          onClose={() => setEditorOpen(false)}
          {...(modelKey && !manual ? { initialModelKey: modelKey } : {})}
        />
      )}
    </span>
  );
}
