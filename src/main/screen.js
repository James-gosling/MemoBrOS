// Screen capture and coordinate mapping between the model's screenshot space and the real desktop.
const { screen, desktopCapturer } = require('electron');

const MAX_EDGE = 1366; // long edge of screenshots sent to the model

function activeDisplay() { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); }

// Captures the display under the cursor. Returns { base64, mediaType, w, h, display }.
async function capture(display = activeDisplay()) {
  const { width, height } = display.bounds;
  const k = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.round(width * k), h = Math.round(height * k);
  let sources;
  try { sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } }); }
  catch (e) {
    // On Wayland the desktop asks the user to share a screen; refusing, or a desktop without that service, lands here.
    throw new Error(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY
      ? 'I could not capture the screen. On Wayland the system shows a screen-sharing dialog: choose a screen and allow it. If no dialog appeared, screen sharing is not available in this session.'
      : `I could not capture the screen (${e.message}).`);
  }
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('Screen capture returned nothing. On macOS grant Screen Recording permission to MemoBrOS in System Settings → Privacy & Security.');
  }
  const size = source.thumbnail.getSize();
  return { base64: source.thumbnail.toJPEG(80).toString('base64'), mediaType: 'image/jpeg', w: size.width, h: size.height, display };
}

// Screenshot pixel → position inside the overlay window (which covers the display, in DIPs).
function toOverlay(shot, x, y) {
  return { x: (x * shot.display.bounds.width) / shot.w, y: (y * shot.display.bounds.height) / shot.h };
}

// Screenshot pixel → coordinates for synthetic mouse input.
function toInput(shot, x, y) {
  const o = toOverlay(shot, x, y);
  const dip = { x: Math.round(shot.display.bounds.x + o.x), y: Math.round(shot.display.bounds.y + o.y) };
  if (process.platform === 'darwin') return dip; // macOS input is in points
  if (process.platform === 'win32') return screen.dipToScreenPoint(dip);
  const s = shot.display.scaleFactor || 1; // X11: physical pixels
  return { x: Math.round(dip.x * s), y: Math.round(dip.y * s) };
}

module.exports = { capture, activeDisplay, toOverlay, toInput };
