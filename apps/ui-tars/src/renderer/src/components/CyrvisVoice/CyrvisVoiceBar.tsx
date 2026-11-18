import {
  Ear,
  Headphones,
  Mic,
  MicOff,
  Power,
  Square,
  Volume2,
} from 'lucide-react';

import { useVoiceAudio } from './useVoiceAudio';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  starting: 'Starting',
  executing: 'Executing',
  paused: 'Paused',
  cancelling: 'Stopping',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function CyrvisVoiceBar() {
  const {
    state,
    transcript,
    assistantText,
    micReady,
    thinking,
    playbackActive,
    audioMode,
    error,
    ptt,
    start,
    stop,
    togglePtt,
    interrupt,
    toggleAudioMode,
    forceAwake,
    cancelTask,
  } = useVoiceAudio();

  const assistantSpeaking = state.ttsSpeaking || playbackActive;

  const voiceStatus = !micReady
    ? 'Voice off'
    : ptt.mode && !ptt.active
      ? 'Press Ctrl+Alt+Space to talk'
      : assistantSpeaking
        ? 'Speaking'
        : state.userSpeaking
          ? 'Listening'
          : thinking
            ? 'Thinking…'
            : state.awake
              ? 'Ready'
              : 'Sleeping';

  const taskActive = !['idle', 'done', 'failed', 'cancelled'].includes(
    state.task.status,
  );

  return (
    <div
      data-cyrvis-voice="true"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        width: 'min(720px, calc(100vw - 32px))',
      }}
    >
      <div className="rounded-xl border border-gray-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void start()}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
              micReady
                ? 'border-blue-300 bg-blue-50 text-blue-600'
                : 'border-gray-300 bg-gray-50 text-gray-500'
            }`}
            title={micReady ? 'Voice is active' : 'Start voice'}
          >
            {micReady ? (
              <Mic className="h-4 w-4" />
            ) : (
              <MicOff className="h-4 w-4" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  state.awake ? 'bg-green-500' : 'bg-gray-400'
                }`}
              />
              <span>CYRVIS</span>
              <span className="text-gray-400">·</span>
              <span className="text-gray-500 dark:text-gray-400">
                {voiceStatus}
              </span>
              {taskActive && (
                <>
                  <span className="text-gray-400">·</span>
                  <span className="text-blue-600">
                    {STATUS_LABEL[state.task.status] || state.task.status}
                    {state.task.step > 0 ? ` · step ${state.task.step}` : ''}
                  </span>
                </>
              )}
            </div>
            <div className="truncate text-xs text-gray-500 dark:text-gray-400">
              {error
                ? error
                : assistantText ||
                  transcript ||
                  (state.awake
                    ? 'Listening… say a command.'
                    : 'Say “Hello CYRVIS” to wake me.')}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void toggleAudioMode()}
              className={`flex h-8 items-center gap-1 rounded-md border px-2 text-xs ${
                audioMode === 'speaker'
                  ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
              }`}
              title="Switch output: headset (voice interruption) / speakers (Ctrl+Alt+X to interrupt)"
            >
              {audioMode === 'speaker' ? (
                <Volume2 className="h-3.5 w-3.5" />
              ) : (
                <Headphones className="h-3.5 w-3.5" />
              )}
              {audioMode === 'speaker' ? 'Speakers' : 'Headset'}
            </button>
            {ptt.mode && (
              <button
                type="button"
                onClick={() => void togglePtt()}
                className={`flex h-8 items-center gap-1 rounded-md border px-2 text-xs ${
                  ptt.active
                    ? 'border-green-300 bg-green-50 text-green-700'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
                title="Toggle push-to-talk (Ctrl+Alt+Space)"
              >
                <Mic className="h-3.5 w-3.5" />
                {ptt.active ? 'Talking' : 'Talk'}
              </button>
            )}
            {assistantSpeaking && (
              <button
                type="button"
                onClick={() => interrupt()}
                className="flex h-8 items-center gap-1 rounded-md border border-amber-200 px-2 text-xs text-amber-700 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-400 dark:hover:bg-amber-950"
                title="Stop speaking (or just start talking, or press Ctrl+Alt+X)"
              >
                <Square className="h-3.5 w-3.5" />
                Interrupt
              </button>
            )}
            <button
              type="button"
              onClick={() => forceAwake()}
              className="flex h-8 items-center gap-1 rounded-md border border-gray-200 px-2 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              title="Wake without saying the wake word"
            >
              <Ear className="h-3.5 w-3.5" />
              Wake
            </button>
            <button
              type="button"
              onClick={() => stop()}
              className="flex h-8 items-center gap-1 rounded-md border border-gray-200 px-2 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              title="Stop microphone and sleep"
            >
              <Power className="h-3.5 w-3.5" />
              Sleep
            </button>
            <button
              type="button"
              onClick={() => void cancelTask()}
              disabled={!taskActive}
              className="flex h-8 items-center gap-1 rounded-md border border-red-200 px-2 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
              title="Stop the current GUI task"
            >
              <Square className="h-3.5 w-3.5" />
              Stop task
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
