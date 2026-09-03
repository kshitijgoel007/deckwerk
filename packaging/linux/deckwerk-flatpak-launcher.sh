#!/bin/sh
# Chromium's own sandbox cannot run inside the Flatpak sandbox. zypak, provided
# by org.electronjs.Electron2.BaseApp, redirects Chromium's sandbox calls to the
# Flatpak portal instead, which is what lets the app start without
# --no-sandbox (and so without giving up the renderer isolation entirely).
exec zypak-wrapper /app/deckwerk/deckwerk "$@"
