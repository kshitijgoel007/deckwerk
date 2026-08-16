import { loadDeck } from '../src/main/deckStore.js';
import { exportDeck } from '../src/main/exportDeck.js';

/**
 * Headless export for scripts and agents:
 *   npm run export -- <deck-dir> <out-dir>
 * Produces the same standalone bundle as "Export web…" in the app.
 */
const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error('usage: npm run export -- <deck-dir> <out-dir>');
  process.exit(2);
}
const deck = await loadDeck(dir);
await exportDeck(dir, deck, out);
console.log(`exported ${deck.slides.length} slides -> ${out}`);
