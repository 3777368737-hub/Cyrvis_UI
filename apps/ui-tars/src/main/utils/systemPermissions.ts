/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { shell, systemPreferences } from 'electron';
import permissions from '@computer-use/node-mac-permissions';

import * as env from '@main/env';
import { logger } from '@main/logger';

// Query by default. Only an explicit desktop-control request should open
// macOS privacy settings or display an operating-system permission prompt.
export const ensurePermissions = ({
  request = false,
}: { request?: boolean } = {}): {
  screenCapture: boolean;
  accessibility: boolean;
} => {
  if (env.isE2eTest) {
    return {
      screenCapture: true,
      accessibility: true,
    };
  }

  const screenStatus = permissions.getAuthStatus('screen');
  const mediaStatus = systemPreferences.getMediaAccessStatus?.('screen');
  const hasScreenRecordingPermission =
    screenStatus === 'authorized' || mediaStatus === 'granted';
  const hasAccessibilityPermission =
    systemPreferences.isTrustedAccessibilityClient(request);

  if (request && !hasScreenRecordingPermission) {
    void shell
      .openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      )
      .catch((error) =>
        logger.error('Unable to open screen capture settings', error),
      );
    permissions.askForScreenCaptureAccess();
  }

  logger.info(
    '[ensurePermissions] hasScreenRecordingPermission',
    hasScreenRecordingPermission,
    'screenStatus',
    screenStatus,
    'mediaStatus',
    mediaStatus,
    'hasAccessibilityPermission',
    hasAccessibilityPermission,
  );

  return {
    screenCapture: hasScreenRecordingPermission,
    accessibility: hasAccessibilityPermission,
  };
};
