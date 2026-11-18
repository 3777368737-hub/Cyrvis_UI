/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';

import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';

import * as env from '@main/env';
import { logger } from '@main/logger';
import { getCompanionStore } from '@main/store/companion';
import { resolveCompanionSkin } from '@shared/companion-skins';

import { startCaptureService, type CaptureService } from './capture-service';
import { CyrvisController } from './controller';
import { ElectronGUIAdapter } from './gui-adapter';
import { QwenOmniProvider } from './voice/qwen-omni';
import { VoiceBrain, type VoiceBrainState } from './voice-brain';
import type { ControllerEvent } from './types';

interface VoiceService {
  brain: VoiceBrain;
  provider: QwenOmniProvider;
  controller: CyrvisController;
}

let service: VoiceService | null = null;
let captureService: CaptureService | null = null;
let captureReady = false;
let assistantPlaybackActive = false;
let captureBargeMs = 0;
let capturePreroll: Int16Array[] = [];
let lastCaptureLogAt = 0;
// Two selectable audio modes:
// - headset: capture without AEC + full voice barge-in (verified)
// - speaker: take turns; discard playback echo and its reverb tail.
// Default to speakers: energy-only barge-in cannot distinguish loud output
// from a real user. Headset users can explicitly opt in to spoken interruption.
let audioMode: 'headset' | 'speaker' = 'speaker';
let speakerOutputMode = true;
let speakerGuardUntil = 0;
let ipcRegistered = false;
let testAudioActive = false;
let pttActive = false;
// Hands-free by default. PTT remains available as a fallback mode.
const pttMode = false;

const CAPTURE_BARGE_THRESHOLD = 1000;
const CAPTURE_BARGE_SUSTAIN_MS = 150;

/**
 * Microphone audio comes from a hidden renderer that never plays audio.
 * Playback lives in the main window; separating the two audio sessions is
 * what keeps the mic alive while the assistant speaks.
 */
const handleCapturePcm = (pcm16: Int16Array): void => {
  if (!service || !captureReady || !pcm16.length) {
    return;
  }

  let sum = 0;
  for (let i = 0; i < pcm16.length; i += 1) {
    sum += Math.abs(pcm16[i]);
  }
  const average = sum / pcm16.length;

  const now = Date.now();
  if (now - lastCaptureLogAt >= 1000) {
    lastCaptureLogAt = now;
    logger.info('[cyrvis capture] level', {
      avg: Math.round(average),
      playing: assistantPlaybackActive,
      mode: audioMode,
    });
  }

  if (speakerOutputMode) {
    // AEC in the hidden capture renderer has no reference to the main
    // window's playback (measured self-audio 8640 during playback), so
    // speaker mode stays half-duplex: ignore the mic while playing, plus a
    // short reverb guard. Voice barge-in is only available in headset mode.
    if (assistantPlaybackActive || now < speakerGuardUntil) {
      return;
    }
    service.provider.sendAudio(pcm16);
    return;
  }

  capturePreroll.push(pcm16.slice());
  const prerollLimit = speakerOutputMode ? 15 : 30;
  if (capturePreroll.length > prerollLimit) {
    capturePreroll.shift();
  }

  if (assistantPlaybackActive) {
    const chunkMs = (pcm16.length / 16000) * 1000;
    if (average > CAPTURE_BARGE_THRESHOLD) {
      captureBargeMs += chunkMs;
    } else {
      captureBargeMs = Math.max(0, captureBargeMs - chunkMs);
    }
    if (captureBargeMs >= CAPTURE_BARGE_SUSTAIN_MS) {
      logger.info('[cyrvis capture] barge-in', {
        avg: Math.round(average),
      });
      assistantPlaybackActive = false;
      captureBargeMs = 0;
      const buffered = capturePreroll.splice(0);
      service.provider.bargeIn();
      service.brain.forceAwake();
      broadcast('cyrvis:voice:response-stopped');
      for (const chunk of buffered) {
        service.provider.sendAudio(chunk);
      }
    }
    return;
  }

  captureBargeMs = 0;
  service.provider.sendAudio(pcm16);
};

const startCapture = async (): Promise<void> => {
  captureService?.close();
  captureService = null;
  captureReady = false;
  captureService = await startCaptureService(
    {
      onPcm: handleCapturePcm,
      onReady: (label) => {
        captureReady = true;
        logger.info('[cyrvis capture] ready', {
          label,
          mode: audioMode,
        });
        broadcast('cyrvis:voice:capture-ready', { label });
      },
      onError: (message) => {
        captureReady = false;
        logger.error('[cyrvis capture] error', { message });
        broadcast('cyrvis:voice:capture-error', { message });
      },
    },
    { echoCancellation: speakerOutputMode },
  );
};

