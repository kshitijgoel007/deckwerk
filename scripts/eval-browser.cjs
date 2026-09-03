const { app, BrowserWindow } = require('electron');

const url = process.argv[2];
const port = process.argv[3] || '9222';
const profileDir = process.argv[4];
if (!url) throw new Error('usage: electron eval-browser.cjs <url> <debug-port> [profile-dir]');
if (profileDir) app.setPath('userData', profileDir);
app.commandLine.appendSwitch('remote-debugging-port', port);
app.commandLine.appendSwitch('remote-allow-origins', '*');
// A presentation is video wall-to-wall, and these windows are hidden (show:
// false), which Chromium treats as background: muted, audio-less video gets
// suspended "to save power". Without this, no test could ever observe a clip
// actually playing.
app.commandLine.appendSwitch('disable-background-media-suspend');
// These windows are hidden, and Chromium throttles timers and backgrounds
// renderers it cannot see. Any timing a test measures would be quantised to
// the throttle interval rather than reflecting the code under test.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;
app.whenReady().then(async () => {
  // Hidden on a developer's machine, so tests never pop windows over their
  // work. On CI's bare Xvfb (CI_NO_WINDOW_MANAGER) the window is shown: an
  // unmapped X11 window gets no compositor frames at all, and every input
  // event dispatched over DevTools then waits out a fixed fallback before the
  // renderer handles it -- the nightly formatting matrix ran at 2.8 s/case in
  // this window against 145 ms/case in the app's shown window on the same
  // runner. Nobody is looking at that display, so showing it costs nothing.
  const showWindow = Boolean(process.env.CI_NO_WINDOW_MANAGER);
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: showWindow,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      // The command-line switches above are not the whole story: Electron
      // also throttles per window, and treats a window that is never shown as
      // background -- so under CI's bare Xvfb (the window is never mapped at
      // all) the page reports itself hidden, requestAnimationFrame stops, and
      // timers align to one-second ticks. The nightly formatting matrix ran
      // at 2.8 s/case there against 145 ms/case in the shown Electron window.
      backgroundThrottling: false,
    },
  });
  // The evaluation model may navigate through CDP while this first load is in
  // flight. Keep the window alive and tolerate that intentional cancellation.
  await mainWindow.loadURL(url).catch((error) => {
    if (!String(error).includes('ERR_ABORTED') && !String(error).includes('ERR_FAILED')) throw error;
  });
});

app.on('window-all-closed', () => app.quit());
