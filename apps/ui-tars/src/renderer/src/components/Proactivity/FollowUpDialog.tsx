import { BellRing, Clock3, History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { Operator } from '@main/store/types';
import { useSession } from '@renderer/hooks/useSession';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

type FollowUpPrompt = Awaited<
  ReturnType<typeof window.electron.followUp.getPending>
>;

const reasonText: Record<NonNullable<FollowUpPrompt>['reason'], string> = {
  launch: '欢迎回来',
  activate: '再次见到你',
  resume: '电脑已从休眠中恢复',
  unlock: '电脑已解锁',
  idle: '你已经停下来一会儿了',
};

export function FollowUpDialog() {
  const navigate = useNavigate();
  const { sessions, loading, refreshSessions, setActiveSession } = useSession();
  const [prompt, setPrompt] = useState<FollowUpPrompt>(null);

  useEffect(() => {
    void refreshSessions();
    void window.electron.followUp.getPending().then(setPrompt);
    return window.electron.followUp.onPrompt(setPrompt);
  }, []);

  const previousSession = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0],
    [sessions],
  );

  useEffect(() => {
    if (!loading && prompt && !previousSession) {
      void window.electron.followUp.complete(prompt.id);
      setPrompt(null);
    }
  }, [loading, previousSession, prompt]);

  const close = useCallback(async () => {
    if (prompt) await window.electron.followUp.complete(prompt.id);
    setPrompt(null);
  }, [prompt]);

  const snooze = useCallback(async () => {
    if (prompt) await window.electron.followUp.snooze(prompt.id);
    setPrompt(null);
  }, [prompt]);

  const resume = useCallback(async () => {
    if (!prompt || !previousSession) return;
    await setActiveSession(previousSession.id);
    await window.electron.followUp.complete(prompt.id);
    setPrompt(null);

    const isRemote = previousSession.meta.operator !== Operator.LocalComputer;
    navigate(isRemote ? '/free-remote' : '/local', {
      state: {
        ...previousSession.meta,
        sessionId: previousSession.id,
        from: 'history',
      },
    });
  }, [navigate, previousSession, prompt, setActiveSession]);

  if (!prompt || loading || !previousSession) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && void close()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <div className="mb-2 flex items-center gap-2 text-blue-600">
            <BellRing className="h-5 w-5" />
            <span className="text-sm font-medium">主动跟进</span>
          </div>
          {prompt.greeting && (
            <p className="text-base leading-relaxed text-foreground">
              {prompt.greeting}
            </p>
          )}
          <DialogTitle>
            {reasonText[prompt.reason]}，
            {prompt.reason === 'idle'
              ? '建议继续推进最近的任务'
              : '要继续上次的任务吗？'}
          </DialogTitle>
          <DialogDescription>
            {prompt.reason === 'idle'
              ? '检测到 10 秒没有操作。我可以帮你回到最近的工作，并从上次停下的位置继续。'
              : '我找到了最近一次对话，可以帮你从上次停下的位置继续。'}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/40 p-4">
          <div className="flex items-start gap-3">
            <History className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate font-medium">{previousSession.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                上次更新：{new Date(previousSession.updatedAt).toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => void close()}>
            暂不继续
          </Button>
          <Button variant="outline" onClick={() => void snooze()}>
            <Clock3 className="mr-2 h-4 w-4" />
            30 分钟后提醒
          </Button>
          <Button onClick={() => void resume()}>继续上次任务</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
