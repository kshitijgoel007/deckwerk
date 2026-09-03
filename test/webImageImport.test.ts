import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importImageSource } from '../src/main/clipboardImageFetch.js';
import { createDeck } from '../src/main/deckStore.js';

/**
 * Fetching the bytes for an image that a drag or a paste only pointed at.
 *
 * This is the host half of "drag an image out of a browser onto a slide":
 * there is no file on the pasteboard, so the deck's owner has to go and get
 * the picture. What matters here is that the fetched bytes land in the deck
 * exactly like a dropped file — probed, content-addressed, and named by the
 * type the *server* served, not by whatever the URL's path claims.
 */

let root = '';
let png = Buffer.alloc(0);

/** A response with just the parts `downloadImage` reads. */
function served(bytes: Buffer, contentType: string, status = 200): Response {
  return new Response(status === 200 ? new Uint8Array(bytes) : null, {
    status,
    headers: { 'content-type': contentType },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'web-image-import-'));
  png = await readFile(join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png'));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('importing an image behind a URL', () => {
  it('downloads a remote image into the deck, probed and content-addressed', async () => {
    const deckDir = join(root, 'remote');
    await createDeck(deckDir);
    const asked: string[] = [];
    const asset = await importImageSource(
      deckDir,
      { kind: 'url', url: 'https://x.test/photos/bird.png?utm_source=wiki' },
      {
        fetchImpl: async (input) => {
          asked.push(String(input));
          return served(png, 'image/png');
        },
      },
    );
    expect(asked).toEqual(['https://x.test/photos/bird.png?utm_source=wiki']);
    expect(asset?.src).toMatch(/^assets\/.+\.png$/);
    // Probed like any drop: the element is sized from these.
    expect(asset?.width).toBeGreaterThan(0);
    expect(asset?.height).toBeGreaterThan(0);
  });

  it('stores an inline data: image without going near the network', async () => {
    const deckDir = join(root, 'inline');
    await createDeck(deckDir);
    const asset = await importImageSource(
      deckDir,
      { kind: 'data', mime: 'image/png', base64: png.toString('base64') },
      { fetchImpl: async () => { throw new Error('must not fetch a data: URL'); } },
    );
    expect(asset?.src).toMatch(/^assets\/.+\.png$/);
  });

  it('leaves the deck alone when the bytes cannot be had', async () => {
    const deckDir = join(root, 'failures');
    await createDeck(deckDir);
    const cases: Array<[string, () => Promise<Response>]> = [
      ['a dead link', async () => served(png, 'image/png', 404)],
      // A page, not a picture: importing it would leave a broken element.
      ['an HTML page', async () => served(png, 'text/html')],
      ['a network failure', async () => { throw new Error('offline'); }],
    ];
    for (const [why, fetchImpl] of cases) {
      const asset = await importImageSource(
        deckDir,
        { kind: 'url', url: 'https://x.test/thing' },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      expect(asset, why).toBeNull();
    }
  });

  it('refuses a URL scheme that must never be dereferenced', async () => {
    const deckDir = join(root, 'schemes');
    await createDeck(deckDir);
    const asset = await importImageSource(deckDir, { kind: 'url', url: 'file:///etc/passwd' });
    expect(asset).toBeNull();
  });

  it('can be told to refuse addresses that are not on the public internet', async () => {
    const deckDir = join(root, 'private');
    await createDeck(deckDir);
    // The collab server fetches on behalf of whichever client is connected,
    // so its fetcher must not be aimable at the server's own network.
    const asset = await importImageSource(
      deckDir,
      { kind: 'url', url: 'http://127.0.0.1:9/secret.png' },
      { blockPrivateAddresses: true, fetchImpl: async () => served(png, 'image/png') },
    );
    expect(asset).toBeNull();
  });
});

describe('redirects and served types', () => {
  it('follows a redirect to the picture', async () => {
    const deckDir = join(root, 'redirect');
    await createDeck(deckDir);
    const asked: string[] = [];
    const asset = await importImageSource(
      deckDir,
      { kind: 'url', url: 'https://x.test/short' },
      {
        fetchImpl: async (input) => {
          asked.push(String(input));
          return asked.length === 1
            ? new Response(null, { status: 302, headers: { location: '/cdn/bird.png' } })
            : served(png, 'image/png');
        },
      },
    );
    expect(asked).toEqual(['https://x.test/short', 'https://x.test/cdn/bird.png']);
    expect(asset?.src).toMatch(/\.png$/);
  });

  it('holds every redirect hop to the address rules, not only the first URL', async () => {
    // A public URL that bounces to the local network is the classic way round
    // an SSRF guard that only inspects the address it was handed.
    const deckDir = join(root, 'redirect-private');
    await createDeck(deckDir);
    const asked: string[] = [];
    const asset = await importImageSource(
      deckDir,
      // An IP literal, so the guard needs no DNS to pass the first hop.
      { kind: 'url', url: 'https://93.184.216.34/short' },
      {
        blockPrivateAddresses: true,
        fetchImpl: async (input) => {
          asked.push(String(input));
          return asked.length === 1
            ? new Response(null, {
              status: 302, headers: { location: 'http://169.254.169.254/latest/meta.png' },
            })
            : served(png, 'image/png');
        },
      },
    );
    expect(asset).toBeNull();
    // The private address was refused before any request went to it.
    expect(asked).toEqual(['https://93.184.216.34/short']);
  });

  it('gives up on a redirect loop', async () => {
    const deckDir = join(root, 'redirect-loop');
    await createDeck(deckDir);
    let hops = 0;
    const asset = await importImageSource(
      deckDir,
      { kind: 'url', url: 'https://x.test/a' },
      {
        fetchImpl: async () => {
          hops += 1;
          return new Response(null, { status: 301, headers: { location: 'https://x.test/a' } });
        },
      },
    );
    expect(asset).toBeNull();
    expect(hops).toBeLessThanOrEqual(6);
  });

  it('does not let an image-looking path override a served page type', async () => {
    // A login wall or a 200 error page at `.../photo.png` is still a page:
    // storing it as photo.png would leave a broken element in the deck.
    const deckDir = join(root, 'served-type');
    await createDeck(deckDir);
    const page = await importImageSource(
      deckDir,
      { kind: 'url', url: 'https://x.test/photo.png' },
      { fetchImpl: async () => served(png, 'text/html; charset=utf-8') },
    );
    expect(page).toBeNull();

    // A server that declares nothing useful leaves the decision to the path.
    for (const contentType of ['', 'application/octet-stream']) {
      const asset = await importImageSource(
        deckDir,
        { kind: 'url', url: 'https://x.test/photo.png' },
        { fetchImpl: async () => served(png, contentType) },
      );
      expect(asset?.src, contentType || '(no content-type)').toMatch(/\.png$/);
    }
  });
});
