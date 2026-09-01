import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'electron-vite';
import { saveDeck } from '../../src/main/deckStore.js';
import { emptyDeck } from '../../src/shared/deck.js';
import {
  Cdp,
  collectProcessOutput,
  electronBinary,
  eventually,
  findTarget,
  freePort,
  stopBrowser,
} from './browserSession.js';

/**
 * Support for the OS-event input smoke tier (test/osInputSmokeBrowser.test.ts).
 *
 * Every other browser tier injects input through the CDP Input domain: the
 * events run the real Chromium pipeline, but nothing above it. This helper is
 * the layer above: it launches the real desktop app in a VISIBLE window, makes
 * it the frontmost macOS application, and sends genuine OS-level keyboard and
 * pointer events through System Events (and cliclick when installed). That is
 * the only way to exercise Electron's native menu/accelerator routing and real
 * inter-application focus changes.
 *
 * macOS only, and it requires the process driving osascript (the terminal or
 * test runner host app) to have Accessibility permission. The helpers detect
 * the permission failure and raise an actionable error instead of letting the
 * suite fail with an opaque AppleScript message.
 */

const execFileAsync = promisify(execFile);

/** True when this machine and invocation opted into the OS-input smoke tier. */
export const osInputOptIn =
  process.platform === 'darwin' && process.env['RUN_OS_INPUT_SMOKE'] === '1';

export const ACCESSIBILITY_HELP = [
  'osascript was refused permission to send OS-level input (System Events).',
  'Grant Accessibility permission to the app running this test (Terminal,',
  'iTerm2, or your editor) in System Settings > Privacy & Security >',
  'Accessibility, then re-run: npm run test:osinput',
].join('\n');

function isAccessibilityRefusal(message: string): boolean {
  return /not allowed to send keystrokes|not allowed assistive access|1002|-25211|-1719|accessibility/i
    .test(message);
}

/** Run one AppleScript, translating the Accessibility refusal into a clear error. */
export async function runOsa(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 15_000 });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAccessibilityRefusal(message)) {
      throw new Error(`${ACCESSIBILITY_HELP}\n\nUnderlying osascript error: ${message}`);
    }
    throw error;
  }
}

/**
 * Prove System Events may synthesise input before any scenario runs. Tapping
 * the bare Shift key is invisible to every application but takes the same
 * Accessibility gate as real keystrokes, so a machine without the permission
 * fails here with the actionable message rather than mid-scenario.
 */
export async function assertOsInputPermission(): Promise<void> {
  await runOsa('tell application "System Events" to key code 56');
}

function escapeAppleScriptString(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** Type text with real OS keystrokes into whatever application is frontmost. */
export async function osTypeText(text: string): Promise<void> {
  await runOsa(
    `tell application "System Events" to keystroke "${escapeAppleScriptString(text)}"`,
  );
}

export type OsModifier = 'command' | 'shift' | 'option' | 'control';

/** Press a real modified key chord (for example Cmd+B) at the OS level. */
export async function osKeystroke(key: string, modifiers: OsModifier[]): Promise<void> {
  const using = modifiers.length
    ? ` using {${modifiers.map((mod) => `${mod} down`).join(', ')}}`
    : '';
  await runOsa(
    `tell application "System Events" to keystroke "${escapeAppleScriptString(key)}"${using}`,
  );
}

/** Press a real key by macOS key code (124 = right arrow, 123 = left arrow…). */
export async function osKeyCode(code: number, modifiers: OsModifier[] = []): Promise<void> {
  const using = modifiers.length
    ? ` using {${modifiers.map((mod) => `${mod} down`).join(', ')}}`
    : '';
  await runOsa(`tell application "System Events" to key code ${code}${using}`);
}

/** Whether the cliclick CLI is installed (preferred for OS pointer events). */
export async function cliclickPath(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', ['cliclick']);
    return stdout.trim();
  } catch {
    return '';
  }
}

/** One real OS-level click at global screen coordinates. */
export async function osClickAt(x: number, y: number): Promise<void> {
  const cliclick = await cliclickPath();
  if (cliclick) {
    await execFileAsync(cliclick, [`c:${Math.round(x)},${Math.round(y)}`]);
    return;
  }
  await runOsa(
    `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`,
  );
}

/** One real OS-level double-click at global screen coordinates. */
export async function osDoubleClickAt(x: number, y: number): Promise<void> {
  const cliclick = await cliclickPath();
  if (cliclick) {
    await execFileAsync(cliclick, [`dc:${Math.round(x)},${Math.round(y)}`]);
    return;
  }
  await runOsa([
    'tell application "System Events"',
    `click at {${Math.round(x)}, ${Math.round(y)}}`,
    'delay 0.06',
    `click at {${Math.round(x)}, ${Math.round(y)}}`,
    'end tell',
  ].join('\n'));
}

