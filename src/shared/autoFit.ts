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
  const ceiling = Number.parseFloat(getComputedStyle(node).fontSize);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;

  const fits = (size: number): boolean => {
    content.style.fontSize = `${size}px`;
    return content.scrollWidth <= body.clientWidth + 0.5 &&
      content.scrollHeight <= body.clientHeight + 0.5;
  };

  if (fits(ceiling)) {
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
  const fitted = Math.round(low * 10) / 10;
  content.style.fontSize = `${fitted}px`;
  content.dataset.fittedFontSize = String(fitted);
  return fitted;
}

