/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import WebSocket from 'ws';

import { logger } from '@main/logger';
import { SettingStore } from '@main/store/setting';
import type { BreezeTtsVoice } from '@shared/breezeTts';
import { normalizeBreezeVoiceId } from '@shared/breezeTts';
import {
  BREEZE_TTS_DEFAULT_BASE_URL,
  BREEZE_TTS_START_TIMEOUT_MS,
  toBreezeTtsWebSocketUrl,
} from '@shared/voice';

import { resolveBreezeTtsPaths } from './breezeTtsPaths';

const HEALTH_POLL_MS = 500;
const READY_CACHE_MS = 5_000;
const VOICE_CACHE_MS = 30_000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const getRepositoryRoot = () => {
  const candidates = [
    path.resolve(app.getAppPath(), '..', '..'),
    path.resolve(process.cwd(), '..'),
    process.cwd(),
    path.dirname(process.execPath),
  ];
  return (
    candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, '.runtime', 'breeze-tts-2')),
    ) || candidates[0]
  );
};

const getApiRoot = (baseUrl: string) =>
  baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');

class BreezeTtsService {
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private readyUntil = 0;
  private voicesCache: {
    loadedAt: number;
    voices: BreezeTtsVoice[];
  } | null = null;

  private getConfig() {
    const settings = SettingStore.getStore();
    const root = getRepositoryRoot();
    const baseUrl = (
      settings.voiceTtsBaseUrl || BREEZE_TTS_DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    const url = new URL(baseUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return {
      baseUrl,
      apiRoot: getApiRoot(baseUrl),
      port,
      wsPort: port + 1,
      wsUrl: toBreezeTtsWebSocketUrl(baseUrl),
      ...resolveBreezeTtsPaths({
        rootDir: root,
        configuredRuntimeDir: settings.voiceTtsRuntimeDir,
        configuredModelPath: settings.voiceTtsModelPath,
      }),
    };
  }

  private async isHealthy(apiRoot: string) {
    try {
      const response = await fetch(`${apiRoot}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private isStreamingHealthy(wsUrl: string) {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let socket: WebSocket | null = null;
      const finish = (healthy: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          // Probe socket may already be closed.
        }
        resolve(healthy);
      };
      const timer = setTimeout(() => finish(false), 3_000);
      try {
        socket = new WebSocket(wsUrl, { handshakeTimeout: 2_000 });
      } catch {
        finish(false);
        return;
      }
      socket.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as { type?: string };
          finish(message.type === 'ready');
        } catch {
          finish(false);
        }
      });
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    });
  }

  private async isFullyReady(
    config: ReturnType<BreezeTtsService['getConfig']>,
  ) {
    return (
      (await this.isHealthy(config.apiRoot)) &&
      (await this.isStreamingHealthy(config.wsUrl))
    );
  }

  private attachOutput(stream: NodeJS.ReadableStream | null, label: string) {
    if (!stream) {
      return;
    }
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        logger.info(`[BreezeTTS:${label}] ${text}`);
      }
    });
  }

  async ensureStarted(): Promise<void> {
    if (Date.now() < this.readyUntil) {
      return;
    }
    const config = this.getConfig();
    if (await this.isFullyReady(config)) {
      this.readyUntil = Date.now() + READY_CACHE_MS;
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = (async () => {
      if (await this.isHealthy(config.apiRoot)) {
        await this.waitUntilReady(config);
      } else {
        await this.start(config);
      }
    })().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async waitUntilReady(
    config: ReturnType<BreezeTtsService['getConfig']>,
    child?: ChildProcess,
  ) {
    const deadline = Date.now() + BREEZE_TTS_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child && child.exitCode !== null) {
        throw new Error(
          `Breeze TTS server exited during startup (code ${child.exitCode})`,
        );
      }
      if (await this.isFullyReady(config)) {
        this.readyUntil = Date.now() + READY_CACHE_MS;
        return;
      }
      await delay(HEALTH_POLL_MS);
    }
    throw new Error('Breeze TTS server startup timed out');
  }

  private async start(config: ReturnType<BreezeTtsService['getConfig']>) {
    const executable = path.join(config.runtimeDir, 'breeze-server.exe');
    if (!fs.existsSync(executable)) {
      throw new Error(`Breeze TTS runtime not found: ${executable}`);
    }
    if (!fs.existsSync(config.modelPath)) {
      throw new Error(`Breeze TTS model not found: ${config.modelPath}`);
    }
    fs.mkdirSync(config.voicesDir, { recursive: true });
    const child = spawn(
      executable,
      [
        config.modelPath,
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--ws-port',
        String(config.wsPort),
        '--parallel',
        '1',
        '--voices-dir',
        config.voicesDir,
      ],
      {
        cwd: config.runtimeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    this.attachOutput(child.stdout, 'stdout');
    this.attachOutput(child.stderr, 'stderr');
    child.once('exit', (code, signal) => {
      logger.info('[BreezeTTS] Server exited', { code, signal });
      if (this.child === child) {
        this.child = null;
        this.readyUntil = 0;
        this.voicesCache = null;
      }
    });

    try {
      await this.waitUntilReady(config, child);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async listVoices(): Promise<BreezeTtsVoice[]> {
    if (
      this.voicesCache &&
      Date.now() - this.voicesCache.loadedAt < VOICE_CACHE_MS
    ) {
      return this.voicesCache.voices;
    }
    await this.ensureStarted();
    const config = this.getConfig();
    const response = await fetch(`${config.apiRoot}/v1/voices`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Breeze voices request failed (${response.status})`);
    }
    const voices = (await response.json()) as BreezeTtsVoice[];
    this.voicesCache = { loadedAt: Date.now(), voices };
    return voices;
  }

  async isVoiceAvailable(voiceId?: string) {
    const normalized = normalizeBreezeVoiceId(voiceId);
    if (!normalized) {
      return true;
    }
    return (await this.listVoices()).some((voice) => voice.id === normalized);
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
    }
    this.readyUntil = 0;
    this.voicesCache = null;
  }
}

export const breezeTtsService = new BreezeTtsService();
