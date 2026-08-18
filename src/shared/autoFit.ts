/**
 * Shrinking text to fit its box — the one thing on a slide that no static
 * stylesheet can express, and therefore the one thing an exported authoring
 * file has to carry as code.
 *
 * It lives here, alone and dependency-free, so that both the player (which
 * calls it) and the HTML exporter (which serialises it into the page with
 * `toString`) run the identical algorithm against the identical DOM. When the
 * exporter had its own version against its own flatter markup, the two settled
 * on different sizes, and a title that fitted on the projector wrapped onto a
 * third line in the browser.
 */
/**
 * Shrink one text element until both its width and height fit its box.
 *
 * The wrapper retains the authored/theme font size. Only `.text-content` gets
 * a fitted override, so shortening the text or enlarging the box can grow it
 * back up to that original ceiling on the next pass.
 */
export function fitAutoTextElement(node: HTMLElement, minimum = 6): number | null {
  const body = node.querySelector<HTMLElement>(':scope > .text-body');
  const content = body?.querySelector<HTMLElement>(':scope > .text-content');
  if (!body || !content || body.clientWidth <= 0 || body.clientHeight <= 0) return null;

  content.style.removeProperty('font-size');
  // A previous condense pass leaves a horizontal squeeze behind; every fit
  // starts from the unscaled layout so toggling modes never compounds.
  content.style.removeProperty('transform');
  content.style.removeProperty('transform-origin');
  delete content.dataset.fittedScaleX;
  const ceiling = Number.parseFloat(getComputedStyle(node).fontSize);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;

  // Condense mode (no-wrap boxes only): keep the authored size and squeeze
  // the type horizontally instead of shrinking it. Width is the only axis a
  // squeeze can fix; vertical overflow stays for the measure pass to report.
  if (node.dataset.fitMode === 'condense') {
    const room = Math.max(0, body.clientWidth - Math.max(1, body.clientWidth * 0.01));
    const width = content.scrollWidth;
    if (width > room && width > 0) {
      const scale = room / width;
      const align = getComputedStyle(body).textAlign;
      content.style.transform = `scaleX(${scale})`;
      content.style.transformOrigin =
        align === 'right' || align === 'end' ? '100% 50%'
          : align === 'center' ? '50% 50%' : '0 50%';
      content.dataset.fittedScaleX = String(Math.round(scale * 1000) / 1000);
    }
    content.dataset.fittedFontSize = String(ceiling);
    return ceiling;
  }

  // Fitting to the exact pixel edge is fragile: line-wrap decisions differ by
  // fractions of a pixel between rendering contexts (stage scale, device pixel
  // ratio, font rasterisation), so a size whose last line fits exactly where it
  // was measured can wrap — and therefore clip — on the projector or in a
  // capture. Measure against a content box narrowed by 1%, then restore the
  // full width: the settled size then sits decisively on the fitting side of
  // every wrap boundary, and text with any slack at all is unaffected.
  const narrowed = Math.max(0, body.clientWidth - Math.max(1, body.clientWidth * 0.01));
  const priorWidth = content.style.getPropertyValue('width');
  const priorPriority = content.style.getPropertyPriority('width');
  content.style.setProperty('width', `${narrowed}px`);
  const restoreWidth = (): void => {
    if (priorWidth) content.style.setProperty('width', priorWidth, priorPriority);
    else content.style.removeProperty('width');
  };
  const fits = (size: number): boolean => {
    content.style.fontSize = `${size}px`;
    return content.scrollWidth <= narrowed + 0.5 &&
      content.scrollHeight <= body.clientHeight + 0.5;
  };

  if (fits(ceiling)) {
    restoreWidth();
    content.dataset.fittedFontSize = String(ceiling);
    return ceiling;
  }

  let low = Math.min(minimum, ceiling);
  let high = ceiling;
  // A sub-pixel binary search is stable and takes far fewer layouts than
  // decrementing one pixel at a time for 100pt imported display type.
  for (let i = 0; i < 10; i++) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  restoreWidth();
  const fitted = Math.round(low * 10) / 10;
  content.style.fontSize = `${fitted}px`;
  content.dataset.fittedFontSize = String(fitted);
  return fitted;
}

