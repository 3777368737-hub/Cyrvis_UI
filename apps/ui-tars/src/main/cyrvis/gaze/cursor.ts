import { app, BrowserWindow, screen } from 'electron';

const SIZE = 36;
export const CURSOR_STALE_MS = 800;
export function cursorPosition(
  x: number,
  y: number,
  bounds: { x: number; y: number; width: number; height: number },
) {
  return {
    x: Math.round(
      bounds.x + Math.max(0, Math.min(1, x)) * (bounds.width - SIZE),
    ),
    y: Math.round(
      bounds.y + Math.max(0, Math.min(1, y)) * (bounds.height - SIZE),
    ),
  };
}

/** A separate, non-activating native window; never takes focus or mouse input. */
export class DesktopGazeCursor {
  private window: BrowserWindow | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private lastSampleAt = 0;
  private enabled = true;
  private position = { x: 0, y: 0 };

  constructor() {
    app.once('before-quit', () => this.destroy());
  }

  update(
    sample: { x: number; y: number; timestamp: number } | null,
    visibleMs = CURSOR_STALE_MS,
  ) {
    if (
      !sample ||
      !Number.isFinite(sample.x) ||
      !Number.isFinite(sample.y) ||
      !Number.isFinite(sample.timestamp) ||
      sample.x < 0 ||
      sample.x > 1 ||
      sample.y < 0 ||
      sample.y > 1 ||
      Math.abs(Date.now() - sample.timestamp) > CURSOR_STALE_MS
    ) {
      this.hide();
      return;
    }
    this.lastSampleAt = Date.now();
    this.position = cursorPosition(
      sample.x,
      sample.y,
      screen.getPrimaryDisplay().bounds,
    );
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.hide(), visibleMs);
    if (!this.enabled) return;
    this.ensureWindow();
    if (this.loaded && this.window && !this.window.isDestroyed()) {
      this.window.setPosition(this.position.x, this.position.y, false);
      if (!this.window.isVisible()) this.window.showInactive();
    }
  }

  isVisible() {
    return (
      !!this.window && !this.window.isDestroyed() && this.window.isVisible()
    );
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.hide();
    return enabled;
  }
  toggle() {
    return this.setEnabled(!this.enabled);
  }

  hide() {
    this.lastSampleAt = 0;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  destroy() {
    this.hide();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loaded = false;
  }

  private ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return;
    this.loaded = false;
    const win = new BrowserWindow({
      title: 'CYRVIS Gaze Cursor',
      width: SIZE,
      height: SIZE,
      x: this.position.x,
      y: this.position.y,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false,
      show: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window = win;
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.once('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.loaded = false;
      }
    });
    win.webContents.once('did-finish-load', () => {
      if (this.window !== win || win.isDestroyed()) return;
      this.loaded = true;
      if (
        this.enabled &&
        this.lastSampleAt &&
        Date.now() - this.lastSampleAt < CURSOR_STALE_MS
      ) {
        win.setPosition(this.position.x, this.position.y, false);
        win.showInactive();
      }
    });
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      html,body{margin:0;width:36px;height:36px;background:transparent;overflow:hidden;pointer-events:none}
      .ring{position:absolute;left:5px;top:5px;width:22px;height:22px;border:3px solid #10d8a0;border-radius:50%;box-shadow:0 0 0 1px #1239,0 0 6px #10d8a060}
      .center{position:absolute;left:16px;top:16px;width:4px;height:4px;border-radius:50%;background:#10d8a0}
      </style></head><body><div class="ring"></div><div class="center"></div></body></html>`;
    void win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => this.hide());
  }
}
