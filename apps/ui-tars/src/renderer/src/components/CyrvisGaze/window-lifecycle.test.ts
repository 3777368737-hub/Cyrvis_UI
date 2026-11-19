// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Separate Electron windows have independent locations. MemoryRouter lets
// two React roots model them without sharing this test document's hash events.
vi.mock('react-router', async (original) => {
  const router = await original<typeof import('react-router')>();
  return {
    ...router,
    HashRouter: ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        router.MemoryRouter,
        { initialEntries: [location.hash.slice(1) || '/'] },
        children,
      ),
  };
});
vi.mock('@renderer/components/CyrvisVoice/VoiceRuntime', () => ({
  VoiceRuntime: () => null,
}));
vi.mock('@/renderer/src/components/SideBar/app-sidebar', () => ({
  AppSidebar: () => null,
}));
vi.mock('@renderer/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  SidebarInset: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  SidebarTrigger: () => null,
}));
vi.mock('sonner', () => ({ Toaster: () => null }));
vi.mock('../../pages/home', () => ({ default: () => null }));
vi.mock('../../pages/local', () => ({ default: () => null }));
vi.mock('../../pages/remote/free', () => ({ default: () => null }));
vi.mock('../../pages/widget', () => ({ default: () => null }));
vi.mock('../../pages/history', () => ({ default: () => null }));
vi.mock('../CyrvisCompanion/Companion', () => ({ default: () => null }));
import App from '../../App';

const roots: Root[] = [];
async function renderWindow(path: string) {
  location.hash = path;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(App));
  });
  return { root, container };
}
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  document.body.innerHTML = '';
});

describe('gaze camera ownership across Electron windows', () => {
  it('closing a task widget cannot end the workbench camera or clear shared gaze', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const invoke = vi.fn(async () => ({ enabled: false, phase: 'idle' }));
    (window as any).electron = { ipcRenderer: { invoke } };
    window.webgazer = { end: vi.fn() };
    const main = await renderWindow('/');
    expect(main.container.textContent).toContain('眼动');
    const widget = await renderWindow('/widget');
    expect(widget.container.textContent).not.toContain('眼动');
    await act(async () => {
      widget.root.unmount();
    });
    roots.splice(roots.indexOf(widget.root), 1);
    expect(window.webgazer.end).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      'cyrvis:gaze:inspect-enabled',
      false,
    );
    expect(invoke).not.toHaveBeenCalledWith('cyrvis:gaze:update', null);
    const companion = await renderWindow('/companion');
    expect(companion.container.textContent).not.toContain('眼动');
    await act(async () => {
      companion.root.unmount();
    });
    roots.splice(roots.indexOf(companion.root), 1);
    expect(window.webgazer.end).not.toHaveBeenCalled();
  });
});
