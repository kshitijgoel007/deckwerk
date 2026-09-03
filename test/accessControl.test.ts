/**
 * The access-control decision layer in isolation: who a request is, what a
 * sidecar means (including a broken one), and the role × permission matrix.
 * No server, no sockets — collabAccess.test.ts covers the wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  canAccessDeck,
  canManageDeck,
  normalizeLogin,
  readDeckAccess,
  resolveIdentity,
  UserDirectory,
  writeDeckAccess,
  type DeckAccess,
} from '../src/server/accessControl.js';

const ADMIN = 'admin@tailnet.example';
const ALICE = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';
const CONFIG = { admin: ADMIN };

const fakeRequest = (remoteAddress: string | undefined, headers: Record<string, string | string[]>) =>
  ({ socket: { remoteAddress }, headers } as unknown as IncomingMessage);

describe('resolveIdentity', () => {
  it('trusts serve headers on every loopback spelling and normalizes the login', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(resolveIdentity(fakeRequest(address, {
        'tailscale-user-login': '  Alice@Tailnet.Example ',
        'tailscale-user-name': 'Alice A',
        'x-forwarded-for': '100.64.0.7',
      }), CONFIG)).toEqual({ login: ALICE, name: 'Alice A' });
    }
  });

  it('falls back to the raw login as the display name', () => {
    expect(resolveIdentity(fakeRequest('127.0.0.1', { 'tailscale-user-login': 'Bob@Tailnet.Example' }), CONFIG))
      .toEqual({ login: BOB, name: 'Bob@Tailnet.Example' });
  });

  it('takes the first value of a repeated header', () => {
    expect(resolveIdentity(fakeRequest('127.0.0.1', {
      'tailscale-user-login': [ALICE, ADMIN],
    }), CONFIG)?.login).toBe(ALICE);
  });

  it('treats a bare loopback request with no proxy headers as the admin', () => {
    expect(resolveIdentity(fakeRequest('127.0.0.1', {}), { admin: 'Admin@Tailnet.Example' }))
      .toEqual({ login: ADMIN, name: 'Admin@Tailnet.Example' });
  });

  it('refuses a proxied request that carries no identity (funnel, tagged node)', () => {
    // Serve stamps X-Forwarded-For on everything it proxies; only tailnet
    // users also get the login header. Anonymous proxied traffic must not be
    // promoted to admin just because the proxy lives on loopback.
    expect(resolveIdentity(fakeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), CONFIG)).toBeNull();
    expect(resolveIdentity(fakeRequest('::1', { 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': '' }), CONFIG))
      .toBeNull();
  });

  it('refuses everything off loopback, headers or not', () => {
    for (const address of ['100.101.102.103', '192.168.1.20', '127.0.0.2', '::ffff:10.0.0.1', undefined]) {
      expect(resolveIdentity(fakeRequest(address, { 'tailscale-user-login': ADMIN }), CONFIG)).toBeNull();
      expect(resolveIdentity(fakeRequest(address, {}), CONFIG)).toBeNull();
    }
  });
});

describe('readDeckAccess', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'access-control-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const write = (raw: string) => writeFile(join(dir, 'access.json'), raw, 'utf8');

  it('reads a well-formed sidecar and normalizes every login', async () => {
    await write(JSON.stringify({
      owner: ' Alice@Tailnet.Example ',
      visibility: 'private',
      sharedWith: ['Bob@Tailnet.Example', BOB, '', '  ', 42, null],
    }));
    expect(await readDeckAccess(dir, CONFIG)).toEqual({
      owner: ALICE, visibility: 'private', sharedWith: [BOB],
    });
  });

  it('treats a missing sidecar as public and admin-owned', async () => {
    expect(await readDeckAccess(dir, { admin: 'Admin@Tailnet.Example' })).toEqual({
      owner: ADMIN, visibility: 'public', sharedWith: [],
    });
  });

  it('never fails closed on a corrupt sidecar (the admin must stay able to repair it)', async () => {
    for (const raw of ['not json', '', '[]', 'null', '42', '"string"']) {
      await write(raw);
      expect(await readDeckAccess(dir, CONFIG)).toEqual({ owner: ADMIN, visibility: 'public', sharedWith: [] });
    }
  });

  it('falls back field by field on wrong types', async () => {
    await write(JSON.stringify({ owner: 12, visibility: 'secret', sharedWith: 'bob' }));
    expect(await readDeckAccess(dir, CONFIG)).toEqual({ owner: ADMIN, visibility: 'public', sharedWith: [] });
    await write(JSON.stringify({ owner: ALICE, visibility: 'PRIVATE' }));
    // Visibility is an exact enum: anything but "private" is public.
    expect((await readDeckAccess(dir, CONFIG)).visibility).toBe('public');
  });

  it('round-trips through writeDeckAccess', async () => {
    const access: DeckAccess = { owner: ALICE, visibility: 'private', sharedWith: [BOB] };
    await writeDeckAccess(dir, access);
    expect(JSON.parse(await readFile(join(dir, 'access.json'), 'utf8'))).toEqual(access);
    expect(await readDeckAccess(dir, CONFIG)).toEqual(access);
  });
});

describe('access decision matrix', () => {
  const stranger = 'carol@tailnet.example';
  const cases: Array<{
    access: DeckAccess;
    expect: Record<string, { open: boolean; manage: boolean }>;
  }> = [
    {
      access: { owner: ALICE, visibility: 'private', sharedWith: [BOB] },
      expect: {
        [ADMIN]: { open: true, manage: true },
        [ALICE]: { open: true, manage: true },
        [BOB]: { open: true, manage: false },
        [stranger]: { open: false, manage: false },
      },
    },
    {
      access: { owner: ALICE, visibility: 'public', sharedWith: [] },
      expect: {
        [ADMIN]: { open: true, manage: true },
        [ALICE]: { open: true, manage: true },
        [BOB]: { open: true, manage: false },
        [stranger]: { open: true, manage: false },
      },
    },
    {
      // The legacy fallback: no sidecar.
      access: { owner: ADMIN, visibility: 'public', sharedWith: [] },
      expect: {
        [ADMIN]: { open: true, manage: true },
        [ALICE]: { open: true, manage: false },
        [stranger]: { open: true, manage: false },
      },
    },
    {
      // Admin-owned and private: nobody but the admin.
      access: { owner: ADMIN, visibility: 'private', sharedWith: [] },
      expect: {
        [ADMIN]: { open: true, manage: true },
        [ALICE]: { open: false, manage: false },
      },
    },
  ];

  for (const { access, expect: expected } of cases) {
    it(`${access.visibility} deck owned by ${access.owner} shared with [${access.sharedWith}]`, () => {
      for (const [login, { open, manage }] of Object.entries(expected)) {
        expect(canAccessDeck(login, access, CONFIG), `${login} open`).toBe(open);
        expect(canManageDeck(login, access, CONFIG), `${login} manage`).toBe(manage);
      }
    });
  }

  it('matches the admin case-insensitively via the config, and never a raw un-normalized login', () => {
    const access: DeckAccess = { owner: ALICE, visibility: 'private', sharedWith: [] };
    expect(canAccessDeck(ADMIN, access, { admin: 'Admin@Tailnet.Example' })).toBe(true);
    // Subjects are always normalized before they reach the matrix; an
    // un-normalized subject is a caller bug and must not match by accident.
    expect(canAccessDeck('Alice@Tailnet.Example', access, CONFIG)).toBe(false);
    expect(normalizeLogin('  Alice@Tailnet.Example ')).toBe(ALICE);
  });
});

describe('UserDirectory', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'user-directory-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('persists on first sight, sorted by name, and survives a reload', async () => {
    const file = join(dir, 'users.json');
    const directory = new UserDirectory(file);
    await directory.note({ login: BOB, name: 'Bob B' });
    await directory.note({ login: ALICE, name: 'Alice A' });
    expect((await directory.all()).map((user) => user.login)).toEqual([ALICE, BOB]);
    const reloaded = new UserDirectory(file);
    expect((await reloaded.all()).map((user) => [user.login, user.name])).toEqual([[ALICE, 'Alice A'], [BOB, 'Bob B']]);
  });

  it('does not let a name-less request overwrite a real display name', async () => {
    const directory = new UserDirectory(join(dir, 'users.json'));
    await directory.note({ login: ALICE, name: 'Alice A' });
    await directory.note({ login: ALICE, name: ALICE }); // header missing: name fell back to the login
    expect((await directory.all())[0].name).toBe('Alice A');
    await directory.note({ login: ALICE, name: 'Alice Renamed' });
    expect((await directory.all())[0].name).toBe('Alice Renamed');
  });

  it('starts empty on a corrupt or missing file and repopulates', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, '{not json', 'utf8');
    const directory = new UserDirectory(file);
    expect(await directory.all()).toEqual([]);
    await directory.note({ login: ALICE, name: 'Alice A' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1);
  });

  it('ignores malformed entries in a persisted file', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, JSON.stringify([
      { login: 'Alice@Tailnet.Example', name: 'Alice A', lastSeen: 'x' },
      { name: 'no login' }, 'string', null, { login: '' },
    ]), 'utf8');
    const users = await new UserDirectory(file).all();
    expect(users.map((user) => user.login)).toEqual([ALICE]);
  });
});