const broadcast = (channel: string, payload?: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

const broadcastPtt = () => {
  broadcast('cyrvis:voice:ptt', { active: pttActive, mode: pttMode });
};

const triggerBargeIn = () => {
  if (!service) {
    return;
  }
  logger.info('[cyrvis voice] barge-in');
  assistantPlaybackActive = false;
  captureBargeMs = 0;
  service.provider.bargeIn();
  service.brain.forceAwake();
  broadcast('cyrvis:voice:response-stopped');
};

const setPttActive = (active: boolean) => {
  if (!service) {
    return;
  }
  pttActive = active;
  if (pttActive) {
    service.brain.forceAwake();
    service.provider.clearAudioBuffer();
  } else {
    service.provider.endPtt();
  }
  logger.info('[cyrvis voice] PTT', { active: pttActive });
  broadcastPtt();
};

const registerVoiceIpc = () => {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle('cyrvis:voice:toggle-ptt', () => {
    setPttActive(!pttActive);
    return { active: pttActive, mode: pttMode };
  });

  ipcMain.handle('cyrvis:voice:get-ptt', () => ({
    active: pttActive,
    mode: pttMode,
  }));

  ipcMain.handle('cyrvis:voice:start', async () => {
    if (!service) {
      return { ok: false, error: 'voice service is not configured' };
    }
    try {
      await service.brain.start();
      if (!captureService) await startCapture();
      return { ok: true, state: service.brain.getState(), captureReady };
    } catch (error) {
      logger.error('[cyrvis voice] start failed', error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('cyrvis:voice:stop', () => {
    service?.provider.bargeIn();
    service?.brain.sleep();
    captureReady = false;
    captureService?.close();
    captureService = null;
    broadcast('cyrvis:voice:response-stopped');
  });

  ipcMain.handle('cyrvis:voice:get-state', () => {
    return service?.brain.getState() ?? null;
  });

  ipcMain.handle('cyrvis:voice:cancel-task', async () => {
    if (!service) {
      return null;
    }
    return service.controller.cancelTask();
  });

  ipcMain.on('cyrvis:voice:audio', (_event, buffer: ArrayBuffer) => {
    if (!service || testAudioActive || !(buffer instanceof ArrayBuffer)) {
      return;
    }
    if (pttMode && !pttActive) {
      return;
    }
    service.provider.sendAudio(new Int16Array(buffer));
  });

  ipcMain.handle('cyrvis:voice:test-audio', async () => {
    if (!env.isDev || !service) {
      return { ok: false, error: 'test audio is only available in dev' };
    }

    const wavPath = process.env.CYRVIS_TEST_WAV;
    if (!wavPath) {
      return {
        ok: false,
        error: 'CYRVIS_TEST_WAV is not set',
      };
    }
    let wav: Buffer;
    try {
      wav = fs.readFileSync(wavPath);
    } catch (error) {
      return {
        ok: false,
        error: `Cannot read CYRVIS_TEST_WAV: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    let offset = 12;
    let data: Buffer | null = null;
    while (offset + 8 <= wav.length) {
      const id = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (id === 'data') {
        data = wav.subarray(offset + 8, offset + 8 + size);
        break;
      }
      offset += 8 + size + (size % 2);
    }

    if (!data) {
      return { ok: false, error: 'WAV data chunk not found' };
    }

    logger.info('[cyrvis voice] test audio start', { bytes: data.length });
    testAudioActive = true;
    service.provider.clearAudioBuffer();
    try {
      const chunkSize = 640; // 20 ms at 16 kHz PCM16 mono
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.subarray(i, i + chunkSize);
        const pcm = new Int16Array(
          chunk.buffer,
          chunk.byteOffset,
          Math.floor(chunk.byteLength / 2),
        );
        service.provider.sendAudio(pcm);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Local VAD needs to observe trailing silence before committing.
      const silence = new Int16Array(16000); // 1 second at 16 kHz
      for (let i = 0; i < silence.length; i += 320) {
        service.provider.sendAudio(silence.subarray(i, i + 320));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      testAudioActive = false;
    }

    logger.info('[cyrvis voice] test audio sent');
    return { ok: true, bytes: data.length };
  });

  ipcMain.handle('cyrvis:voice:set-mode', async (_event, mode: unknown) => {
    if (mode !== 'headset' && mode !== 'speaker') {
      return { ok: false, error: 'mode must be headset or speaker' };
    }
    const nextMode = mode as 'headset' | 'speaker';
    const changed = audioMode !== nextMode;
    audioMode = nextMode;
    speakerOutputMode = nextMode === 'speaker';
    speakerGuardUntil = 0;
    captureBargeMs = 0;
    capturePreroll = [];
    logger.info('[cyrvis voice] audio mode', {
      mode: audioMode,
      echoCancellation: speakerOutputMode,
    });
    broadcast('cyrvis:voice:audio-mode', { mode: audioMode });
    if (changed && captureService) {
      try {
        await startCapture();
      } catch (error) {
        logger.error('[cyrvis capture] mode switch failed', error);
      }
    }
    return { ok: true, mode: audioMode };
  });

  ipcMain.handle('cyrvis:voice:get-mode', () => ({ mode: audioMode }));

  ipcMain.handle('cyrvis:voice:set-output', (_event, label: unknown) => {
    if (typeof label !== 'string' || !label.trim()) {
      return { ok: false, error: 'output label is required' };
    }
    const nextMode = /扬声器|speaker|realtek|nvidia|显示器|display/i.test(label)
      ? 'speaker'
      : 'headset';
    const changed = audioMode !== nextMode;
    audioMode = nextMode;
    speakerOutputMode = nextMode === 'speaker';
    if (speakerOutputMode) {
      speakerGuardUntil = 0;
      captureBargeMs = 0;
      capturePreroll = [];
    }
    logger.info('[cyrvis voice] output mode', {
      label,
      speaker: speakerOutputMode,
    });
    broadcast('cyrvis:voice:audio-mode', { mode: audioMode });
    broadcast('cyrvis:voice:set-output', label);
    if (changed) {
      void startCapture().catch((error) => {
        logger.error('[cyrvis capture] output mode restart failed', error);
      });
    }
    return { ok: true, speaker: speakerOutputMode, mode: audioMode };
  });

  ipcMain.handle('cyrvis:voice:restart-capture', async () => {
    if (!service || !captureService)
      return { ok: false, error: 'Voice is paused' };
    try {
      await startCapture();
      return { ok: true };
    } catch (error) {
      logger.error('[cyrvis capture] restart failed', error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.on('cyrvis:voice:playback-idle', () => {
    assistantPlaybackActive = false;
    captureBargeMs = 0;
    speakerGuardUntil = speakerOutputMode ? Date.now() + 800 : 0;
    service?.provider.notifyPlaybackIdle();
  });

  ipcMain.on('cyrvis:voice:barge-in', () => {
    triggerBargeIn();
  });

  ipcMain.on('cyrvis:voice:force-awake', () => {
    service?.brain.forceAwake();
  });

  ipcMain.on('cyrvis:voice:sleep', () => {
    service?.brain.sleep();
  });
};

/**
 * Starts the voice layer once per Electron main process.
 * No-op when QWEN_API_KEY is absent.
 */
export const startVoiceService = (): VoiceService | null => {
  if (service) {
    return service;
  }

  registerVoiceIpc();
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) {
    logger.warn(
      '[cyrvis voice] QWEN_API_KEY is not set; voice service is disabled',
    );
    return null;
  }

  const controller = new CyrvisController(new ElectronGUIAdapter());
  const companionStore = getCompanionStore();
  let provider!: QwenOmniProvider;

  const brain = new VoiceBrain(
    controller,
    {
      onAudio: (pcm16) => {
        const copy = pcm16.slice();
        broadcast('cyrvis:voice:audio', copy.buffer);
      },
      onSpeechStarted: () => {
        logger.info('[cyrvis voice] speech started');
        broadcast('cyrvis:voice:speech-started');
      },
      onSpeechStopped: () => {
        logger.info('[cyrvis voice] speech stopped');
        broadcast('cyrvis:voice:speech-stopped');
      },
      onTranscript: (text, final) =>
        broadcast('cyrvis:voice:transcript', { text, final }),
      onAssistantText: (text, final) => {
        logger.info('[cyrvis voice] assistant text', { text, final });
        broadcast('cyrvis:voice:assistant', { text, final });
      },
      onState: (state: VoiceBrainState) =>
        broadcast('cyrvis:voice:state', state),
      onWake: () => {
        logger.info('[cyrvis voice] wake');
        broadcast('cyrvis:voice:wake');
      },
      onSleep: () => {
        logger.info('[cyrvis voice] sleep');
        broadcast('cyrvis:voice:sleep');
      },
      onTaskEvent: (event: ControllerEvent) =>
        broadcast('cyrvis:voice:task-event', event),
      onError: (error) => logger.error('[cyrvis voice] error', error),
    },
    (callbacks) => {
      const wrapped = {
        ...callbacks,
        onReady: () => {
          logger.info('[cyrvis voice] qwen session ready');
          callbacks.onReady?.();
          if (captureReady)
            broadcast('cyrvis:voice:capture-ready', { label: 'Microphone' });
        },
        onTranscript: (text: string, final: boolean) => {
          logger.info('[cyrvis voice] transcript', { text, final });
          callbacks.onTranscript?.(text, final);
        },
        onResponseStarted: () => {
          assistantPlaybackActive = true;
          captureBargeMs = 0;
          capturePreroll = [];
          speakerGuardUntil = 0;
          if (speakerOutputMode) {
            // Drop any residual speaker/TTS audio still in the ASR buffer.
            service?.provider.clearAudioBuffer();
          }
          broadcast('cyrvis:voice:response-started');
          callbacks.onResponseStarted?.();
        },
        onResponseDone: () => {
          // Tool-call-only responses produce no audio. Tell the renderer so
          // its half-duplex gate does not stay closed for the watchdog period
          // and swallow the user's next words (e.g. "stop").
          broadcast('cyrvis:voice:response-done');
          callbacks.onResponseDone?.();
        },
        onUtteranceCommitted: () => {
          if (pttMode && pttActive) {
            setPttActive(false);
          }
          // The renderer shows "Thinking…" during the gap between end of
          // speech and the first response token, so the user does not repeat
          // themselves thinking they were not heard.
          broadcast('cyrvis:voice:thinking');
          callbacks.onUtteranceCommitted?.();
        },
        onToolCall: (
          call: Parameters<NonNullable<typeof callbacks.onToolCall>>[0],
        ) => {
          logger.info('[cyrvis voice] tool call', call.name, call.args);
          callbacks.onToolCall?.(call);
        },
        onError: (error: Error) => {
          logger.error('[cyrvis voice] provider error', error);
          broadcast('cyrvis:voice:capture-error', { message: error.message });
          callbacks.onError?.(error);
        },
      };

      provider = new QwenOmniProvider({
        apiKey,
        model: process.env.QWEN_MODEL || 'qwen3.8-omni-flash-realtime',
        voice: resolveCompanionSkin(companionStore.get('skinId')).voice,
        callbacks: wrapped,
        vadType: 'semantic_vad_ec',
        // 1.2s felt like the assistant was deaf: users repeat "Hello" before
        // the endpoint fires, which extends the utterance and delays it more.
        // 800ms keeps natural pauses while making the first reply snappier.
        silenceDurationMs: 800,
      });
      return provider;
    },
    {
      // Hands-free: the app listens continuously while it is running. The
      // provider's half-duplex gate mutes the mic while the assistant speaks.
      requireWakeWord: false,
      awakeTimeoutMs: 0,
      proactivity: {
        minGapMs: 5000,
        progressCooldownMs: 30000,
      },
    },
  );

  service = { brain, provider, controller };
  const unsubscribeSkin = companionStore.onDidChange('skinId', (skinId) => {
    const skin = resolveCompanionSkin(skinId);
    if (!provider.setVoice(skin.voice)) return;
    // Flush the sole audio owner's queued PCM without waking a paused pet or
    // restarting its microphone. Allow speaker echo to decay before listening.
    if (assistantPlaybackActive && speakerOutputMode)
      speakerGuardUntil = Date.now() + 800;
    assistantPlaybackActive = false;
    captureBargeMs = 0;
    capturePreroll = [];
    broadcast('cyrvis:voice:response-stopped');
    logger.info('[cyrvis voice] companion voice changed', {
      skinId: skin.id,
      voice: skin.voice,
    });
  });
  registerVoiceIpc();

  if (pttMode) {
    const shortcutRegistered = globalShortcut.register(
      'Control+Alt+Space',
      () => setPttActive(!pttActive),
    );
    logger.info('[cyrvis voice] PTT shortcut', {
      accelerator: 'Control+Alt+Space',
      registered: shortcutRegistered,
    });
  }

  // Keyboard fallback for barge-in. Voice barge-in works by speaking, but this
  // is deterministic even when the mic/echo gate is misbehaving.
  const stopShortcut = globalShortcut.register('Control+Alt+X', triggerBargeIn);
  logger.info('[cyrvis voice] stop-speaking shortcut', {
    accelerator: 'Control+Alt+X',
    registered: stopShortcut,
  });

  app.on('before-quit', () => {
    unsubscribeSkin();
    globalShortcut.unregisterAll();
    captureService?.close();
    captureService = null;
    brain.dispose();
    service = null;
  });

  // Connect eagerly so the app is listening after launch.
  brain
    .start()
    .then(() => {
      // The single renderer audio owner starts capture through voice:start.
      logger.info('[cyrvis voice] qwen connected');
    })
    .catch((error) => {
      logger.error('[cyrvis voice] connect/capture failed', error);
      broadcast('cyrvis:voice:capture-error', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  logger.info('[cyrvis voice] service started');
  return service;
};
