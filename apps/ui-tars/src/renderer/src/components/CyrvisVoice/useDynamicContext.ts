import { useCallback, useEffect, useState } from 'react';

import type { CyrvisContextSnapshot } from '@shared/cyrvis';

export function useDynamicContext() {
  const [context, setContext] = useState<CyrvisContextSnapshot | null>(null);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.electron.voice.onContext((snapshot) => {
      if (!disposed) {
        setContext(snapshot);
      }
    });
    void window.electron.voice
      .getContext()
      .then((snapshot) => {
        if (!disposed) {
          setContext(snapshot);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const clearContext = useCallback(async () => {
    const snapshot = await window.electron.voice.clearContext();
    setContext(snapshot);
  }, []);

  return { context, clearContext };
}
