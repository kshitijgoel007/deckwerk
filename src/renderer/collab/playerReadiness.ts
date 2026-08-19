export interface PlayerPaintReadinessOptions {
  root: HTMLElement;
  fontsReady: Promise<unknown>;
  requestFrame: (callback: FrameRequestCallback) => number;
  currentSlide: () => number | null;
  onPainted: (slide: number) => void;
}

/**
 * Readiness is separate from page load because the collaboration player gets
 * its deck asynchronously over WebSocket. Two animation frames after fonts
 * settle are enough for layout and a browser paint; a generation counter keeps
 * an older render from declaring a newer revision ready.
 */
export class PlayerPaintReadiness {
  private generation = 0;

  constructor(private readonly options: PlayerPaintReadinessOptions) {}

  connecting(): void {
    this.generation += 1;
    this.options.root.dataset.playerStatus = 'connecting';
    delete this.options.root.dataset.playerReady;
    delete this.options.root.dataset.playerSlide;
  }

  painting(): void {
    const generation = ++this.generation;
    this.options.root.dataset.playerStatus = 'painting';
    delete this.options.root.dataset.playerReady;
    void this.options.fontsReady.then(() => {
      this.options.requestFrame(() => this.options.requestFrame(() => {
        const slide = this.options.currentSlide();
        if (generation !== this.generation || slide === null) return;
        this.options.root.dataset.playerStatus = 'ready';
        this.options.root.dataset.playerReady = 'true';
        this.options.root.dataset.playerSlide = String(slide);
        this.options.onPainted(slide);
      }));
    });
  }
}
