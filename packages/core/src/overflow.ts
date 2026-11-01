import type { Page } from 'playwright';
import {
  CANDIDATE_LIMIT,
  OVERFLOW_TOLERANCE_PX,
  type DocumentMetrics,
  type IssueEvidence,
} from './scan-schema.js';

export interface OverflowInspection {
  document: DocumentMetrics;
  candidates: IssueEvidence[];
  candidatesTruncated: boolean;
}

/** Browser geometry evidence only: candidates are not proven CSS root causes. */
export async function inspectOverflow(page: Page): Promise<OverflowInspection> {
  return page.evaluate(({ tolerance, limit }) => {
    const root = document.documentElement;
    const scrollingElement = document.scrollingElement ?? root;
    const clientWidth = scrollingElement.clientWidth;
    // Body can be an intentional, independently contained scroll region. The
    // document's scrolling element is authoritative, not max(body.scrollWidth).
    const scrollWidth = scrollingElement.scrollWidth;
    const overflowPx = Math.max(0, scrollWidth - clientWidth);
    const groups: Element[] = [];
    const candidates: IssueEvidence[] = [];

    // Structural selectors avoid collecting page text, IDs, or attribute values.
    function describe(element: Element): string {
      const segments: string[] = [];
      let node: Element | null = element;
      while (node) {
        const tag = node.localName;
        let index = 1;
        let previous = node.previousElementSibling;
        while (previous) {
          if (previous.localName === tag) index++;
          previous = previous.previousElementSibling;
        }
        segments.unshift(`${tag}:nth-of-type(${index})`);
        node = node.parentElement;
      }
      const selector = segments.join(' > ');
      return selector.length <= 1000 ? selector : `DOM branch ending in ${selector.slice(-970)}`;
    }

    function visibleBounds(element: Element, rect: DOMRect): { left: number; right: number } | null {
      let left = rect.left;
      let right = rect.right;
      let top = rect.top;
      let bottom = rect.bottom;
      // Viewport-fixed boxes escape ordinary ancestor overflow clipping. A
      // transform/filter/contain ancestor can establish a different fixed CB.
      let fixedRoot: Element | null = null;
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (getComputedStyle(node).position === 'fixed') { fixedRoot = node; break; }
      }
      let fixedContainingBlock: Element | null = null;
      for (let node = fixedRoot?.parentElement ?? null; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none'
          || (style.backdropFilter && style.backdropFilter !== 'none')
          || /\b(layout|paint|strict|content)\b/.test(style.contain)
          || /\b(transform|perspective|filter)\b/.test(style.willChange)
          || style.contentVisibility === 'auto') {
          fixedContainingBlock = node; break;
        }
      }
      let ancestor: Element | null = element;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || (ancestor === element && ['hidden', 'collapse'].includes(style.visibility))
          || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return null;
        const aboveFixedRoot = fixedRoot && ancestor !== fixedRoot && ancestor.contains(fixedRoot);
        const outsideFixedContainingBlock = fixedContainingBlock
          && (ancestor === fixedContainingBlock || ancestor.contains(fixedContainingBlock));
        if (ancestor !== element && ancestor !== root && (!aboveFixedRoot || outsideFixedContainingBlock)) {
          const bounds = ancestor.getBoundingClientRect();
          const html = ancestor instanceof HTMLElement ? ancestor : null;
          const scaleX = html?.offsetWidth ? bounds.width / html.offsetWidth : 1;
          const scaleY = html?.offsetHeight ? bounds.height / html.offsetHeight : 1;
          const clipLeft = bounds.left + ancestor.clientLeft * scaleX;
          const clipTop = bounds.top + ancestor.clientTop * scaleY;
          if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) {
            left = Math.max(left, clipLeft);
            right = Math.min(right, clipLeft + ancestor.clientWidth * scaleX);
          }
          if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
            top = Math.max(top, clipTop);
            bottom = Math.min(bottom, clipTop + ancestor.clientHeight * scaleY);
          }
        }
        ancestor = ancestor.parentElement;
      }
      return right > left && bottom > top ? { left, right } : null;
    }

    // DOM order selects the outermost visible overflowing box in each branch.
    // Its descendants remain evidence of the same branch, not independent bugs.
    for (const element of document.querySelectorAll('*')) {
      if (element === root || element === document.body) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const visible = visibleBounds(element, rect);
      if (!visible) continue;
      const elementOverflow = Math.max(0, -visible.left, visible.right - clientWidth);
      if (elementOverflow <= tolerance || groups.some((group) => group.contains(element))) continue;
      groups.push(element);
      if (candidates.length >= limit) continue;
      const style = getComputedStyle(element);
      candidates.push({
        kind: 'candidate-contributor',
        selector: describe(element),
        tagName: element.localName,
        rect: {
          x: rect.x, y: rect.y, top: rect.top, right: rect.right,
          bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height,
        },
        styles: {
          display: style.display, position: style.position, boxSizing: style.boxSizing,
          width: style.width, minWidth: style.minWidth, maxWidth: style.maxWidth,
          overflowX: style.overflowX, overflowY: style.overflowY,
          whiteSpace: style.whiteSpace, flexWrap: style.flexWrap,
          transform: style.transform, marginLeft: style.marginLeft, marginRight: style.marginRight,
        },
        viewportWidth: clientWidth,
        documentWidth: scrollWidth,
        overflowPx: elementOverflow,
      });
    }
    return {
      document: { clientWidth, scrollWidth, overflowPx, hasOverflow: overflowPx > tolerance },
      candidates,
      candidatesTruncated: groups.length > limit,
    };
  }, { tolerance: OVERFLOW_TOLERANCE_PX, limit: CANDIDATE_LIMIT });
}
