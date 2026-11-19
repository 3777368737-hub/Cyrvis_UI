import { describe, expect, it } from 'vitest';

import { UserContextStore } from './user-context';

describe('UserContextStore', () => {
  it('tracks transient user context, recent actions, and task state', () => {
    let now = 1_000;
    const store = new UserContextStore({
      now: () => now,
      windowTtlMs: 1_000,
      focusTtlMs: 500,
      selectedTextTtlMs: 500,
    });

    store.setActiveWindow({
      pid: 42,
      process: 'Code',
      title: 'project - Visual Studio Code',
      handle: 100,
    });
    store.setActiveApplication('application:registry:vscode');
    store.setFocusedControl({
      name: 'Search',
      role: 'Edit',
      automationId: 'search',
    });
    store.setSelectedText('const value = 1');
    store.recordUserText('查看当前窗口');
    store.recordAction({
      toolId: 'window.focus',
      ok: true,
      speech: '已聚焦窗口。',
      resourceId: 'application:registry:vscode',
    });
    store.recordTaskEvent({
      type: 'task_started',
      taskId: 'task-1',
      instruction: '检查当前项目',
      source: 'voice',
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.activeWindow?.value.process).toBe('Code');
    expect(snapshot.activeApplication?.value).toBe(
      'application:registry:vscode',
    );
    expect(snapshot.focusedControl?.value.name).toBe('Search');
    expect(snapshot.selectedText?.value).toBe('const value = 1');
    expect(snapshot.recentActions[0]).toMatchObject({
      toolId: 'window.focus',
      ok: true,
    });
    expect(snapshot.recentResourceIds[0]).toBe('application:registry:vscode');
    expect(snapshot.currentTask).toMatchObject({
      taskId: 'task-1',
      instruction: '检查当前项目',
    });

    now = 1_600;
    const expired = store.getSnapshot();
    expect(expired.focusedControl).toBeNull();
    expect(expired.selectedText).toBeNull();
    expect(expired.activeWindow).not.toBeNull();
  });

  it('does not retain secrets from speech or selected text', () => {
    const store = new UserContextStore({ now: () => 1_000 });
    store.recordUserText('记住 api_key = sk-secret-value');
    // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
    store.setSelectedText('password: super-secret');

    const snapshot = store.getSnapshot();
    expect(snapshot.recentRequest).toBeNull();
    expect(snapshot.selectedText).toBeNull();
  });
});
