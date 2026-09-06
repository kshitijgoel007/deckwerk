/**
 * Deck chooser for the collab client: lists every deck the server hosts,
 * creates new ones, and imports a Keynote file server-side. Picking a deck
 * navigates to `?deck=<id>` — a full reload is the simplest correct way to
 * re-key every deck-scoped route and socket.
 *
 * On an access-controlled server (--access) the listing arrives already
 * filtered to what this tailnet user may open, with ownership metadata; the
 * picker then groups decks by relationship and offers the Share… dialog on
 * decks the user manages.
 */

interface DeckEntry {
  id: string;
  title: string;
  slides: number;
  owner?: string;
  visibility?: 'public' | 'private';
  canManage?: boolean;
  sharedWithMe?: boolean;
}

export interface PickerAccess {
  user: string;
  name: string;
  admin: boolean;
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
  importPresentationToServer(onStatus, { accept: '.key', route: '/api/import-keynote' });
}

export function importPowerPointToServer(onStatus: (text: string) => void): void {
  importPresentationToServer(onStatus, { accept: '.pptx', route: '/api/import-pptx' });
}

function importPresentationToServer(
  onStatus: (text: string) => void,
  source: { accept: string; route: string },
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = source.accept;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    onStatus(`Importing ${file.name}… this can take a minute for a large deck.`);
    void (async () => {
      const name = file.name.replace(/\.(key|pptx)$/i, '');
      const response = await fetch(
        `${source.route}?name=${encodeURIComponent(name)}`,
        { method: 'POST', body: file },
      );
      const body = await response.json() as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? 'import failed');
      goTo(body.id);
    })().catch((error) => onStatus(`Import failed: ${error instanceof Error ? error.message : error}`));
  });
  input.click();
}

/** Which picker section a deck belongs in, from this user's point of view. */
function groupOf(deck: DeckEntry, access: PickerAccess): string {
  if (deck.owner === access.user) return 'Your presentations';
  if (deck.sharedWithMe) return 'Shared with you';
  if (deck.visibility === 'public') return 'Public';
  // Only the admin ever sees a private deck that is neither theirs nor shared.
  return 'Other private presentations (admin)';
}

const GROUP_ORDER = ['Your presentations', 'Shared with you', 'Public', 'Other private presentations (admin)'];

