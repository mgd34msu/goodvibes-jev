import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';
const readings = useKnowledgeAnswerReadings();
beforeEach(() => { readings.set({ quality: [['vendor.example', 0.98], ['example.org', 0.8], ['Buy now using affiliate links.', 0.03], ['Sponsored marketplace listing', 0.03], ['shop.example', 0.03]] }); });
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  rankHomeGraphPageSources,
  homeGraphPageSourceWeight,
  isUsefulHomeGraphPageSource,
  isUsefulHomeGraphPageSourceCandidate,
} from '../sdk/src/platform/knowledge/home-graph/page-quality.js';
import type { KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';

const FIXED_TEST_EPOCH_MS = Date.UTC(2026, 0, 1);

function source(overrides: Partial<KnowledgeSourceRecord>): KnowledgeSourceRecord {
  return {
    id: 'source-test',
    connectorId: 'test',
    sourceType: 'url',
    title: 'Source',
    tags: [],
    status: 'indexed',
    metadata: {},
    createdAt: FIXED_TEST_EPOCH_MS,
    updatedAt: FIXED_TEST_EPOCH_MS,
    ...overrides,
  };
}

describe('Home Graph page source quality', async () => {
  test('keeps official indexed evidence and rejects generated or commercial sources', async () => {
    const official = source({
      id: 'official',
      title: 'Vendor product specifications',
      sourceUri: 'https://vendor.example/support/product/specifications',
      metadata: {
        sourceDiscovery: {
          trustReason: 'official-vendor-domain',
          sourceRank: 1,
        },
      },
    });
    const generated = source({
      id: 'generated',
      metadata: { generatedKnowledgePage: true, generatedProjection: true },
    });
    const commercial = source({
      id: 'commercial',
      title: 'Latest price and ranking system',
      sourceUri: 'https://store.example/prices-features',
      summary: 'Buy now using affiliate links.',
    });

    expect(await isUsefulHomeGraphPageSource(official)).toBe(true);
    expect(await isUsefulHomeGraphPageSource(generated)).toBe(false);
    expect(await isUsefulHomeGraphPageSource(commercial)).toBe(false);
  });

  test('weights and sorts stronger evidence ahead of generic sources', async () => {
    const official = source({
      id: 'official',
      sourceUri: 'https://vendor.example/support/product/specifications',
      metadata: {
        sourceDiscovery: {
          trustReason: 'official-vendor-domain',
          sourceRank: 1,
        },
      },
    });
    const generic = source({
      id: 'generic',
      sourceUri: 'https://example.org/blog/device-overview',
      metadata: {},
    });

    expect(await homeGraphPageSourceWeight(official)).toBe(0.98);
    expect(await homeGraphPageSourceWeight(generic)).toBe(0.8);
    expect((await rankHomeGraphPageSources([generic, official])).map((item) => item.id)).toEqual(['official', 'generic']);
    expect(await isUsefulHomeGraphPageSourceCandidate(official)).toBe(true);
  });

  test('recognizes official evidence carried only in url aliases', async () => {
    const officialUrlOnly = source({
      id: 'official-url-only',
      url: 'https://vendor.example/support/product/specifications',
      metadata: {
        sourceDiscovery: {
          trustReason: 'official-vendor-domain',
          sourceRank: 1,
        },
      },
    });
    const generic = source({
      id: 'generic',
      sourceUri: 'https://example.org/blog/device-overview',
      metadata: {},
    });

    expect(await homeGraphPageSourceWeight(officialUrlOnly)).toBe(0.98);
    expect(await homeGraphPageSourceWeight(generic)).toBe(0.8);
    expect(await isUsefulHomeGraphPageSourceCandidate(officialUrlOnly)).toBe(true);
  });

  test('rejects marketplace sources even when they look product-specific', async () => {
    const marketplace = source({
      id: 'marketplace',
      title: 'Vendor model store listing',
      url: 'https://www.amazon.com/example-product',
      summary: 'Sponsored marketplace listing with latest price and seller details.',
      metadata: {
        sourceDiscovery: {
          trustReason: 'model-match',
          sourceRank: 1,
        },
      },
    });

    expect(await isUsefulHomeGraphPageSource(marketplace)).toBe(false);
    expect(await isUsefulHomeGraphPageSourceCandidate(marketplace)).toBe(false);
  });

  test('keeps relevant pending support/spec sources so generated pages can link accepted repair evidence', async () => {
    const pendingSupport = source({
      id: 'pending-support',
      status: 'pending',
      title: 'Vendor support specifications',
      sourceUri: 'https://vendor.example/support/product/specifications',
      metadata: {},
    });
    const pendingCommercial = source({
      id: 'pending-commercial',
      status: 'pending',
      title: 'Latest price comparison and affiliate ranking',
      sourceUri: 'https://shop.example/product/latest-price',
      metadata: {},
    });

    expect(await isUsefulHomeGraphPageSource(pendingSupport)).toBe(true);
    expect(await isUsefulHomeGraphPageSource(pendingCommercial)).toBe(false);
  });
});
