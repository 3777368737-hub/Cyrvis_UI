import { beforeEach, expect, it, vi } from 'vitest';
import { StatusEnum } from '@ui-tars/shared/types';
import type { AppState } from '@main/store/types';
import { runAgent } from '@main/services/runAgent';
import { ElectronGUIAdapter } from './gui-adapter';

const mock = vi.hoisted(() => ({
  state: {} as AppState,
  listeners: new Set<(next: AppState, prev: AppState) => void>(),
}));
vi.mock('@main/store/create', () => ({
  store: {
    getState: () => mock.state,
    setState: (next: AppState) => {
      const prev = mock.state;
      mock.state = next;
      for (const listener of mock.listeners) listener(next, prev);
    },
    subscribe: (listener: (next: AppState, prev: AppState) => void) => {
      mock.listeners.add(listener);
      return () => mock.listeners.delete(listener);
    },
  },
}));
vi.mock('@main/services/runAgent', () => ({ runAgent: vi.fn() }));
vi.mock('@main/ipcRoutes/agent', () => ({
  GUIAgentManager: { getInstance: () => ({ getAgent: () => null }) },
}));
vi.mock('@main/window', () => ({ showCompanion: vi.fn() }));
vi.mock('@main/window/ScreenMarker', () => ({
  closeOverlay: vi.fn(),
  hideScreenWaterFlow: vi.fn(),
}));
vi.mock('./gaze/context', () => ({ desktopGazeExecutionHint: () => '' }));

beforeEach(() => {
  mock.listeners.clear();
  mock.state = {
    status: StatusEnum.INIT,
    thinking: false,
    messages: [],
    errorMsg: null,
  } as unknown as AppState;
});

it('forwards the SDK error on the first terminal update before a later onError callback fills errorMsg', async () => {
  vi.mocked(runAgent).mockImplementation(async (setState, getState) => {
    setState({ ...getState(), status: StatusEnum.RUNNING });
    // This is the real SDK callback order: onData(ERROR), then onError.
    setState({
      ...getState(),
      status: StatusEnum.ERROR,
      restUserData: {
        error: new Error('Request timed out.'),
      } as AppState['restUserData'],
    });
    setState({
      ...getState(),
      errorMsg: JSON.stringify({ message: 'Request timed out.' }),
    });
  });
  const callbacks = {
    onStarted: vi.fn(),
    onStep: vi.fn(),
    onDone: vi.fn(),
    onFailed: vi.fn(),
    onCancelled: vi.fn(),
    onPaused: vi.fn(),
    onResumed: vi.fn(),
    onNeedsUser: vi.fn(),
  };
  await new ElectronGUIAdapter().start('播放这个歌单', callbacks);
  expect(callbacks.onStarted).toHaveBeenCalledOnce();
  expect(callbacks.onFailed).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('请求超时'),
  );
  expect(callbacks.onDone).not.toHaveBeenCalled();
  expect(mock.state.thinking).toBe(false);
  expect(mock.listeners.size).toBe(0);
});
