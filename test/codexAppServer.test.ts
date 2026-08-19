import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  resolveCodexBinary,
} from '../src/main/codexAppServer.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Array<Record<string, unknown>> = [];
  killed = false;
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const message = JSON.parse(String(chunk)) as Record<string, unknown>;
      this.messages.push(message);
      if (message.method === 'initialize' || message.method === 'account/read') {
        queueMicrotask(() => this.respond(message.id as number, message.method === 'account/read'
          ? { account: null, requiresOpenaiAuth: true }
          : { userAgent: 'test', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' }));
      }
      callback();
    },
  });

  respond(id: number | string, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  serverRequest(method: string, id: number, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, id, params })}\n`);
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Codex App Server stdio client', () => {
  it('performs the handshake, correlates requests, and streams notifications', async () => {
    const child = new FakeChild();
    const notifications: string[] = [];
    const client = new CodexAppServerClient({
      binaryPath: '/fake/codex',
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
      onNotification: (event) => notifications.push(event.method),
    });

    await client.start();
    expect(child.messages[0]).toMatchObject({ method: 'initialize', id: 1 });
    expect(child.messages[1]).toEqual({ method: 'initialized' });

    const account = await client.request('account/read', { refreshToken: false });
    expect(account).toEqual({ account: null, requiresOpenaiAuth: true });
    child.notify('item/agentMessage/delta', { delta: 'Hello' });
    await tick();
    expect(notifications).toEqual(['item/agentMessage/delta']);
    client.close();
  });

  it('declines unexpected approval requests instead of leaving a turn hung', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient({
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    await client.start();
    child.serverRequest('item/commandExecution/requestApproval', 42, {});
    await tick();
    expect(child.messages.at(-1)).toEqual({ id: 42, result: { decision: 'decline' } });
    client.close();
  });

  it('prefers an explicit configured binary', () => {
    expect(resolveCodexBinary({ DECKWERK_CODEX_PATH: '/custom/codex' }, 'linux'))
      .toBe('/custom/codex');
  });
});
