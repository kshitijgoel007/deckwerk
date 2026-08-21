import { describe, expect, it, vi } from 'vitest';
import { DelayedOperationProgress } from '../src/renderer/editor/operationProgress.js';

describe('delayed operation progress', () => {
  it('keeps sub-500 ms work quiet', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const operation = progress.begin('Opening presentation…');

    vi.advanceTimersByTime(499);
    operation.finish();
    vi.runAllTimers();

    expect(render).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('shows the latest phase after 500 ms and clears it on completion', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const operation = progress.begin('Opening presentation…');
    operation.update('Reading example/deck.json', 0.25);

    vi.advanceTimersByTime(500);
    expect(render).toHaveBeenLastCalledWith({
      message: 'Reading example/deck.json (25%)',
      busy: true,
    });

    progress.update({ id: operation.id, message: 'Reading theme.css', ratio: 0.75 });
    expect(render).toHaveBeenLastCalledWith({
      message: 'Reading theme.css (75%)',
      busy: true,
    });

    operation.finish();
    expect(render).toHaveBeenLastCalledWith({ message: '', busy: false });
    vi.useRealTimers();
  });

  it('ignores phase updates from a different operation', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const operation = progress.begin('Exporting…');
    progress.update({ id: 'stale-operation', message: 'Wrong file', ratio: 1 });

    vi.advanceTimersByTime(500);
    expect(render).toHaveBeenLastCalledWith({ message: 'Exporting…', busy: true });
    operation.finish();
    vi.useRealTimers();
  });

  it('keeps the operation active until the browser has painted the loaded view', async () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const frames: Array<() => void> = [];
    const progress = new DelayedOperationProgress(render, 500, (callback) => frames.push(callback));
    const operation = progress.begin('Opening presentation…');

    vi.advanceTimersByTime(500);
    operation.update('Finishing initial display', 0.99);
    const painted = operation.waitForPaint();

    expect(frames).toHaveLength(1);
    frames.shift()?.();
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    expect(render).toHaveBeenLastCalledWith({
      message: 'Finishing initial display (99%)',
      busy: true,
    });

    frames.shift()?.();
    await painted;
    operation.finish();
    expect(render).toHaveBeenLastCalledWith({ message: '', busy: false });
    vi.useRealTimers();
  });
});
