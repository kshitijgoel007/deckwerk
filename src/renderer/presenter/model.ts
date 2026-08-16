import type { PresentationState } from '@shared/ipc.js';

export function formatElapsed(now: number, startedAt: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function presentationLabel(state: PresentationState, slideCount: number): string {
  return `Slide ${state.cursor.slide + 1} / ${slideCount} · Build ${state.cursor.step + 1} / ${state.steps}`;
}
