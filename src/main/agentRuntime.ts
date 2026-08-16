import { createHash, randomUUID } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  AgentContextSchema,
  AgentRequestSchema,
  AgentResponseSchema,
  canonicalDeckJson,
  type AgentContext,
  type AgentContextDraft,
  type AgentRequest,
  type AgentResponse,
} from '@shared/agent.js';
import type { Deck } from '@shared/deck.js';
import { IPC } from '@shared/ipc.js';

export const AGENT_STATE_ROOT = process.env.SLIDE_EDITOR_STATE_DIR
  ? resolve(process.env.SLIDE_EDITOR_STATE_DIR)
  : join(homedir(), '.slide-editor', 'runtime');

export function deckRevision(deck: Deck): string {
  return createHash('sha256').update(canonicalDeckJson(deck)).digest('hex');
}

export function agentRuntimeDir(deckDir: string): string {
  const canonical = resolve(deckDir);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return join(AGENT_STATE_ROOT, `${sanitize(basename(canonical))}-${key}`);
}

export function agentRuntimePaths(deckDir: string) {
  const root = agentRuntimeDir(deckDir);
  return {
    root,
    context: join(root, 'context.json'),
    inbox: join(root, 'inbox'),
    responses: join(root, 'responses'),
  };
}

/** File-only bridge between a local agent and the currently open editor. */
export class AgentRuntime {
  readonly sessionId = randomUUID();
  private deckDir: string | null = null;
  private watcher: FSWatcher | null = null;
  private processing = new Set<string>();
  private editor: () => BrowserWindow | null;

  constructor(editor: () => BrowserWindow | null) {
    this.editor = editor;
  }

  async open(deckDir: string): Promise<void> {
    await this.close();
    this.deckDir = resolve(deckDir);
    const paths = agentRuntimePaths(deckDir);
    await mkdir(paths.inbox, { recursive: true });
    await mkdir(paths.responses, { recursive: true });
    this.watcher = watch(paths.inbox, () => void this.drain());
    await this.drain();
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    if (this.deckDir) {
      const path = agentRuntimePaths(this.deckDir).context;
      try {
        const previous = AgentContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        await atomicJson(path, { ...previous, live: false, updatedAt: new Date().toISOString() });
      } catch {
        // No valid prior context to close.
      }
    }
    this.deckDir = null;
  }

  async publish(draft: AgentContextDraft): Promise<AgentContext> {
    if (!this.deckDir) throw new Error('No deck is open');
    const context = AgentContextSchema.parse({
      ...draft,
      live: true,
      sessionId: this.sessionId,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      deckPath: this.deckDir,
    });
    await atomicJson(agentRuntimePaths(this.deckDir).context, context);
    return context;
  }

  async respond(response: AgentResponse): Promise<void> {
    if (!this.deckDir) return;
    const parsed = AgentResponseSchema.parse(response);
    const path = join(agentRuntimePaths(this.deckDir).responses, `${safeId(parsed.id)}.json`);
    await atomicJson(path, parsed);
  }

  private async drain(): Promise<void> {
    if (!this.deckDir) return;
    const paths = agentRuntimePaths(this.deckDir);
    const names = (await readdir(paths.inbox).catch(() => []))
      .filter((name) => name.endsWith('.json'));
    for (const name of names) {
      if (this.processing.has(name)) continue;
      this.processing.add(name);
      try {
        const path = join(paths.inbox, name);
        const request = AgentRequestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        const win = this.editor();
        if (!win || win.isDestroyed()) {
          await this.respond({
            version: 1, id: request.id, status: 'error', revision: '',
            message: 'The editor is not available',
          });
        } else {
          win.webContents.send(IPC.agentRequest, request);
        }
        await unlink(path).catch(() => undefined);
      } catch (error) {
        const id = name.replace(/\.json$/, '');
        await this.respond({
          version: 1, id, status: 'error', revision: '',
          message: error instanceof Error ? error.message : String(error),
        });
        await unlink(join(paths.inbox, name)).catch(() => undefined);
      } finally {
        this.processing.delete(name);
      }
    }
  }
}

export async function writeAgentRequest(deckDir: string, request: AgentRequest): Promise<string> {
  const paths = agentRuntimePaths(deckDir);
  await mkdir(paths.inbox, { recursive: true });
  await mkdir(paths.responses, { recursive: true });
  const path = join(paths.inbox, `${safeId(request.id)}.json`);
  await atomicJson(path, AgentRequestSchema.parse(request));
  return join(paths.responses, `${safeId(request.id)}.json`);
}

export async function readLiveAgentContext(deckDir: string): Promise<AgentContext | null> {
  const path = agentRuntimePaths(deckDir).context;
  if (!existsSync(path)) return null;
  try {
    const context = AgentContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (!context.live || resolve(context.deckPath) !== resolve(deckDir)) return null;
    try {
      process.kill(context.pid, 0);
    } catch {
      return null;
    }
    return context;
  } catch {
    return null;
  }
}

export async function waitForAgentResponse(
  responsePath: string,
  timeoutMs = 15_000,
): Promise<AgentResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = AgentResponseSchema.parse(JSON.parse(await readFile(responsePath, 'utf8')));
      await unlink(responsePath).catch(() => undefined);
      return response;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error('Timed out waiting for the editor to process the request');
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid request id: ${id}`);
  return id;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
}
