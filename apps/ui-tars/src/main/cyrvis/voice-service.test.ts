import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CaptureServiceHandlers } from './capture-service';
import type { VoiceProviderCallbacks } from './voice/provider';
import type { QwenOmniConfig } from './voice/qwen-omni';

type IpcCallback = (...args: unknown[]) => unknown;

const mock = vi.hoisted(() => ({
  handlers: new Map<string, IpcCallback>(),
  events: new Map<string, IpcCallback>(),
  capture: null as CaptureServiceHandlers | null,
  callbacks: null as VoiceProviderCallbacks | null,
  config: null as QwenOmniConfig | null,
  skinId: undefined as string | undefined,
  skinListeners: new Set<(value: string | undefined) => void>(),
  send: vi.fn(),
  wake: vi.fn(),
  speakReply: vi.fn(),
  start: vi.fn(async () => undefined),
  captureClose: vi.fn(),
  provider: {
    sendAudio: vi.fn(),
    bargeIn: vi.fn(),
    clearAudioBuffer: vi.fn(),
    notifyPlaybackIdle: vi.fn(),
    setVoice: vi.fn(() => true),
  },
}));
vi.mock('electron', () => ({
  app: { on: vi.fn(), once: vi.fn() },
  screen: {
    on: vi.fn(),
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mock.send } },
    ],
  },
  globalShortcut: { register: () => true },
  ipcMain: {
    handle: (name: string, fn: IpcCallback) => mock.handlers.set(name, fn),
    on: (name: string, fn: IpcCallback) => mock.events.set(name, fn),
  },
}));
vi.mock('electron-store', () => ({
  default: class {
    get() {
      return mock.skinId;
    }
    set(_key: string, value: string) {
      if (mock.skinId === value) return;
      mock.skinId = value;
      for (const listener of mock.skinListeners) listener(value);
    }
    onDidChange(_key: string, listener: (value: string | undefined) => void) {
      mock.skinListeners.add(listener);
      return () => mock.skinListeners.delete(listener);
    }
  },
}));
vi.mock('@main/env', () => ({
  isDev: false,
  voiceEngine: 'omni',
  voiceSilenceTimeoutMs: 600,
}));
vi.mock('@main/store/setting', () => ({
  SettingStore: { getStore: () => ({ voiceEngine: 'omni' }) },
}));
vi.mock('@main/services/breezeTts', () => ({
  breezeTtsService: { stop: vi.fn() },
}));
vi.mock('@main/services/qwenTtsRealtime', () => ({
  qwenTtsRealtimeService: { stopAll: vi.fn() },
}));
vi.mock('./voice/local-tts', () => ({ localTtsService: {} }));
vi.mock('./voice/cascade-provider', () => ({ CascadeVoiceProvider: class {} }));
vi.mock('./keyword-gate', () => ({
  KeywordGate: class {
    load() {}
    reset() {}
  },
}));
vi.mock('./memory', () => ({
  voiceMemoryService: {
    appendActivity: vi.fn(async () => undefined),
    getSnapshot: () => ({ turns: [] }),
  },
}));
vi.mock('@main/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('./capture-service', () => ({
  startCaptureService: async (callbacks: CaptureServiceHandlers) => {
    mock.capture = callbacks;
    callbacks.onReady('Built-in microphone');
    return { close: mock.captureClose };
  },
}));
vi.mock('./controller', () => ({ CyrvisController: class {} }));
vi.mock('./gui-adapter', () => ({ ElectronGUIAdapter: class {} }));
vi.mock('./voice/qwen-omni', () => ({
  QwenOmniProvider: class {
    constructor(config: QwenOmniConfig) {
      mock.config = config;
      mock.callbacks = config.callbacks;
      Object.assign(this, mock.provider);
    }
  },
}));
vi.mock('./voice-brain', () => ({
  VoiceBrain: class {
    constructor(
      _controller: unknown,
      _callbacks: unknown,
      factory: (callbacks: VoiceProviderCallbacks) => unknown,
    ) {
      factory({});
    }
    forceAwake = mock.wake;
    speakRequestedReply = mock.speakReply;
    start = mock.start;
    sleep = vi.fn();
    shouldSuppressReply = () => false;
    getState() {
      return {};
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.skinId = undefined;
  mock.capture = null;
  mock.skinListeners.clear();
  vi.useFakeTimers();
  vi.stubEnv('QWEN_API_KEY', 'test');
});

it('starts with the saved companion voice instead of the default', async () => {
  mock.skinId = 'jarvis';
  const { startVoiceService } = await import('./voice-service');
  startVoiceService();
  expect(mock.config!.voice).toBe('Raymond');
});

it('routes a gaze-button answer through the brain so sleeping voice can speak it', async () => {
  const { startVoiceService } = await import('./voice-service');
  const { gazeInspector } = await import('./gaze/desktop-inspector');
  startVoiceService();
  const inspect = vi
    .spyOn(gazeInspector, 'inspect')
    .mockResolvedValue('看屏结果');
  await mock.handlers.get('cyrvis:gaze:inspect')!();
  expect(mock.speakReply).toHaveBeenCalledWith('看屏结果');
  inspect.mockRestore();
});

it('prefers QWEN_VOICE over companion skins when configured', async () => {
  vi.stubEnv('QWEN_VOICE', 'longanqian');
  mock.skinId = 'jarvis';
  const { startVoiceService } = await import('./voice-service');
  const { getCompanionStore } = await import('../store/companion');
  startVoiceService();
  expect(mock.config!.voice).toBe('longanqian');
  getCompanionStore().set('skinId', 'awesome-agumon--legeling');
  expect(mock.provider.setVoice).not.toHaveBeenCalled();
});

it('switches voice from the shared appearance selection and clears old playback without starting capture', async () => {
  const { startVoiceService } = await import('./voice-service');
  const { getCompanionStore } = await import('../store/companion');
  startVoiceService();
  mock.callbacks!.onResponseStarted!();
  getCompanionStore().set('skinId', 'awesome-agumon--legeling');
  expect(mock.provider.setVoice).toHaveBeenLastCalledWith('Evan');
  expect(mock.send).toHaveBeenCalledWith(
    'cyrvis:voice:response-stopped',
    undefined,
  );
  expect(mock.send).not.toHaveBeenCalledWith(
    'cyrvis:voice:capture-ready',
    expect.anything(),
  );
  const count = mock.provider.setVoice.mock.calls.length;
  getCompanionStore().set('skinId', 'awesome-agumon--legeling');
  expect(mock.provider.setVoice).toHaveBeenCalledTimes(count);
  getCompanionStore().set('skinId', 'starpie-stocking');
  expect(mock.provider.setVoice).toHaveBeenLastCalledWith('Katerina');
  getCompanionStore().set('skinId', 'removed');
  expect(mock.provider.setVoice).toHaveBeenLastCalledWith('Tina');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('uses renderer-owned capture without starting a second microphone', async () => {
  const { startVoiceService } = await import('./voice-service');
  startVoiceService();
  const result = await mock.handlers.get('cyrvis:voice:start')!();
  expect(result).toMatchObject({ ok: true });
  expect(mock.capture).toBeNull();
  mock.events.get('cyrvis:voice:renderer-capture-ready')!(
    undefined,
    'Built-in microphone',
  );
  expect(mock.handlers.get('cyrvis:voice:get-capture-ready')!()).toEqual({
    ready: true,
  });
  mock.handlers.get('cyrvis:voice:stop')!();
  expect(mock.handlers.get('cyrvis:voice:get-capture-ready')!()).toEqual({
    ready: false,
  });
});

it('keeps voice paused when the companion is changed', async () => {
  const { startVoiceService } = await import('./voice-service');
  const { getCompanionStore } = await import('../store/companion');
  startVoiceService();
  await mock.handlers.get('cyrvis:voice:start')!();
  mock.handlers.get('cyrvis:voice:stop')!();
  mock.start.mockClear();
  mock.send.mockClear();
  getCompanionStore().set('skinId', 'jarvis');
  expect(mock.provider.setVoice).toHaveBeenCalledWith('Raymond');
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.wake).not.toHaveBeenCalled();
  expect(mock.captureClose).not.toHaveBeenCalled();
  expect(mock.send).not.toHaveBeenCalledWith(
    'cyrvis:voice:capture-ready',
    expect.anything(),
  );
});
