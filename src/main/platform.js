// Display backend and what it allows. Decided once at startup, before any window exists.
//
// On a Wayland session MemoBrOS prefers to run natively on Wayland (Electron's own default). X11 through XWayland
// stays available as an explicit choice (`--ozone-platform=x11`, MEMOBROS_DISPLAY=x11, or Settings → System),
// because some features only exist there today. Nothing here changes the user's login session.
const { app } = require('electron');

function setup(preferX11) {
  const info = { relaunching: false, session: 'native', display: 'native', caps: { overlay: true, control: true, positioning: true, hotkeys: 'native' } };
  if (process.platform === 'win32') app.setAppUserModelId('com.memobros.app');
  if (process.platform !== 'linux') return info;

  const flag = (process.argv.find((a) => a.startsWith('--ozone-platform=')) || '').split('=')[1];
  const waylandSession = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
  info.session = waylandSession ? 'wayland' : 'x11';
  const wantX11 = preferX11 || process.env.MEMOBROS_DISPLAY === 'x11';
  if (waylandSession && wantX11 && !flag) {
    // The backend must be on the real command line; switching it from JavaScript is too late.
    info.relaunching = true;
    app.relaunch({ args: [...process.argv.slice(1), '--ozone-platform=x11'] });
    app.exit(0);
    return info;
  }
  info.display = flag || (waylandSession ? 'wayland' : 'x11');
  if (info.display === 'wayland') {
    // Global shortcuts on Wayland go through the desktop portal; GNOME asks the user to approve them.
    app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
    // No app may place itself above others, read the pointer, or inject input on Wayland.
    info.caps = { overlay: false, control: false, positioning: false, hotkeys: 'portal' };
  } else {
    info.caps = { overlay: true, control: true, positioning: true, hotkeys: 'x11', x11Only: waylandSession };
  }
  // The app draws a chat panel and a few vector shapes; it does not need the GPU, and on some drivers the GPU
  // process crashes. Render in software unless MEMOBROS_GPU=1 asks otherwise.
  if (process.env.MEMOBROS_GPU !== '1') app.disableHardwareAcceleration();
  return info;
}

module.exports = { setup };
