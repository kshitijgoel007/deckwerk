import typeCss from '../renderer/player/type.css?raw';

/**
 * The player's semantic type rules, as text, for whoever needs to build a page
 * that is not the player: the HTML export, and both compilers.
 *
 * Inlined at build time rather than read from disk at run time. `type.css` is a
 * source file, and none of the three places that want it can reach the source
 * tree: the main process is bundled to `out/main/index.js`, the renderer to a
 * hashed asset, and a packaged app ships neither. Resolving a path relative to
 * any of those is a file-not-found waiting to happen — which is exactly what
 * shipped, as `out/renderer/player/type.css` from the export button.
 */
export const PLAYER_TYPE_CSS: string = typeCss;
