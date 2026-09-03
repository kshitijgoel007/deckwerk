/**
 * User-facing feature names.
 *
 * The morph transition has been renamed once already — it shipped as "Magic
 * Move" until 2026-09 — so nothing the user can read spells the name out:
 * every label, tooltip, hint and undo entry interpolates `MORPH_NAME`.
 * Renaming the feature for the user is then a one-line edit here.
 *
 * The matching *field* names (`morphId`, `morphFromPrevious`, `morphDuration`,
 * `morphEasing`) are wire format rather than prose, so they stay spelled out
 * in code. Renaming one of those means adding a row to `RETIRED_FIELD_NAMES`
 * in `./fieldAliases.ts`, which keeps decks, HTML sources and agent requests
 * written against the old name loading.
 */
export const MORPH_NAME = 'Morph';
