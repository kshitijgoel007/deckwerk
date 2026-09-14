/**
 * Deck chooser for the collab client: browses the server's folders, lists the
 * presentations in the one you are looking at, creates new ones, and imports a
 * Keynote or PowerPoint file server-side. Picking a deck navigates to
 * `?deck=<id>` — a full reload is the simplest correct way to re-key every
 * deck-scoped route and socket. A deck id is its folder path, so "acme/pitch"
 * is the deck "pitch" inside the folder "acme".
 *
 * On an access-controlled server (--access) both listings arrive already
 * filtered to what this tailnet user may open, with ownership and role
 * metadata; the picker then groups decks by relationship, marks the ones it
 * can only view, and offers the Share… dialog on decks the user manages. A
 * folder with nothing shared inside it is simply not in the listing.
 */

interface DeckEntry {
  id: string;
  title: string;
  slides: number;
  folder: string;
  owner?: string;
  visibility?: 'public' | 'private';
  canManage?: boolean;
  sharedWithMe?: boolean;
  role?: 'owner' | 'edit' | 'view';
}

interface FolderEntry {
  path: string;
  name: string;
  parent: string;
  decks: number;
  owner?: string;
  canManage?: boolean;
}

export interface PickerAccess {
  user: string;
  name: string;
  admin: boolean;
  deckRole?: 'owner' | 'edit' | 'view' | null;
}

function goTo(deckId: string): void {
  const params = new URLSearchParams(location.search);
  params.set('deck', deckId);
  location.search = params.toString();
}

/** The folder a deck id lives in; '' for the root. */
export function folderOf(deckId: string): string {
  return deckId.includes('/') ? deckId.slice(0, deckId.lastIndexOf('/')) : '';
}

const folderQuery = (folder: string): string =>
  (folder ? `&folder=${encodeURIComponent(folder)}` : '');

export async function createDeckOnServer(folder = ''): Promise<void> {
  const name = (window.prompt('Name for the new presentation?') ?? '').trim();
  if (!name) return;
  const response = await fetch(
    `/api/decks?name=${encodeURIComponent(name)}${folderQuery(folder)}`,
    { method: 'POST' },
  );
  const body = await response.json() as { id?: string; error?: string };
  if (!response.ok || !body.id) throw new Error(body.error ?? 'could not create the deck');
  goTo(body.id);
}

export function importKeynoteToServer(onStatus: (text: string) => void, folder = ''): void {
  importPresentationToServer(onStatus, { accept: '.key', route: '/api/import-keynote', folder });
}

export function importPowerPointToServer(onStatus: (text: string) => void, folder = ''): void {
  importPresentationToServer(onStatus, { accept: '.pptx', route: '/api/import-pptx', folder });
}

