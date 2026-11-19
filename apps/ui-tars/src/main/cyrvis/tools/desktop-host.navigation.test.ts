import { beforeEach, expect, it, vi } from 'vitest';
import { LocalDesktopHost } from './desktop-host';
import { openApp, openUrl, openSearch } from '../desktop-actions';

vi.mock('../desktop-actions', () => ({
  openApp: vi.fn(async (app: string) => ({ app, target: null })),
  openUrl: vi.fn(async (url: string) => url),
  openSearch: vi.fn(async (url: string) => url),
}));

beforeEach(() => vi.clearAllMocks());

it.each([
  ['记事本', 'notepad'],
  ['资源管理器', 'explorer'],
  ['vscode', 'vscode'],
  ['谷歌浏览器', 'chrome'],
])('uses the shared launcher for %s with a target', async (alias, app) => {
  await new LocalDesktopHost().launchApplication(alias, 'example');
  expect(openApp).toHaveBeenCalledExactlyOnceWith(app, 'example');
});

it('keeps browser focus and native search behavior in the shared host', async () => {
  const host = new LocalDesktopHost();
  await host.openUrl('https://example.com');
  await host.openSearch('https://www.google.com/search?q=test');
  expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://example.com');
  expect(openSearch).toHaveBeenCalledExactlyOnceWith(
    'https://www.google.com/search?q=test',
  );
});

it('propagates launcher errors rather than reporting an opened app', async () => {
  vi.mocked(openApp).mockRejectedValueOnce(new Error('Launch failed'));
  await expect(
    new LocalDesktopHost().launchApplication('notepad'),
  ).rejects.toThrow('Launch failed');
});
