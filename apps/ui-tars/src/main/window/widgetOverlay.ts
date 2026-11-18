/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { BrowserWindow } from 'electron';

import { WidgetOverlayMode } from '@main/store/types';

export const shouldKeepWidgetOnTop = (
  mode: WidgetOverlayMode | undefined,
): boolean => mode !== WidgetOverlayMode.AllowCovered;

export const applyWidgetOverlayBehavior = (
  window: BrowserWindow | null,
  mode: WidgetOverlayMode | undefined,
): void => {
  if (!window || window.isDestroyed()) {
    return;
  }

  const keepOnTop = shouldKeepWidgetOnTop(mode);
  if (keepOnTop) {
    window.setAlwaysOnTop(true, 'screen-saver');
  } else {
    window.setAlwaysOnTop(false);
  }

  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(
      keepOnTop,
      keepOnTop ? { visibleOnFullScreen: true } : undefined,
    );
  }
};
