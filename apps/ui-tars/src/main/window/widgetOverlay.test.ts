import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { WidgetOverlayMode } from '@main/store/types';

import {
  applyWidgetOverlayBehavior,
  shouldKeepWidgetOnTop,
} from './widgetOverlay';

const createWindow = () =>
  ({
    isDestroyed: vi.fn(() => false),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
  }) as unknown as BrowserWindow;

describe('widget overlay behavior', () => {
  it('keeps the widget above fullscreen windows by default', () => {
    expect(shouldKeepWidgetOnTop(undefined)).toBe(true);
    expect(shouldKeepWidgetOnTop(WidgetOverlayMode.AlwaysOnTop)).toBe(true);
  });

  it('allows fullscreen apps to cover the widget', () => {
    const window = createWindow();
    applyWidgetOverlayBehavior(window, WidgetOverlayMode.AllowCovered);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(false);
  });

  it('uses the screen-saver layer when keep-on-top is enabled', () => {
    const window = createWindow();
    applyWidgetOverlayBehavior(window, WidgetOverlayMode.AlwaysOnTop);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
  });

  it('does nothing after the widget has been destroyed', () => {
    const window = createWindow();
    vi.mocked(window.isDestroyed).mockReturnValue(true);
    applyWidgetOverlayBehavior(window, WidgetOverlayMode.AlwaysOnTop);
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  });
});