/** Modal list of the server's decks, with New and Import at the bottom. */
export function showDeckPicker(opts: {
  dismissable: boolean;
  onStatus: (text: string) => void;
  access?: PickerAccess | null;
}): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog deck-picker';

  const title = document.createElement('h2');
  title.textContent = 'Presentations on this server';
  const list = document.createElement('div');
  list.className = 'deck-picker-list';
  list.textContent = 'Loading…';

  const current = new URLSearchParams(location.search).get('deck');
  const deckRow = (deck: DeckEntry): HTMLElement => {
    const row = document.createElement('button');
    row.className = 'deck-picker-row';
    const label = `${deck.title}  ·  ${deck.slides} slide${deck.slides === 1 ? '' : 's'}`;
    row.textContent = opts.access && deck.owner && deck.owner !== opts.access.user
      ? `${label}  ·  ${deck.owner}`
      : label;
    if (deck.id === current) row.classList.add('active');
    row.addEventListener('click', () => {
      if (deck.id === current) overlay.remove();
      else goTo(deck.id);
    });
    if (!deck.canManage) return row;
    const wrapper = document.createElement('div');
    wrapper.className = 'deck-picker-row-group';
    const share = document.createElement('button');
    share.className = 'deck-picker-share';
    share.textContent = deck.visibility === 'public' ? 'Public · Share…' : 'Private · Share…';
    share.title = 'Change who can open this presentation';
    share.addEventListener('click', () => {
      showShareDialog(deck.id, opts.onStatus, () => {
        overlay.remove();
        showDeckPicker(opts);
      });
    });
    wrapper.append(row, share);
    return wrapper;
  };

  void (async () => {
    const response = await fetch('/api/decks');
    if (!response.ok) throw new Error(`listing failed (${response.status})`);
    const decks = await response.json() as DeckEntry[];
    list.replaceChildren();
    if (decks.length === 0) {
      list.textContent = 'No presentations yet — create one or import a Keynote or PowerPoint file.';
      return;
    }
    if (!opts.access) {
      for (const deck of decks) list.appendChild(deckRow(deck));
      return;
    }
    const groups = new Map<string, DeckEntry[]>();
    for (const deck of decks) {
      const group = groupOf(deck, opts.access);
      groups.set(group, [...(groups.get(group) ?? []), deck]);
    }
    for (const group of GROUP_ORDER) {
      const entries = groups.get(group);
      if (!entries || entries.length === 0) continue;
      const heading = document.createElement('div');
      heading.className = 'deck-picker-group';
      heading.textContent = group;
      list.appendChild(heading);
      for (const deck of entries) list.appendChild(deckRow(deck));
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
    makeButton('Import PowerPoint…', () => importPowerPointToServer(opts.onStatus)),
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

interface DeckAccessInfo {
  owner: string;
  visibility: 'public' | 'private';
  sharedWith: string[];
  canManage: boolean;
}

/**
 * Visibility + share list for one deck, backed by GET/PUT /api/access.
 * Read-only for participants who can open the deck but don't manage it.
 */
export function showShareDialog(deckId: string, onStatus: (text: string) => void, onSaved?: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog share-dialog';

  const title = document.createElement('h2');
  title.textContent = `Share “${deckId}”`;
  const body = document.createElement('div');
  body.className = 'share-dialog-body';
  body.textContent = 'Loading…';

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.addEventListener('click', () => overlay.remove());
  actions.append(close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });

  void (async () => {
    const response = await fetch(`/api/access?deck=${encodeURIComponent(deckId)}`);
    const info = await response.json() as DeckAccessInfo & { error?: string };
    if (!response.ok) throw new Error(info.error ?? `access lookup failed (${response.status})`);
    body.replaceChildren();

    const ownerLine = document.createElement('p');
    ownerLine.className = 'share-dialog-owner';
    ownerLine.textContent = `Owner: ${info.owner}`;
    body.append(ownerLine);

    if (!info.canManage) {
      const note = document.createElement('p');
      note.textContent = info.visibility === 'public'
        ? 'This presentation is public: everyone on this server can open it.'
        : 'This presentation is private; the owner shared it with you.';
      body.append(note);
      return;
    }

    const visibilityLabel = document.createElement('label');
    visibilityLabel.className = 'share-dialog-visibility';
    visibilityLabel.textContent = 'Who can open it: ';
    const visibility = document.createElement('select');
    for (const [value, label] of [
      ['private', 'Private — only you and people you list'],
      ['public', 'Public — everyone on this server'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = info.visibility === value;
      visibility.append(option);
    }
    visibilityLabel.append(visibility);

    // People picker: current share list as removable chips, plus an input
    // that autocompletes against everyone the server has seen before
    // (GET /api/users). Free-typed logins still work — the directory is a
    // convenience, not a gate on who can be shared with.
    const knownUsers = await (async () => {
      try {
        const usersResponse = await fetch('/api/users');
        if (!usersResponse.ok) return [];
        return await usersResponse.json() as Array<{ login: string; name: string }>;
      } catch {
        return [];
      }
    })();
    const nameOf = (login: string) => knownUsers.find((user) => user.login === login)?.name;

    const sharedLabel = document.createElement('div');
    sharedLabel.className = 'share-dialog-shared';
    const sharedTitle = document.createElement('span');
    sharedTitle.textContent = 'Shared with:';
    const chips = document.createElement('div');
    chips.className = 'share-dialog-chips';
    const sharedLogins: string[] = [...info.sharedWith];

    const addRow = document.createElement('div');
    addRow.className = 'share-dialog-add';
    const entry = document.createElement('input');
    entry.placeholder = knownUsers.length > 0 ? 'Add by name or login…' : 'tailnet login, e.g. alice@example.com';
    entry.setAttribute('list', 'share-known-users');
    const datalist = document.createElement('datalist');
    datalist.id = 'share-known-users';
    const syncDatalist = () => {
      datalist.replaceChildren();
      for (const user of knownUsers) {
        if (user.login === info.owner || sharedLogins.includes(user.login)) continue;
        const option = document.createElement('option');
        option.value = user.login;
        option.label = user.name;
        datalist.append(option);
      }
    };
    const renderChips = () => {
      chips.replaceChildren();
      if (sharedLogins.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'share-dialog-empty';
        empty.textContent = 'Nobody yet — only you can open it.';
        chips.append(empty);
      }
      for (const login of sharedLogins) {
        const chip = document.createElement('button');
        chip.className = 'share-dialog-chip';
        chip.type = 'button';
        const name = nameOf(login);
        chip.textContent = `${name ? `${name} · ` : ''}${login} ✕`;
        chip.title = `Stop sharing with ${login}`;
        chip.addEventListener('click', () => {
          sharedLogins.splice(sharedLogins.indexOf(login), 1);
          renderChips();
          syncDatalist();
        });
        chips.append(chip);
      }
      syncDatalist();
    };
    const addEntry = () => {
      const typed = entry.value.trim().toLowerCase();
      if (!typed) return;
      // Accept a display name typed in full as well as a login.
      const match = knownUsers.find((user) => user.login === typed || user.name.toLowerCase() === typed);
      const login = match?.login ?? typed;
      if (login !== info.owner && !sharedLogins.includes(login)) sharedLogins.push(login);
      entry.value = '';
      renderChips();
    };
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add';
    add.addEventListener('click', addEntry);
    entry.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addEntry();
      }
    });
    // Picking a datalist suggestion fires `change`; add it right away.
    entry.addEventListener('change', () => {
      if (knownUsers.some((user) => user.login === entry.value.trim().toLowerCase())) addEntry();
    });
    addRow.append(entry, add, datalist);
    sharedLabel.append(sharedTitle, chips, addRow);
    renderChips();

    const syncSharedVisibility = () => {
      sharedLabel.hidden = visibility.value === 'public';
    };
    visibility.addEventListener('change', syncSharedVisibility);
    syncSharedVisibility();

    const save = document.createElement('button');
    save.textContent = 'Save';
    save.className = 'primary';
    save.addEventListener('click', () => {
      void (async () => {
        save.disabled = true;
        const payload = {
          visibility: visibility.value,
          sharedWith: [...sharedLogins],
        };
        const saved = await fetch(`/api/access?deck=${encodeURIComponent(deckId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(result.error ?? `save failed (${saved.status})`);
        onStatus(payload.visibility === 'public'
          ? `“${deckId}” is now public`
          : `“${deckId}” is private · shared with ${payload.sharedWith.length}`);
        overlay.remove();
        onSaved?.();
      })().catch((error) => {
        save.disabled = false;
        onStatus(`Sharing failed: ${error instanceof Error ? error.message : error}`);
      });
    });
    body.append(visibilityLabel, sharedLabel, save);
  })().catch((error) => {
    body.textContent = `Could not load sharing: ${error instanceof Error ? error.message : error}`;
  });

  box.append(title, body, actions);
  overlay.append(box);
  document.body.append(overlay);
}
