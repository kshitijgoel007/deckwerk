# Authoring internals and fallback

Authoring HTML carries an ordered scope marker. That marker is why removing or
reordering sections changes only the slides the file governs. After a successful
sync, DeckWerk stamps assigned slide ids back into the file, making subsequent
saves idempotent.

The editor is authoritative while open. A watched save and explicit `apply`
for the same document are deduplicated. If apply times out, check `context`
before retrying because the editor may still land the change.

`deck.json` is compiled output: do not read or write it for normal authoring.
The JSON transaction command is a last resort for a deck-wide setting that
authoring HTML, themes, notes, comments, and named capability recipes cannot
express. It is not a source of slide-edit commands.

The repository-facing `AGENTS.md` contains test architecture and schema details
for contributors working on DeckWerk itself. A deck agent should not need that
material for ordinary authoring.

