import '../player/player.css';
import './print.css';
import { resolveState } from '@shared/timeline.js';
import { pdfSteps } from '@shared/pdfExport.js';
import { renderSlide } from '../player/render.js';
import { applyStaticSlideState } from '../player/staticState.js';
import { waitForPdfDocument } from './readiness.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'initial' || params.get('mode') === 'every'
  ? params.get('mode') as 'initial' | 'every'
  : 'final';
const includeHidden = params.get('includeHidden') === '1';
const slideFilter = params.get('slide');
const jobId = params.get('job') ?? '';

void (async () => {
  const session = await window.api.getDeck();
  if (!session) throw new Error('No deck is open');
  const theme = document.createElement('style');
  theme.textContent = await window.api.loadTheme();
  document.head.appendChild(theme);

  const { deck } = session;
  // Print at the deck's native CSS-pixel canvas. Scaling a 1920×1080 stage
  // into an inch-sized page made Chromium apply the display scale twice on
  // Retina systems, leaving the slide in only the top half of the PDF page.
  // CSS-pixel page dimensions keep the print and Player coordinate systems
  // identical while Chromium still retains vector text and shapes.
  const pageWidthPx = deck.canvas.w;
  const pageHeightPx = deck.canvas.h;
  const pageRule = document.createElement('style');
  pageRule.textContent = `@page { size: ${pageWidthPx}px ${pageHeightPx}px; margin: 0; }`;
  document.head.appendChild(pageRule);

  const pages = document.getElementById('pages')!;
  const renderedPages: Array<{
    page: HTMLElement;
    slide: (typeof deck.slides)[number];
    state: ReturnType<typeof resolveState>;
  }> = [];
  for (const slide of deck.slides) {
    if (slide.skipped && !includeHidden) continue;
    if (slideFilter && slide.id !== slideFilter) continue;
    const states = pdfSteps(slide, mode);
    for (const step of states) {
      const page = document.createElement('section');
      page.className = 'pdf-page';
      page.style.width = `${pageWidthPx}px`;
      page.style.height = `${pageHeightPx}px`;
      const stage = document.createElement('div');
      stage.className = 'pdf-stage';
      stage.style.width = `${deck.canvas.w}px`;
      stage.style.height = `${deck.canvas.h}px`;
      stage.appendChild(renderSlide(slide, { resolveSrc: window.api.assetUrl }));
      const resolved = resolveState(slide, step);
      applyStaticSlideState(stage, slide, resolved);
      page.appendChild(stage);
      pages.appendChild(page);
      renderedPages.push({ page, slide, state: resolved });
    }
  }
  await waitForPdfDocument(renderedPages);
  document.documentElement.dataset.ready = 'true';
  window.api.pdfReady(jobId);
})().catch((error) => {
  document.documentElement.dataset.error = String(error instanceof Error ? error.message : error);
  window.api.pdfReady(jobId);
});
