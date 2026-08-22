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
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // The evaluation model may navigate through CDP while this first load is in
  // flight. Keep the window alive and tolerate that intentional cancellation.
  await mainWindow.loadURL(url).catch((error) => {
    if (!String(error).includes('ERR_ABORTED') && !String(error).includes('ERR_FAILED')) throw error;
  });
});

app.on('window-all-closed', () => app.quit());
