/**
 * Deck chooser for the collab client: lists every deck the server hosts,
 * creates new ones, and imports a Keynote file server-side. Picking a deck
 * navigates to `?deck=<id>` — a full reload is the simplest correct way to
 * re-key every deck-scoped route and socket.
 */

interface DeckEntry {
  id: string;
  title: string;
  slides: number;
}

function goTo(deckId: string): void {
  const params = new URLSearchParams(location.search);
  params.set('deck', deckId);
  location.search = params.toString();
}

export async function createDeckOnServer(): Promise<void> {
  const name = (window.prompt('Name for the new presentation?') ?? '').trim();
  if (!name) return;
  const response = await fetch(`/api/decks?name=${encodeURIComponent(name)}`, { method: 'POST' });
  const body = await response.json() as { id?: string; error?: string };
  if (!response.ok || !body.id) throw new Error(body.error ?? 'could not create the deck');
  goTo(body.id);
}

export function importKeynoteToServer(onStatus: (text: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.key';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    onStatus(`Importing ${file.name}… this can take a minute for a large deck.`);
    void (async () => {
      const name = file.name.replace(/\.key$/i, '');
      const response = await fetch(
        `/api/import-keynote?name=${encodeURIComponent(name)}`,
        { method: 'POST', body: file },
      );
      const body = await response.json() as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? 'import failed');
      goTo(body.id);
    })().catch((error) => onStatus(`Import failed: ${error instanceof Error ? error.message : error}`));
  });
  input.click();
}

/** Modal list of the server's decks, with New and Import at the bottom. */
export function showDeckPicker(opts: { dismissable: boolean; onStatus: (text: string) => void }): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog deck-picker';

  const title = document.createElement('h2');
  title.textContent = 'Presentations on this server';
  const list = document.createElement('div');
  list.className = 'deck-picker-list';
  list.textContent = 'Loading…';

  void (async () => {
    const decks = await (await fetch('/api/decks')).json() as DeckEntry[];
    list.replaceChildren();
    if (decks.length === 0) {
      list.textContent = 'No presentations yet — create one or import a Keynote file.';
      return;
    }
    const current = new URLSearchParams(location.search).get('deck');
    for (const deck of decks) {
      const row = document.createElement('button');
      row.className = 'deck-picker-row';
      row.textContent = `${deck.title}  ·  ${deck.slides} slide${deck.slides === 1 ? '' : 's'}`;
      if (deck.id === current) row.classList.add('active');
      row.addEventListener('click', () => {
        if (deck.id === current) overlay.remove();
        else goTo(deck.id);
      });
      list.appendChild(row);
    }
  })().catch(() => {
    list.textContent = 'Could not reach the server.';
  });

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const makeButton = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  actions.append(
    makeButton('New presentation…', () => {
      void createDeckOnServer().catch((error) =>
        opts.onStatus(`Create failed: ${error instanceof Error ? error.message : error}`));
    }),
    makeButton('Import Keynote…', () => importKeynoteToServer(opts.onStatus)),
  );
  if (opts.dismissable) {
    const cancel = makeButton('Cancel', () => overlay.remove());
    actions.append(cancel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.remove();
    });
  }

  box.append(title, list, actions);
  overlay.append(box);
  document.body.append(overlay);
}
