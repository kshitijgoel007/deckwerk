import type { OperationProgress } from '@shared/ipc.js';

export interface OperationHandle {
  readonly id: string;
  update(message: string, ratio?: number | null): void;
  /** Yield through a browser paint without ending the operation. */
  waitForPaint(): Promise<void>;
  finish(): void;
}

export interface OperationStatus {
  message: string;
  busy: boolean;
}

type RenderStatus = (status: OperationStatus) => void;
type ScheduleFrame = (callback: () => void) => void;

const scheduleBrowserFrame: ScheduleFrame = (callback) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
  else setTimeout(callback, 0);
};

/**
 * Keeps fast work quiet, then turns the status bar into an activity indicator
 * once an operation has actually lasted long enough to need reassurance.
 */
export class DelayedOperationProgress {
  private sequence = 0;
  private active: {
    id: string;
    message: string;
    ratio: number | null;
    visible: boolean;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly render: RenderStatus,
    private readonly delayMs = 500,
    private readonly scheduleFrame: ScheduleFrame = scheduleBrowserFrame,
  ) {}

  begin(message: string): OperationHandle {
    this.finishActive();
    const id = `operation-${Date.now()}-${++this.sequence}`;
    const active = {
      id,
      message,
      ratio: null,
      visible: false,
      timer: setTimeout(() => {
        if (this.active !== active) return;
        active.visible = true;
        this.renderActive();
      }, this.delayMs),
    };
    this.active = active;
    return {
      id,
      update: (nextMessage, ratio = null) => this.update({ id, message: nextMessage, ratio }),
      waitForPaint: () => this.waitForPaint(id),
      finish: () => this.finish(id),
    };
  }

  /** Accept a detailed phase pushed by the main process. */
  update(progress: OperationProgress): void {
    if (!this.active || this.active.id !== progress.id) return;
    this.active.message = progress.message;
    this.active.ratio = progress.ratio;
    if (this.active.visible) this.renderActive();
  }

  finish(id: string): void {
    if (this.active?.id !== id) return;
    this.finishActive();
  }

  /**
   * Keep the operation alive across two animation frames. A frame callback
   * runs before Chromium paints; the second frame guarantees that the status
   * and the newly-created deck DOM were actually presented in between. This
   * also gives an overdue 500 ms timer a chance to surface after a long,
   * synchronous layout pass blocked the renderer event loop.
   */
  private async waitForPaint(id: string): Promise<void> {
    if (this.active?.id !== id) return;
    await new Promise<void>((resolve) => this.scheduleFrame(resolve));
    if (this.active?.id !== id) return;
    await new Promise<void>((resolve) => this.scheduleFrame(resolve));
  }

  private finishActive(): void {
    if (!this.active) return;
    clearTimeout(this.active.timer);
    const wasVisible = this.active.visible;
    this.active = null;
    if (wasVisible) this.render({ message: '', busy: false });
  }

  private renderActive(): void {
    if (!this.active) return;
    const percent = this.active.ratio === null
      ? ''
      : ` (${Math.round(Math.max(0, Math.min(1, this.active.ratio)) * 100)}%)`;
    this.render({ message: `${this.active.message}${percent}`, busy: true });
  }
}
