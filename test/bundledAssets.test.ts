import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { PLAYER_TYPE_CSS } from '../src/shared/playerTypeCss.js';
import { writeHtmlScope } from '../src/main/htmlAuthoring.js';

/**
 * Source files the app needs at run time must travel *inside* the bundle.
 *
 * The main process is one file, `out/main/index.js`, and `src/` is not next to
 * it — in a packaged app `src/` is not shipped at all. So a path resolved
 * against `import.meta.url` reaching for a source file is a file-not-found that
 * no test running from source can see: from `src/` the file is right there.
 *
 * That is not hypothetical. The export button shipped reading
 * `../renderer/player/type.css`, which from the bundle meant
 * `out/renderer/player/type.css`, and every export failed with ENOENT while
 * every test passed. The type rules are inlined at build time now, and this is
 * what holds that.
 */

describe('assets the app needs at run time', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('carries the player type rules as content, not as a path', () => {
    // An import that silently resolved to nothing would leave exports unthemed
    // rather than failing, which is the quieter version of the same bug.
    expect(PLAYER_TYPE_CSS).toContain('.role-title');
    expect(PLAYER_TYPE_CSS).toContain('font-size: 92px');
    expect(PLAYER_TYPE_CSS.length).toBeGreaterThan(200);
  });

  it('writes an export with those rules in it, from the main process', async () => {
    dir = await mkdtemp(join(tmpdir(), 'bundled-assets-'));
    const deck = emptyDeck('Export');
    const written = await writeHtmlScope(dir, deck, [deck.slides[0].id]);
    expect(await readFile(written.path, 'utf8')).toContain('.role-title');
  });

  it('ships the DeckWerk artwork for packaged and development macOS icons', async () => {
    const resources = join(process.cwd(), 'resources');
    expect(existsSync(join(resources, 'deckwerk-icon.svg'))).toBe(true);
    expect(existsSync(join(resources, 'deckwerk-icon.png'))).toBe(true);
    expect(existsSync(join(resources, 'deckwerk-icon.icns'))).toBe(true);

    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      build: { productName: string; mac: { icon: string } };
    };
    expect(pkg.build.productName).toBe('DeckWerk');
    expect(pkg.build.mac.icon).toBe('resources/deckwerk-icon.icns');
    const main = await readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8');
    expect(main).toContain("app.setName('DeckWerk')");
    expect(main).toContain("app.dock.setIcon(developmentIcon)");
  });

  it('bundles Monaspace Krypton for the editor UI and app icon', async () => {
    const editorCss = await readFile(join(process.cwd(), 'src/renderer/editor/editor.css'), 'utf8');
    expect(editorCss).toContain('@font-face');
    expect(editorCss).toContain('./fonts/Monaspace-Krypton-Var.woff2');
    expect(editorCss).toContain('--mono: "Monaspace Krypton", monospace;');
    expect(existsSync(join(process.cwd(), 'src/renderer/editor/fonts/Monaspace-Krypton-Var.woff2'))).toBe(true);

    const icon = await readFile(join(process.cwd(), 'resources/deckwerk-icon.svg'), 'utf8');
    expect(icon).toContain('font-family="Monaspace Krypton"');
    expect(icon.match(/<rect/g)).toHaveLength(3);
  });
});

/**
 * The same invariant against the real artefact, which is the only place the
 * original bug was visible. Gated on a build existing rather than running one:
 * `npm run build` populates it, and a stale `out/` should not fail the suite.
 */
const MAIN_BUNDLE = join(process.cwd(), 'out', 'main', 'index.js');

describe.skipIf(!existsSync(MAIN_BUNDLE))('the built main process', () => {
  it('has the type rules inside it and no path reaching back into src/', async () => {
    const bundle = await readFile(MAIN_BUNDLE, 'utf8');
    expect(bundle).toContain('.role-heading');
    // `out/renderer/` holds hashed asset chunks, never the source layout, so
    // any surviving reference to this path is the ENOENT coming back.
    expect(bundle).not.toContain('renderer/player/type.css');
  });
});
