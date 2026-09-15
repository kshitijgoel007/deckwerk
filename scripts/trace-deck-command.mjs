#!/usr/bin/env node
/**
 * Benchmark one DeckWerk CLI exchange without changing its stdout/stderr.
 *
 *   node trace-deck-command.mjs trace.jsonl -- slide-agent context .
 *   node trace-deck-command.mjs trace.jsonl -- ./deck web check chart.html
 *
 * The JSONL record contains the exact command, response streams, exit status,
 * and monotonic wall time. It is deliberately a wrapper instead of tracing in
 * the product protocol, so normal agent replies stay compact and stable.
 */
import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const separator = process.argv.indexOf('--');
const traceArg = process.argv[2];
const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
if (!traceArg || separator !== 3 || command.length === 0) {
  process.stderr.write('usage: node trace-deck-command.mjs <trace.jsonl> -- <command> [args...]\n');
  process.exit(2);
}

const tracePath = resolve(process.cwd(), traceArg);
const startedAt = new Date().toISOString();
const started = process.hrtime.bigint();
const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});
child.on('error', async (error) => {
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  await appendFile(tracePath, `${JSON.stringify({
    startedAt, durationMs, cwd: process.cwd(), command, exitCode: null,
    signal: null, stdout, stderr, spawnError: error.message,
  })}\n`);
  process.exit(1);
});
child.on('close', async (exitCode, signal) => {
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  await appendFile(tracePath, `${JSON.stringify({
    startedAt, durationMs, cwd: process.cwd(), command, exitCode, signal, stdout, stderr,
  })}\n`);
  process.exit(exitCode ?? 1);
});
