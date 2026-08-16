import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { parseDeck } from '@shared/deck.js';
import type { ImportReport, KeynoteImportResult } from '@shared/ipc.js';

/**
 * Runs the Keynote importer sidecar.
 *
 * The importer is Python because the decoder for Apple's IWA/protobuf format
 * exists there and reimplementing Apple's message schemas in TypeScript would
 * be a permanent maintenance burden. It ships as a frozen single-file binary,
 * so no Python installation is required — and, importantly, no Keynote either,
 * which is what lets this work on Linux.
 */

/** Locate the sidecar: frozen binary when packaged, source script in dev. */
function resolveSidecar(): { command: string; args: string[] } | null {
  const binaryName = process.platform === 'win32' ? 'keynote-import.exe' : 'keynote-import';
  const packaged = [
    join(process.resourcesPath ?? '', 'importers', binaryName),
    join(import.meta.dirname, '../../importers', binaryName),
  ];
  for (const candidate of packaged) {
    if (candidate && existsSync(candidate)) return { command: candidate, args: [] };
  }

  if (!app.isPackaged) {
    const script = join(process.cwd(), 'importers/keynote/import_keynote.py');
    if (existsSync(script)) {
      // Prefer the project venv, which is where keynote-parser is installed.
      const venv = join(process.cwd(), '.venv-import/bin/python');
      const python = existsSync(venv) ? venv : 'python3';
      return { command: python, args: [script] };
    }
  }
  return null;
}

export async function importKeynote(
  keyPath: string,
  outDir: string,
): Promise<KeynoteImportResult> {
  const sidecar = resolveSidecar();
  if (!sidecar) {
    throw new Error(
      'Keynote importer not found. In development, create the venv:\n' +
        '  python3 -m venv .venv-import && ./.venv-import/bin/pip install keynote-parser',
    );
  }

  const { stdout } = await run(sidecar.command, [
    ...sidecar.args,
    keyPath,
    '--out',
    outDir,
  ]);

  let payload: { dir: string; report: ImportReport; deck: unknown };
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Importer returned unreadable output:\n${stdout.slice(0, 500)}`);
  }

  // Validate here rather than trusting the sidecar: the schema is the contract,
  // and a bad import should fail loudly at the boundary, not later on a slide.
  return {
    dir: payload.dir,
    deck: parseDeck(payload.deck),
    report: payload.report,
  };
}

function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (err) =>
      reject(new Error(`Could not run the Keynote importer: ${err.message}`)),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`Keynote import failed (exit ${code}):\n${stderr.trim()}`)),
    );
  });
}