function importPresentationToServer(
  onStatus: (text: string) => void,
  source: { accept: string; route: string; folder: string },
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
        `${source.route}?name=${encodeURIComponent(name)}${folderQuery(source.folder)}`,
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
  /** Folder to open the picker in; defaults to the current deck's. */
  folder?: string;
}): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog deck-picker';

  const current = new URLSearchParams(location.search).get('deck');
  let folder = opts.folder ?? (current ? folderOf(current) : '');

  const title = document.createElement('h2');
  title.textContent = 'Presentations on this server';
  const trail = document.createElement('div');
  trail.className = 'deck-picker-trail';
  const list = document.createElement('div');
  list.className = 'deck-picker-list';
  list.textContent = 'Loading…';

  const reopen = (next: string) => {
    overlay.remove();
    showDeckPicker({ ...opts, folder: next });
  };

  const folderRow = (entry: FolderEntry): HTMLElement => {
    const row = document.createElement('button');
    row.className = 'deck-picker-row deck-picker-folder';
    row.textContent = `${entry.name}  ·  ${entry.decks} presentation${entry.decks === 1 ? '' : 's'}`;
    row.addEventListener('click', () => reopen(entry.path));
    if (!entry.canManage && opts.access) return row;
    const wrapper = document.createElement('div');
    wrapper.className = 'deck-picker-row-group';
    const remove = document.createElement('button');
    remove.className = 'deck-picker-share';
    remove.textContent = 'Delete…';
    remove.title = 'Delete this folder (only when it is empty)';
    remove.addEventListener('click', () => {
      if (!window.confirm(`Delete the folder “${entry.name}”?`)) return;
      void (async () => {
        const response = await fetch(`/api/folders?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `delete failed (${response.status})`);
        opts.onStatus(`Deleted the folder “${entry.name}”`);
        reopen(folder);
      })().catch((error) => opts.onStatus(`Delete failed: ${error instanceof Error ? error.message : error}`));
    });
    wrapper.append(row, remove);
    return wrapper;
  };

  const deckRow = (deck: DeckEntry, folders: FolderEntry[]): HTMLElement => {
    const row = document.createElement('button');
    row.className = 'deck-picker-row';
    const parts = [`${deck.title}  ·  ${deck.slides} slide${deck.slides === 1 ? '' : 's'}`];
    if (opts.access && deck.owner && deck.owner !== opts.access.user) parts.push(deck.owner);
    if (deck.role === 'view') parts.push('view only');
    row.textContent = parts.join('  ·  ');
    if (deck.id === current) row.classList.add('active');
    row.addEventListener('click', () => {
      if (deck.id === current) overlay.remove();
      else goTo(deck.id);
    });
    if (!deck.canManage) return row;
    const wrapper = document.createElement('div');
    wrapper.className = 'deck-picker-row-group';
    const move = document.createElement('button');
    move.className = 'deck-picker-share';
    move.textContent = 'Move…';
    move.title = 'Put this presentation in a folder';
    move.addEventListener('click', () => {
      showMoveDialog(deck, folders, opts.onStatus, (movedTo) => reopen(movedTo));
    });
    const share = document.createElement('button');
    share.className = 'deck-picker-share';
    share.textContent = deck.visibility === 'public' ? 'Public · Share…' : 'Private · Share…';
    share.title = 'Change who can open this presentation';
    share.addEventListener('click', () => {
      showShareDialog(deck.id, opts.onStatus, () => reopen(folder));
    });
    wrapper.append(row, move, share);
    return wrapper;
  };

  const renderTrail = (folders: FolderEntry[]) => {
    trail.replaceChildren();
    const segments = folder ? folder.split('/') : [];
    const crumb = (label: string, path: string, last: boolean) => {
      const button = document.createElement('button');
      button.className = 'deck-picker-crumb';
      button.textContent = label;
      button.disabled = last;
      button.addEventListener('click', () => reopen(path));
      trail.append(button);
      if (!last) {
        const sep = document.createElement('span');
        sep.className = 'deck-picker-crumb-sep';
        sep.textContent = '›';
        trail.append(sep);
      }
    };
    crumb('All presentations', '', segments.length === 0);
    segments.forEach((segment, index) => {
      crumb(segment, segments.slice(0, index + 1).join('/'), index === segments.length - 1);
    });
    // A folder that vanished (deleted elsewhere, or never visible) must not
    // leave the picker showing an empty room with no way back.
    if (folder && !folders.some((entry) => entry.path === folder)) {
      const gone = document.createElement('span');
      gone.className = 'deck-picker-crumb-sep';
      gone.textContent = '· no longer available';
      trail.append(gone);
    }
  };

  void (async () => {
    const [decksResponse, foldersResponse] = await Promise.all([
      fetch('/api/decks'),
      fetch('/api/folders'),
    ]);
    if (!decksResponse.ok) throw new Error(`listing failed (${decksResponse.status})`);
    const decks = await decksResponse.json() as DeckEntry[];
    const folders = foldersResponse.ok ? await foldersResponse.json() as FolderEntry[] : [];
    renderTrail(folders);
    list.replaceChildren();
    const here = decks.filter((deck) => deck.folder === folder);
    const children = folders.filter((entry) => entry.parent === folder);
    for (const entry of children) list.appendChild(folderRow(entry));
    if (here.length === 0 && children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'deck-picker-group';
      empty.textContent = folder
        ? 'This folder is empty.'
        : 'No presentations yet — create one or import a Keynote or PowerPoint file.';
      list.appendChild(empty);
      return;
    }
    if (!opts.access) {
      for (const deck of here) list.appendChild(deckRow(deck, folders));
      return;
    }
    const groups = new Map<string, DeckEntry[]>();
    for (const deck of here) {
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
      for (const deck of entries) list.appendChild(deckRow(deck, folders));
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
      void createDeckOnServer(folder).catch((error) =>
        opts.onStatus(`Create failed: ${error instanceof Error ? error.message : error}`));
    }),
    makeButton('New folder…', () => {
      const name = (window.prompt('Name for the new folder?') ?? '').trim();
      if (!name) return;
      const path = folder ? `${folder}/${name}` : name;
      void (async () => {
        const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}`, { method: 'POST' });
        const body = await response.json() as { path?: string; error?: string };
        if (!response.ok || !body.path) throw new Error(body.error ?? 'could not create the folder');
        opts.onStatus(`Created the folder “${name}”`);
        reopen(body.path);
      })().catch((error) => opts.onStatus(`Create failed: ${error instanceof Error ? error.message : error}`));
    }),
    makeButton('Import Keynote…', () => importKeynoteToServer(opts.onStatus, folder)),
    makeButton('Import PowerPoint…', () => importPowerPointToServer(opts.onStatus, folder)),
  );
  if (opts.dismissable) {
    const cancel = makeButton('Cancel', () => overlay.remove());
    actions.append(cancel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.remove();
    });
  }

  box.append(title, trail, list, actions);
  overlay.append(box);
  document.body.append(overlay);
}

