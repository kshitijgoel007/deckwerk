/**
 * Globally bounded LRU for detached video elements that already hold a frame.
 * Chromium retains decoder state and native frame buffers for detached media,
 * so every rejected or evicted node is explicitly torn down rather than left
 * for JavaScript GC.
 */
export class DecodedVideoPool {
  private entries = new Map<string, HTMLVideoElement[]>();
  private count = 0;

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerKey = 8,
  ) {}

  add(key: string, video: HTMLVideoElement): boolean {
    if (!key || this.maxTotal <= 0) {
      releaseDecodedVideo(video);
      return false;
    }
    const list = this.entries.get(key) ?? [];
    if (list.length >= this.maxPerKey) {
      releaseDecodedVideo(video);
      return false;
    }
    this.entries.delete(key);
    list.push(video);
    this.entries.set(key, list);
    this.count += 1;
    this.trim();
    return true;
  }

  take(key: string): HTMLVideoElement | undefined {
    const list = this.entries.get(key);
    const video = list?.pop();
    if (!video || !list) return undefined;
    this.count -= 1;
    this.entries.delete(key);
    if (list.length > 0) this.entries.set(key, list);
    return video;
  }

  values(): HTMLVideoElement[] {
    return [...this.entries.values()].flat();
  }

  clear(): void {
    for (const video of this.values()) releaseDecodedVideo(video);
    this.entries.clear();
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  private trim(): void {
    while (this.count > this.maxTotal) {
      const oldest = this.entries.entries().next().value as
        | [string, HTMLVideoElement[]]
        | undefined;
      if (!oldest) return;
      const [key, list] = oldest;
      const video = list.shift();
      if (video) {
        this.count -= 1;
        releaseDecodedVideo(video);
      }
      this.entries.delete(key);
      if (list.length > 0) this.entries.set(key, list);
    }
  }
}

export function releaseDecodedVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  const load = video.load as typeof video.load & { _isMockFunction?: boolean };
  // jsdom logs its unimplemented native media methods even when the call is
  // wrapped in try/catch. Test doubles still run so teardown behaviour remains
  // assertable; real browsers always take the production path.
  if (
    typeof navigator === 'undefined'
    || !navigator.userAgent.toLowerCase().includes('jsdom')
    || load._isMockFunction
  ) load.call(video);
}
