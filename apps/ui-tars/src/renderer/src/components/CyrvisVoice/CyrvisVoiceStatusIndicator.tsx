import { Loader2, Mic, MicOff, Volume2 } from 'lucide-react';

import { useFloatingVoice } from './useFloatingVoice';

export function CyrvisVoiceStatusIndicator() {
  const {
    state,
    transcript,
    assistantText,
    thinking,
    playbackActive,
    micReady,
    error,
  } = useFloatingVoice();

  if (!state) {
    return null;
  }

  const speaking = state.ttsSpeaking || playbackActive;
  const listening = state.userSpeaking;
  const Icon = error ? MicOff : speaking ? Volume2 : listening ? Mic : Loader2;
  const label = error
    ? 'Voice error'
    : !micReady
      ? 'Voice off'
      : speaking
        ? 'Speaking'
        : listening
          ? 'Listening'
          : thinking
            ? 'Working'
            : state.awake
              ? 'Ready'
              : 'Sleeping';

  return (
    <div
      className="pointer-events-none fixed bottom-5 left-24 z-50 flex max-w-96 items-center gap-2 rounded-full border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
      aria-live="polite"
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${
          listening || speaking ? 'text-emerald-600' : 'text-muted-foreground'
        } ${thinking || speaking ? 'animate-pulse' : ''}`}
      />
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        {(transcript || assistantText) && (
          <p className="truncate text-muted-foreground">
            {assistantText || transcript}
          </p>
        )}
        {error && <p className="truncate text-red-600">{error}</p>}
      </div>
    </div>
  );
}