/** Move one presentation into another folder (owner or admin only). */
function showMoveDialog(
  deck: DeckEntry,
  folders: FolderEntry[],
  onStatus: (text: string) => void,
  onMoved: (folder: string) => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog';
  const title = document.createElement('h2');
  title.textContent = `Move “${deck.title}”`;
  const label = document.createElement('label');
  label.className = 'share-dialog-visibility';
  label.textContent = 'Folder: ';
  const select = document.createElement('select');
  for (const option of [{ path: '', label: 'All presentations (top level)' },
    ...folders.map((entry) => ({ path: entry.path, label: entry.path }))]) {
    const node = document.createElement('option');
    node.value = option.path;
    node.textContent = option.label;
    node.selected = option.path === deck.folder;
    select.append(node);
  }
  label.append(select);

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => overlay.remove());
  const save = document.createElement('button');
  save.textContent = 'Move';
  save.className = 'primary';
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      const response = await fetch(
        `/api/decks/move?deck=${encodeURIComponent(deck.id)}${folderQuery(select.value)}`,
        { method: 'POST' },
      );
      const body = await response.json() as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? `move failed (${response.status})`);
      onStatus(`Moved “${deck.title}” to ${select.value || 'the top level'}`);
      overlay.remove();
      // The id changed with the folder, so a deck that is open here is now
      // open at a path that no longer exists: send the tab to the new one.
      const current = new URLSearchParams(location.search).get('deck');
      if (current === deck.id) goTo(body.id);
      else onMoved(select.value);
    })().catch((error) => {
      save.disabled = false;
      onStatus(`Move failed: ${error instanceof Error ? error.message : error}`);
    });
  });
  actions.append(cancel, save);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  box.append(title, label, actions);
  overlay.append(box);
  document.body.append(overlay);
}

interface DeckShare {
  login: string;
  role: 'edit' | 'view';
}

interface DeckAccessInfo {
  owner: string;
  visibility: 'public' | 'private';
  publicRole: 'edit' | 'view';
  sharedWith: DeckShare[];
  canManage: boolean;
  role: 'owner' | 'edit' | 'view' | null;
}

