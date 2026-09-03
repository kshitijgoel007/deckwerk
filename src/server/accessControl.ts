/**
 * Opt-in access control for the collab server (`--access <adminLogin>`).
 *
 * Identity comes from Tailscale, not from accounts: the server binds loopback
 * and sits behind `tailscale serve`, which terminates TLS on the tailnet and
 * stamps every proxied request with `Tailscale-User-Login` /
 * `Tailscale-User-Name` headers. Those headers are trusted ONLY when the
 * socket peer is loopback — off-loopback they could be forged by whoever set
 * them, so such connections are rejected outright. A bare loopback request
 * without the headers is someone at the machine itself (SSH, curl, the
 * launchd owner) and counts as the admin.
 *
 * Per-deck permissions live in an `access.json` sidecar next to `deck.json`.
 * It is deliberately not part of the deck document: deck.json rides the
 * collab diff/sync path, and a permissions file must never be editable
 * through a deck transaction. A deck without the sidecar is public and
 * admin-owned, so enabling the flag on an existing decks directory changes
 * nothing until somebody shares or restricts a deck.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

export interface AccessControlConfig {
  /** Tailnet login of the administrator; sees and manages every deck. */
  admin: string;
}

export interface Identity {
  /** Stable tailnet login (e.g. "alice@github") — the authorization subject. */
  login: string;
  /** Human display name for presence and comments. */
  name: string;
}

export interface DeckAccess {
  owner: string;
  visibility: 'public' | 'private';
  sharedWith: string[];
}

export const ACCESS_FILE = 'access.json';

export function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

function isLoopback(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function headerValue(request: IncomingMessage, name: string): string {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? '').trim();
}

/**
 * Resolve who is making this request, or null if nobody trustworthy is.
 * Null means "reject": with access control on, every byte the server emits
 * is tied to a tailnet identity.
 */
export function resolveIdentity(
  request: IncomingMessage,
  config: AccessControlConfig,
): Identity | null {
  if (!isLoopback(request)) return null;
  const login = headerValue(request, 'tailscale-user-login');
  if (login) {
    return {
      login: normalizeLogin(login),
      name: headerValue(request, 'tailscale-user-name') || login,
    };
  }
  // Serve stamps every request it proxies with X-Forwarded-For, but only
  // requests from a tailnet *user* get the identity headers: traffic from a
  // tagged node, or from the public internet via `tailscale funnel`, arrives
  // on loopback with the forwarding headers and no login. That is an
  // anonymous stranger, not the machine owner — refuse rather than promote.
  if (headerValue(request, 'x-forwarded-for')) return null;
  // Loopback without any proxy headers: a shell on the server machine itself.
  return { login: normalizeLogin(config.admin), name: config.admin };
}

/** Read a deck's sidecar; a missing or unreadable file is public/admin-owned. */
export async function readDeckAccess(deckDir: string, config: AccessControlConfig): Promise<DeckAccess> {
  const fallback: DeckAccess = {
    owner: normalizeLogin(config.admin),
    visibility: 'public',
    sharedWith: [],
  };
  let raw: string;
  try {
    raw = await readFile(join(deckDir, ACCESS_FILE), 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeckAccess>;
    return {
      owner: typeof parsed.owner === 'string' && parsed.owner.trim()
        ? normalizeLogin(parsed.owner)
        : fallback.owner,
      visibility: parsed.visibility === 'private' ? 'private' : 'public',
      sharedWith: Array.isArray(parsed.sharedWith)
        ? [...new Set(parsed.sharedWith
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
            .map(normalizeLogin))]
        : [],
    };
  } catch {
    // A corrupt sidecar must not lock the admin out of the deck; treating it
    // as absent (public) is the recoverable failure mode.
    return fallback;
  }
}

export async function writeDeckAccess(deckDir: string, access: DeckAccess): Promise<void> {
  await writeFile(join(deckDir, ACCESS_FILE), `${JSON.stringify(access, null, 2)}\n`, 'utf8');
}

export function canAccessDeck(login: string, access: DeckAccess, config: AccessControlConfig): boolean {
  if (login === normalizeLogin(config.admin)) return true;
  if (access.visibility === 'public') return true;
  return access.owner === login || access.sharedWith.includes(login);
}

export function canManageDeck(login: string, access: DeckAccess, config: AccessControlConfig): boolean {
  return login === normalizeLogin(config.admin) || access.owner === login;
}

export interface KnownUser {
  login: string;
  name: string;
  lastSeen: string;
}

/**
 * The server's people directory: everyone whose tailnet identity it has ever
 * seen, persisted as users.json in the decks root. It exists so the share
 * dialog can autocomplete logins and show human names — it grants nothing;
 * authorization is always the live identity plus the deck sidecars.
 */
export class UserDirectory {
  private users = new Map<string, KnownUser>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          const user = entry as Partial<KnownUser>;
          if (typeof user.login !== 'string' || !user.login) continue;
          this.users.set(normalizeLogin(user.login), {
            login: normalizeLogin(user.login),
            name: typeof user.name === 'string' && user.name ? user.name : user.login,
            lastSeen: typeof user.lastSeen === 'string' ? user.lastSeen : new Date(0).toISOString(),
          });
        }
      }
    } catch {
      // Missing or corrupt directory: start empty; it repopulates on sight.
    }
  }

  /** Record that this identity was seen just now; persists only on change. */
  async note(identity: Identity): Promise<void> {
    await this.load();
    const existing = this.users.get(identity.login);
    const now = new Date();
    // A request without the display-name header falls back to the login; that
    // fallback must never overwrite a real name learned earlier.
    const name = identity.name === identity.login && existing ? existing.name : identity.name;
    // lastSeen is deliberately coarse (an hour) so routine traffic doesn't
    // rewrite the file on every request.
    const stale = !existing
      || existing.name !== name
      || now.getTime() - new Date(existing.lastSeen).getTime() > 60 * 60 * 1000;
    if (!stale) return;
    this.users.set(identity.login, {
      login: identity.login,
      name,
      lastSeen: now.toISOString(),
    });
    const snapshot = this.list();
    this.writing = this.writing.then(() =>
      writeFile(this.file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'),
    ).catch(() => {});
    await this.writing;
  }

  list(): KnownUser[] {
    return [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async all(): Promise<KnownUser[]> {
    await this.load();
    return this.list();
  }
}
