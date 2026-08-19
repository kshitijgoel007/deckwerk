import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

type RpcId = number | string;

interface RpcResponse {
  id: RpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerClientOptions {
  binaryPath?: string;
  /** Isolated Codex configuration/auth root for an embedding application. */
  codexHome?: string;
  spawn?: (binary: string, args: string[]) => ChildProcessWithoutNullStreams;
  requestTimeoutMs?: number;
  onNotification?: (notification: AppServerNotification) => void;
  onExit?: (message: string) => void;
}

/**
 * Thin JSON-RPC client for `codex app-server --stdio`.
 *
 * App Server deliberately omits the `jsonrpc: "2.0"` envelope on the wire.
 * Keeping this transport in the main process means the renderer never gains
 * access to subprocesses, credentials, or arbitrary protocol methods.
 */
export class CodexAppServerClient {
  private readonly options: AppServerClientOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private stderr = '';
  private intentionalClose = false;

  constructor(options: AppServerClientOptions = {}) {
    this.options = options;
  }

  get running(): boolean {
    return this.process !== null;
  }

  async start(): Promise<void> {
    if (this.process) return;
    const binary = this.options.binaryPath ?? resolveCodexBinary();
    const spawn = this.options.spawn ?? ((command, args) => spawnChild(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.options.codexHome
        ? { ...process.env, CODEX_HOME: this.options.codexHome }
        : process.env,
    }));
    this.intentionalClose = false;
    this.stderr = '';

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, ['app-server', '--stdio']);
    } catch (error) {
      throw new Error(startError(binary, error));
    }
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    child.once('error', (error) => this.handleExit(startError(binary, error)));
    child.once('exit', (code, signal) => {
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : '';
      this.handleExit(`Codex App Server exited (${signal ?? `code ${code ?? 'unknown'}`})${suffix}`);
    });

    try {
      await this.request('initialize', {
        clientInfo: { name: 'deckwerk', title: 'DeckWerk', version: '0.1.0' },
        capabilities: null,
      });
      this.notify('initialized');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.process;
    if (!child) return Promise.reject(new Error('Codex App Server is not running'));
    const id = this.nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server timed out handling ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T), reject, timer,
      });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.process) throw new Error('Codex App Server is not running');
    const message = params === undefined ? { method } : { method, params };
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.intentionalClose = true;
    const child = this.process;
    this.process = null;
    if (child && !child.killed) child.kill();
    this.rejectPending(new Error('Codex App Server closed'));
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if ('id' in message && !('method' in message)) {
      const response = message as unknown as RpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message ?? 'Codex App Server request failed'));
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    if ('id' in message) {
      this.answerServerRequest(message.method, message.id as RpcId);
      return;
    }
    this.options.onNotification?.({ method: message.method, params: message.params });
  }

  /** No approval UI ships in v1; sandboxed requests fail closed rather than hanging. */
  private answerServerRequest(method: string, id: RpcId): void {
    if (!this.process) return;
    let result: unknown;
    if (method === 'item/commandExecution/requestApproval'
      || method === 'item/fileChange/requestApproval') {
      result = { decision: 'decline' };
    } else if (method === 'item/tool/requestUserInput') {
      result = { answers: {} };
    } else {
      this.process.stdin.write(`${JSON.stringify({
        id,
        error: { code: -32601, message: `Unsupported server request: ${method}` },
      })}\n`);
      return;
    }
    this.process.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private handleExit(message: string): void {
    // Both `error` and `exit` may fire for the same failed child. The first
    // callback owns cleanup; ignoring the second avoids duplicate UI errors.
    if (!this.process) return;
    this.process = null;
    this.rejectPending(new Error(message));
    if (!this.intentionalClose) this.options.onExit?.(message);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Find Codex even when a GUI-launched macOS app has a minimal PATH. */
export function resolveCodexBinary(env = process.env, platform = process.platform): string {
  const configured = env.DECKWERK_CODEX_PATH?.trim();
  if (configured) return configured;

  const candidates = platform === 'darwin'
    ? [
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
        join(process.resourcesPath ?? '', 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
      ]
    : [join(process.resourcesPath ?? '', platform === 'win32' ? 'codex.exe' : 'codex')];
  return candidates.find((candidate) => candidate && existsSync(candidate))
    ?? (platform === 'win32' ? 'codex.exe' : 'codex');
}

function startError(binary: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not start Codex from ${binary}: ${reason}`;
}