const ROLE_LABEL: Record<'edit' | 'view', string> = {
  edit: 'Can edit',
  view: 'Can view',
};

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
      const what = info.role === 'view'
        ? 'You can view it, but not change it.'
        : 'You can edit it.';
      note.textContent = `${info.visibility === 'public'
        ? 'This presentation is public: everyone on this server can open it.'
        : 'This presentation is private; the owner shared it with you.'} ${what}`;
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

    // What "public" hands out. Kept separate from the named shares so a deck
    // can be readable by everyone and editable by a few.
    const publicRoleLabel = document.createElement('label');
    publicRoleLabel.className = 'share-dialog-visibility';
    publicRoleLabel.textContent = 'Everyone else: ';
    const publicRole = document.createElement('select');
    for (const value of ['view', 'edit'] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = ROLE_LABEL[value];
      option.selected = info.publicRole === value;
      publicRole.append(option);
    }
    publicRoleLabel.append(publicRole);

    // People picker: current share list as rows with a role each, plus an
    // input that autocompletes against everyone the server has seen before
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
    const shares: DeckShare[] = info.sharedWith.map((share) => ({ ...share }));

    const addRow = document.createElement('div');
    addRow.className = 'share-dialog-add';
    const entry = document.createElement('input');
    entry.placeholder = knownUsers.length > 0 ? 'Add by name or login…' : 'tailnet login, e.g. alice@example.com';
    entry.setAttribute('list', 'share-known-users');
    const newRole = document.createElement('select');
    for (const value of ['edit', 'view'] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = ROLE_LABEL[value];
      newRole.append(option);
    }
    const datalist = document.createElement('datalist');
    datalist.id = 'share-known-users';
    const syncDatalist = () => {
      datalist.replaceChildren();
      for (const user of knownUsers) {
        if (user.login === info.owner || shares.some((share) => share.login === user.login)) continue;
        const option = document.createElement('option');
        option.value = user.login;
        option.label = user.name;
        datalist.append(option);
      }
    };
    const renderChips = () => {
      chips.replaceChildren();
      if (shares.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'share-dialog-empty';
        empty.textContent = visibility.value === 'public'
          ? 'Nobody in particular — everyone gets what you chose above.'
          : 'Nobody yet — only you can open it.';
        chips.append(empty);
      }
      for (const share of shares) {
        const chip = document.createElement('span');
        chip.className = 'share-dialog-chip';
        const who = document.createElement('span');
        const name = nameOf(share.login);
        who.textContent = `${name ? `${name} · ` : ''}${share.login}`;
        const role = document.createElement('select');
        for (const value of ['edit', 'view'] as const) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = ROLE_LABEL[value];
          option.selected = share.role === value;
          role.append(option);
        }
        role.title = `What ${share.login} can do`;
        role.addEventListener('change', () => {
          share.role = role.value === 'view' ? 'view' : 'edit';
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'share-dialog-chip-remove';
        remove.textContent = '✕';
        remove.title = `Stop sharing with ${share.login}`;
        remove.addEventListener('click', () => {
          shares.splice(shares.indexOf(share), 1);
          renderChips();
        });
        chip.append(who, role, remove);
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
      if (login !== info.owner && !shares.some((share) => share.login === login)) {
        shares.push({ login, role: newRole.value === 'view' ? 'view' : 'edit' });
      }
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
    addRow.append(entry, newRole, add, datalist);
    sharedLabel.append(sharedTitle, chips, addRow);
    renderChips();

    const syncSharedVisibility = () => {
      publicRoleLabel.hidden = visibility.value !== 'public';
      if (shares.length === 0) renderChips(); // the empty line says something different
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
          publicRole: publicRole.value,
          sharedWith: shares.map((share) => ({ ...share })),
        };
        const saved = await fetch(`/api/access?deck=${encodeURIComponent(deckId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(result.error ?? `save failed (${saved.status})`);
        const viewers = payload.sharedWith.filter((share) => share.role === 'view').length;
        onStatus(payload.visibility === 'public'
          ? `“${deckId}” is now public · everyone ${payload.publicRole === 'view' ? 'can view' : 'can edit'}`
          : `“${deckId}” is private · shared with ${payload.sharedWith.length}`
            + `${viewers > 0 ? ` (${viewers} view-only)` : ''}`);
        overlay.remove();
        onSaved?.();
      })().catch((error) => {
        save.disabled = false;
        onStatus(`Sharing failed: ${error instanceof Error ? error.message : error}`);
      });
    });
    body.append(visibilityLabel, publicRoleLabel, sharedLabel, save);
  })().catch((error) => {
    body.textContent = `Could not load sharing: ${error instanceof Error ? error.message : error}`;
  });

  box.append(title, body, actions);
  overlay.append(box);
  document.body.append(overlay);
}
