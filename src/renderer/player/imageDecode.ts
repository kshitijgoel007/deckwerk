/**
 * Make image paint atomic across presentation surfaces.
 *
 * Chromium incrementally paints large JPEGs while their scanlines decode. On
 * a slide transition that is visible as a thin strip at the top which grows
 * into the full image. These helpers keep an image hidden until `decode()` has
 * produced the complete bitmap. The promise is shared per node so a lookahead
 * preloader can later be adopted into the live slide without decoding twice.
 */

const decodedImages = new WeakSet<HTMLImageElement>();
const imageDecodes = new WeakMap<HTMLImageElement, Promise<boolean>>();

/** Resolve true once the node holds a fully decoded bitmap. */
export function decodeImage(image: HTMLImageElement): Promise<boolean> {
  const existing = imageDecodes.get(image);
  if (existing) return existing;
  const decoded = typeof image.decode === 'function'
    ? image.decode().then(() => true, () => false)
    : new Promise<boolean>((resolve) => {
      if (image.complete) {
        resolve(image.naturalWidth > 0);
        return;
      }
      image.addEventListener('load', () => resolve(true), { once: true });
      image.addEventListener('error', () => resolve(false), { once: true });
    });
  const tracked = decoded.then((success) => {
    if (success) decodedImages.add(image);
    return success;
  });
  imageDecodes.set(image, tracked);
  return tracked;
}

/** Hide incomplete images and reveal each one only after its full decode. */
export function revealImagesWhenDecoded(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    if (decodedImages.has(image)) continue;
    // A complete-but-broken image has already fired `error`; leave its native
    // broken-image indication visible rather than hiding it forever.
    if (image.complete && image.naturalWidth <= 0) continue;
    image.style.visibility = 'hidden';
    void decodeImage(image).then(() => image.style.removeProperty('visibility'));
  }
}
