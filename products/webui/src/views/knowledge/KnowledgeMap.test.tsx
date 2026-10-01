/**
 * KnowledgeMap, the W8 fix: render the wire's pre-rendered svg instead of a
 * raw JSON dump, and contrast jobRunCount vs nodeCount so "jobs ran, 0 nodes"
 * reads as an honest activity state rather than a blank map.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeMap, isRenderableSvg, svgDataUrl } from './KnowledgeMap';

const SAMPLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>';

function baseProps(overrides: Partial<React.ComponentProps<typeof KnowledgeMap>> = {}) {
  return {
    isPending: false,
    error: null,
    data: {},
    onRetry: () => {},
    hasFilter: false,
    onClearFilter: () => {},
    onViewJobs: () => {},
    jobRunCount: null,
    overallNodeCount: null,
    statusPending: false,
    ...overrides,
  };
}

describe('isRenderableSvg / svgDataUrl', () => {
  test('accepts a well-formed <svg>...</svg> document', () => {
    expect(isRenderableSvg(SAMPLE_SVG)).toBe(true);
  });

  test('rejects an empty string', () => {
    expect(isRenderableSvg('')).toBe(false);
    expect(isRenderableSvg('   ')).toBe(false);
  });

  test('rejects a non-svg / malformed value', () => {
    expect(isRenderableSvg('{"not":"svg"}')).toBe(false);
    expect(isRenderableSvg('<svg>unterminated')).toBe(false);
  });

  test('svgDataUrl produces a data: URL an <img> can consume without executing script', () => {
    const url = svgDataUrl(SAMPLE_SVG);
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    expect(url).toContain(encodeURIComponent('<svg'));
  });
});

describe('KnowledgeMap: the W8 honesty states', () => {

  test('the "766 jobs ran / 0 nodes" gap reads as an honest activity state, not a blank map', () => {
    const html = renderToStaticMarkup(
      <KnowledgeMap {...baseProps({ jobRunCount: 766, overallNodeCount: 0, data: { nodeCount: 0, edgeCount: 0 } })} />,
    );
    expect(html).toContain('766');
  });

  test('populated: renders the svg via an <img> with an honest counts header, not a <pre> dump', () => {
    const html = renderToStaticMarkup(
      <KnowledgeMap {...baseProps({
        jobRunCount: 12,
        overallNodeCount: 5,
        data: { nodeCount: 5, edgeCount: 4, totalNodeCount: 5, totalEdgeCount: 4, svg: SAMPLE_SVG },
      })} />,
    );
    expect(html).toContain('<img');
    expect(html).not.toContain('<pre>');
  });

  test('populated with a subset shown vs. the total surfaces the "of N total" contrast', () => {
    const html = renderToStaticMarkup(
      <KnowledgeMap {...baseProps({
        jobRunCount: 12,
        overallNodeCount: 40,
        data: { nodeCount: 5, edgeCount: 4, totalNodeCount: 40, totalEdgeCount: 30, svg: SAMPLE_SVG },
      })} />,
    );
    expect(html).toContain('40');
    expect(html).toContain('30');
  });

  test('nodeCount > 0 but a missing svg renders no image and no raw dump', () => {
    const html = renderToStaticMarkup(
      <KnowledgeMap {...baseProps({
        jobRunCount: 12,
        overallNodeCount: 5,
        data: { nodeCount: 5, edgeCount: 4 },
      })} />,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<pre>');
  });

  test('a malformed svg string is never rendered as an image', () => {
    const html = renderToStaticMarkup(
      <KnowledgeMap {...baseProps({
        jobRunCount: 12,
        overallNodeCount: 5,
        data: { nodeCount: 5, edgeCount: 4, svg: 'not an svg document' },
      })} />,
    );
    expect(html).not.toContain('<img');
  });
});

describe('KnowledgeMap: "view raw" is demoted, never the primary surface', () => {
  function render(props: Partial<React.ComponentProps<typeof KnowledgeMap>>) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KnowledgeMap {...baseProps(props)} />);
    });
    return {
      el: container,
      unmount: () => {
        flushSync(() => root.unmount());
        container.remove();
      },
    };
  }

  test('the raw JSON is hidden by default and only appears after toggling "View raw"', () => {
    const { el, unmount } = render({
      jobRunCount: 12,
      overallNodeCount: 5,
      data: { nodeCount: 5, edgeCount: 4, svg: SAMPLE_SVG },
    });
    expect(el.textContent).not.toContain('"nodeCount"');
    const toggle = [...el.querySelectorAll('button')].find((b) => b.textContent === 'View raw');
    expect(toggle).toBeTruthy();
    flushSync(() => { toggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).toContain('"nodeCount"');
    unmount();
  });

  test('an svg that passes the well-formedness gate but fails to decode in the browser removes the image (F7c)', () => {
    const { el, unmount } = render({
      jobRunCount: 12,
      overallNodeCount: 5,
      data: { nodeCount: 5, edgeCount: 4, svg: SAMPLE_SVG },
    });
    const img = el.querySelector('.knowledge-map-render__canvas img') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    // The browser could not decode the data: URL, React's onError fires.
    flushSync(() => { img?.dispatchEvent(new window.Event('error')); });
    expect(el.querySelector('.knowledge-map-render__canvas img')).toBeNull();
    unmount();
  });
});
