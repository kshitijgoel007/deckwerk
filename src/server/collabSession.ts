import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { loadDeck, saveDeck, loadTheme, saveTheme } from '../main/deckStore.js';
import { validateDeckIntegrity, type AgentOperation } from '../shared/agent.js';
import { applyOpsLenient } from '../shared/collabApply.js';
import type { Deck } from '../shared/deck.js';

const SAVE_DEBOUNCE_MS = 800;
const WATCH_DEBOUNCE_MS = 200;

export interface AppliedTxn {
  seq: number;
  deck: Deck;
  skipped: Array<{ op: AgentOperation; reason: string }>;
}

export interface CollabSessionEvents {
  /** A genuine external write to deck.json (agent CLI, git, hand edit). */
  onExternalDeck: (deck: Deck, seq: number) => void;
  /** A genuine external write to theme.css. */
  onExternalTheme: (css: string) => void;
}

/**
 * The authoritative deck for one collaborative session.
 *
 * Transactions apply synchronously in arrival order — each accepted one bumps
 * `seq`, which is the total order every client replays. Persistence mirrors
 * the editor's autosave: debounced whole-file writes, with the exact written
 * bytes remembered so the fs watcher can tell our own echo from a genuine
 * external edit (same trick as the Electron main process).
 *
 * Not supported: the Electron app and this server editing the same deck
 * folder at once — both are debounced whole-file writers and would silently
 * last-write-wins each other.
 */
export class CollabSession {
  private saveTimer: NodeJS.Timeout | null = null;
  private lastSavedJson: string | null = null;
  private lastSavedTheme: string | null = null;
  private watchers: FSWatcher[] = [];
  private events: CollabSessionEvents | null = null;

  private constructor(
    readonly dir: string,
    public deck: Deck,
    public themeCss: string,
    public seq = 0,
  ) {}

  static async open(dir: string): Promise<CollabSession> {
    const deck = await loadDeck(dir);
    const themeCss = await loadTheme(dir, deck.theme);
    return new CollabSession(dir, deck, themeCss);
  }

  /**
   * Apply one client transaction. Even a fully-skipped transaction gets a
   * sequence number and must be broadcast: the sender confirms its pending
   * entry by seeing its own txnId come back, and replaying skipped ops is
   * idempotent by construction.
   */
  applyOps(ops: AgentOperation[]): AppliedTxn {
    const { deck: next, skipped } = applyOpsLenient(this.deck, ops);
    const errors = validateDeckIntegrity(next);
    if (errors.length > 0) {
      // Should be unreachable — lenient apply is total — but never let a
      // corrupt deck become authoritative.
      throw new Error(errors.join('\n'));
    }
    this.deck = next;
    this.seq += 1;
    if (skipped.length < ops.length) this.schedulePersist();
    return { seq: this.seq, deck: next, skipped };
  }

  saveThemeCss(css: string): void {
    this.themeCss = css;
    this.lastSavedTheme = css;
    void saveTheme(this.dir, this.deck.theme, css).catch((error) => {
      console.error(`theme save failed: ${String(error)}`);
    });
  }

  watch(events: CollabSessionEvents): void {
    this.events = events;
    let deckTimer: NodeJS.Timeout | null = null;
    let themeTimer: NodeJS.Timeout | null = null;
    this.watchers.push(
      watch(join(this.dir, 'deck.json'), () => {
        if (deckTimer) clearTimeout(deckTimer);
        deckTimer = setTimeout(() => void this.reloadDeckFromDisk(), WATCH_DEBOUNCE_MS);
      }),
      watch(join(this.dir, this.deck.theme), () => {
        if (themeTimer) clearTimeout(themeTimer);
        themeTimer = setTimeout(() => void this.reloadThemeFromDisk(), WATCH_DEBOUNCE_MS);
      }),
    );
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.persist();
    }
  }

  async close(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    await this.flush();
  }

  private schedulePersist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist();
    }, SAVE_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    try {
      this.lastSavedJson = await saveDeck(this.dir, this.deck);
    } catch (error) {
      console.error(`deck save failed: ${String(error)}`);
    }
  }

  private async reloadDeckFromDisk(): Promise<void> {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(join(this.dir, 'deck.json'), 'utf8');
      if (raw === this.lastSavedJson) return; // our own autosave echo
      const deck = await loadDeck(this.dir);
      this.deck = deck;
      this.seq += 1;
      this.events?.onExternalDeck(deck, this.seq);
    } catch {
      // Half-written JSON mid-save; the next event will retry.
    }
  }

  private async reloadThemeFromDisk(): Promise<void> {
    try {
      const css = await loadTheme(this.dir, this.deck.theme);
      if (css === this.lastSavedTheme) return;
      this.themeCss = css;
      this.events?.onExternalTheme(css);
    } catch {
      // Transient read failure; next event retries.
    }
  }
}
