import { ConversationMessages } from '@renderer/components/Conversation/ConversationMessages';
import { NewChatButton } from '@renderer/components/Conversation/NewChatButton';
import { useLocation, useNavigate } from 'react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '@renderer/hooks/useStore';
import { useSession } from '@renderer/hooks/useSession';
import { ErrorMessage } from '../../components/RunMessages/Messages';
import { api } from '../../api';
import { StatusEnum } from '@ui-tars/shared/types';
import { RouterState } from '../../typings';
import ChatInput from '../../components/ChatInput';
import { NavDialog } from '../../components/AlertDialog/navDialog';
import {
  checkVLMSettings,
  LocalSettingsDialog,
} from '../../components/Settings/local';
import { sleep } from '@ui-tars/shared/utils';
import { Operator } from '@main/store/types';

const LocalOperator = () => {
  const location = useLocation();
  const state = location.state as Partial<RouterState> | null;
  const operator = state?.operator ?? Operator.LocalComputer;
  const navigate = useNavigate();

  const { status, messages = [], thinking, errorMsg } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const { setActiveSession, chatMessages } = useSession();
  const [pendingAction, setPendingAction] = useState<'back' | null>(null);
  const [isNavDialogOpen, setNavDialogOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [sessionId, setSessionId] = useState(state?.sessionId || '');

  useEffect(() => {
    setSessionId(state?.sessionId || '');
    const update = async () => {
      if (state?.sessionId) {
        await setActiveSession(state.sessionId);
      }
    };
    update();
  }, [location.key]);

  useEffect(() => {
    setTimeout(() => {
      containerRef.current?.scrollIntoView(false);
    }, 100);
  }, [messages, thinking, errorMsg]);

  // check status before nav
  const needsConfirm =
    status === StatusEnum.RUNNING ||
    status === StatusEnum.CALL_USER ||
    status === StatusEnum.PAUSE;

  const onBack = useCallback(async () => {
    navigate('/');
  }, []);

  const handleBack = useCallback(() => {
    if (needsConfirm) {
      setPendingAction('back');
      setNavDialogOpen(true);
    } else {
      onBack();
    }
  }, [needsConfirm]);

  const onConfirm = useCallback(async () => {
    await api.stopRun();
    await api.clearHistory();

    if (pendingAction === 'back') {
      await onBack();
    }
    setPendingAction(null);
    setNavDialogOpen(false);
  }, [pendingAction]);

  const onCancel = useCallback(() => {
    setPendingAction(null);
    setNavDialogOpen(false);
  }, []);

  const handleLocalSettingsSubmit = async () => {
    setLocalOpen(false);

    await sleep(200);
  };

  const handleLocalSettingsClose = () => {
    setLocalOpen(false);
  };

  const checkVLM = async () => {
    const hasVLM = await checkVLMSettings();

    if (hasVLM) {
      return true;
    } else {
      setLocalOpen(true);
      return false;
    }
  };

  const displayStatus = thinking ? StatusEnum.RUNNING : status;
  const title =
    chatMessages.find(
      (message) => message.from === 'human' && message.value !== '<image>',
    )?.value || 'New chat';
  return (
    <article className="cyrvis-conversation">
      <header className="cyrvis-conversation-header">
        <div className="cyrvis-chat-heading">
          <button
            type="button"
            className="cyrvis-icon-button"
            onClick={handleBack}
            aria-label="Back to home"
          >
            ←
          </button>
          <h1>{title}</h1>
        </div>
        <NewChatButton />
      </header>
      <section className="cyrvis-chat-body" aria-label="Conversation">
        <div className="cyrvis-message-scroll">
          <div className="cyrvis-thread" ref={containerRef}>
            {!chatMessages.length && !thinking && (
              <div className="cyrvis-chat-empty">
                <h2>What can I help with?</h2>
                <p>Ask a question or give Cyrvis a task.</p>
              </div>
            )}
            <ConversationMessages
              messages={chatMessages}
              status={displayStatus}
            />
            {errorMsg && <ErrorMessage text={errorMsg} />}
          </div>
        </div>
        <div className="cyrvis-composer-area">
          <ChatInput
            key={location.key}
            disabled={false}
            operator={operator}
            sessionId={sessionId}
            onSessionCreated={setSessionId}
            checkBeforeRun={checkVLM}
          />
        </div>
      </section>
      <NavDialog
        open={isNavDialogOpen}
        onOpenChange={onCancel}
        onConfirm={onConfirm}
      />
      <LocalSettingsDialog
        isOpen={localOpen}
        onSubmit={handleLocalSettingsSubmit}
        onClose={handleLocalSettingsClose}
      />
    </article>
  );
};

export default LocalOperator;
