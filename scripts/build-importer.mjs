#!/usr/bin/env node
/**
 * Freeze the Keynote importer into a single self-contained binary.
 *
 * Python is a hard build-time dependency, and deliberately not a *runtime*
 * one: PyInstaller bundles the interpreter and every dependency into the
 * binary shipped as an extraResource, so an installed DeckWerk imports .key
 * files on a machine with no Python at all.
 *
 * This replaces the shell one-liner it grew out of, which hardcoded POSIX venv
 * layout (`.venv-import/bin/pip`) and so could never run on Windows.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const WINDOWS = process.platform === 'win32';
const VENV = '.venv-import';
// virtualenv puts executables in Scripts/ on Windows and bin/ everywhere else.
const VENV_BIN = join(VENV, WINDOWS ? 'Scripts' : 'bin');
const exe = (name) => join(VENV_BIN, WINDOWS ? `${name}.exe` : name);

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { stdio: quiet ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exited with status ${result.status}`;
    throw new Error(`${command} ${args.join(' ')}\n  ${detail}`);
  }
  return result;
}

/**
 * Find a usable interpreter. Windows installs `python` (and the `py` launcher)
 * rather than `python3`, and a bare `python3` on Windows may be the Microsoft
 * Store stub that prints an advert and exits 9009.
 */
function findPython() {
  const candidates = WINDOWS ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
    if (probe.status === 0 && /^Python 3\.(\d+)/.test(probe.stdout || probe.stderr)) {
      const minor = Number(RegExp.$1);
      if (minor >= 10) return { command, prefix };
      console.error(`  ${command}: Python 3.${minor} is too old, need 3.10+`);
    }
  }
  return null;
}

const python = findPython();
if (!python) {
  console.error(
    'Python 3.10+ is required to build the Keynote importer, and was not found.\n' +
      '\n' +
      '  macOS    brew install python\n' +
      '  Debian   sudo apt-get install python3 python3-venv\n' +
      '  Windows  winget install Python.Python.3.12\n' +
      '\n' +
      'Python is needed only to build; the app ships the interpreter inside the\n' +
      'frozen importer, so people who install DeckWerk never need it.',
  );
  process.exit(1);
}

console.log(`Using ${[python.command, ...python.prefix].join(' ')}`);

if (!existsSync(exe('python'))) {
  console.log(`Creating ${VENV}`);
  run(python.command, [...python.prefix, '-m', 'venv', VENV]);
}

console.log('Installing keynote-parser and pyinstaller');
run(exe('python'), ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
run(exe('python'), ['-m', 'pip', 'install', '--quiet', 'keynote-parser', 'pyinstaller']);

mkdirSync('build/importers', { recursive: true });

console.log('Freezing importer');
run(exe('pyinstaller'), [
  '--onefile',
  '--name', 'keynote-import',
  // keynote-parser loads Apple's protobuf message modules dynamically, so
  // PyInstaller's static analysis cannot see them; likewise snappy's backend.
  '--collect-all', 'keynote_parser',
  '--collect-all', 'snappy',
  '--distpath', 'build/importers',
  '--workpath', 'build/pyinstaller',
  '--specpath', 'build/pyinstaller',
  '--noconfirm',
  'importers/keynote/import_keynote.py',
]);

const frozen = join('build/importers', WINDOWS ? 'keynote-import.exe' : 'keynote-import');
if (!existsSync(frozen)) throw new Error(`pyinstaller reported success but ${frozen} is missing`);

// Prove the binary is genuinely self-contained before anything packages it.
const check = spawnSync(frozen, ['--help'], { encoding: 'utf8' });
if (check.status !== 0) {
  throw new Error(`frozen importer does not run: ${check.stderr || check.error?.message}`);
}
console.log(`Built ${frozen}`);