/** Bring another application (by name) frontmost — real OS focus loss. */
export async function osActivateApp(appName: string): Promise<void> {
  await runOsa(`tell application "${escapeAppleScriptString(appName)}" to activate`);
}

/** Make the process with this unix pid the frontmost macOS application. */
export async function osActivateProcess(pid: number): Promise<void> {
  await runOsa([
    'tell application "System Events"',
    `set frontmost of (first application process whose unix id is ${pid}) to true`,
    'end tell',
  ].join('\n'));
  await eventually(
    () => runOsa([
      'tell application "System Events"',
      `get frontmost of (first application process whose unix id is ${pid})`,
      'end tell',
    ].join('\n')),
    `process ${pid} did not become the frontmost application`,
    (value) => value === 'true',
    8_000,
  );
}

/**
 * Global screen coordinates (macOS points, primary-display origin) of the
 * centre of the first element matching `selector`. Uses window.screenX/Y plus
 * the window chrome offset, so it holds for the hiddenInset title bar too.
 */
export async function screenPointOf(
  cdp: Cdp,
  selector: string,
  label = selector,
): Promise<{ x: number; y: number }> {
  const point = await cdp.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { error: 'no element matches' };
    node.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { error: 'element has no size' };
    // screenX/screenY locate the window's outer frame; the inner content view
    // is inset by the chrome. Width is symmetric, and the title bar takes the
    // whole height difference at the top.
    const chromeX = (window.outerWidth - window.innerWidth) / 2;
    const chromeY = window.outerHeight - window.innerHeight;
    return {
      x: window.screenX + chromeX + rect.left + rect.width / 2,
      y: window.screenY + chromeY + rect.top + rect.height / 2,
    };
  })()`);
  if ('error' in point) throw new Error(`cannot locate ${label} on screen: ${point.error}`);
  return point;
}

export interface OsDesktopEditor {
  cdp: Cdp;
  deckDir: string;
  /** The Electron main-process pid, for macOS activation via System Events. */
  pid: number;
  close: () => Promise<void>;
}

/**
 * Launch the real desktop app against a temporary deck the same way
 * test/support/desktopEditorSession.ts does, but keep the pid so the suite can
 * make the window frontmost at the OS level. DECKWERK_HEADLESS_TEST is
 * deliberately NOT set: this tier needs the visible window.
 */
export async function launchVisibleDesktopEditor(
  textId: string,
  textHtml: string,
): Promise<OsDesktopEditor> {
  const workDir = await mkdtemp(join(tmpdir(), 'os-input-smoke-'));
  const checkout = process.cwd();
  const appDir = join(workDir, 'app');
  const outDir = join(appDir, 'out');
  const deckDir = join(workDir, 'deck');
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(appDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  await build({
    root: checkout,
    configFile: join(checkout, 'electron.vite.config.ts'),
    logLevel: 'silent',
    build: { outDir },
  });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({
    name: 'deckwerk-os-input-smoke',
    private: true,
    type: 'module',
    main: 'out/main/index.js',
  }), 'utf8');
  await symlink(join(checkout, 'node_modules'), join(appDir, 'node_modules'), 'dir');

  const deck = emptyDeck('OS input smoke');
  deck.slides[0].elements.push({
    id: textId,
    type: 'text',
    x: 140,
    y: 150,
    w: 1640,
    h: 500,
    rot: 0,
    z: 1,
    opacity: 1,
    class: ['role-body'],
    style: {},
    html: textHtml,
    align: 'left',
    valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 42px/1.35 Arial, sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  const debugPort = await freePort();
  const appProcess: ChildProcess = spawn(electronBinary, [
    appDir,
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    deckDir,
  ], {
    cwd: checkout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const appLog = collectProcessOutput(appProcess);
  const target = await findTarget(
    debugPort,
    (candidate) => candidate.title === 'DeckWerk' || candidate.url.includes('/editor/index.html'),
    appLog,
    30_000,
  );
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  const content = `#canvas [data-element-id="${textId}"] .text-content`;
  await eventually(async () => cdp.evaluate<boolean>(`window.api.getDeck().then(
    (session) => session?.dir === ${JSON.stringify(deckDir)}
      && Boolean(document.querySelector(${JSON.stringify(content)}))
  )`), 'the desktop editor did not open the OS-input smoke fixture');
  if (typeof appProcess.pid !== 'number') {
    cdp.close();
    await stopBrowser(appProcess);
    await rm(workDir, { recursive: true, force: true });
    throw new Error('the desktop app process has no pid to activate');
  }

  return {
    cdp,
    deckDir,
    pid: appProcess.pid,
    close: async () => {
      cdp.close();
      await stopBrowser(appProcess);
      await rm(workDir, { recursive: true, force: true });
    },
  };
}
