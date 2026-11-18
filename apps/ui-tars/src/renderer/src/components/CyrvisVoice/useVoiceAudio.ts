import { useCallback, useEffect, useRef, useState } from 'react';

import { WavStreamPlayer } from './wav-player';
import { PcmStreamPlayer } from './pcm-player';

// Only one voice pipeline may own mic capture and playback. A stale HMR or
// duplicate mount must not create a second audio path.
let voiceOwner: symbol | null = null;

export interface VoiceTaskSnapshot {
  taskId: string | null;
  status: string;
  instruction: string | null;
  step: number;
  lastSummary: string | null;
  error: string | null;
}

export interface VoiceUiState {
  awake: boolean;
  userSpeaking: boolean;
  ttsSpeaking: boolean;
  lastUserText: string;
  task: VoiceTaskSnapshot;
}

const EMPTY_STATE: VoiceUiState = {
  awake: false,
  userSpeaking: false,
  ttsSpeaking: false,
  lastUserText: '',
  task: {
    taskId: null,
    status: 'idle',
    instruction: null,
    step: 0,
    lastSummary: null,
    error: null,
  },
};

const WORKLET_CODE = `
class CyrvisPcmWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input && input.length) {
      this.port.postMessage(input.slice(0));
    }
    return true;
  }
}
registerProcessor('cyrvis-pcm', CyrvisPcmWorklet);
`;

const resampleTo16k = (input: Float32Array, fromRate: number) => {
  if (fromRate === 16000) {
    return input;
  }
  const ratio = fromRate / 16000;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
};

const floatToInt16 = (input: Float32Array) => {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
};

export function useVoiceAudio() {
  const [state, setState] = useState<VoiceUiState>(EMPTY_STATE);
  const [transcript, setTranscript] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [micReady, setMicReady] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const [playbackActive, setPlaybackActive] = useState(false);
  const [audioMode, setAudioModeState] = useState<'headset' | 'speaker'>(
    'speaker',
  );
  const [error, setError] = useState<string | null>(null);
  const [ptt, setPtt] = useState<{ active: boolean; mode: boolean }>({
    active: false,
    mode: true,
  });
  const ownerRef = useRef(Symbol('cyrvis-voice-instance'));

  const captureContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const pendingSamplesRef = useRef<number[]>([]);
  const playerRef = useRef<WavStreamPlayer | PcmStreamPlayer | null>(null);
  const outputDeviceIdRef = useRef<string | null>(null);
  const playbackChunksRef = useRef(0);
  const assistantSpeakingRef = useRef(false);
  const assistantIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const bargeInMsRef = useRef(0);
  const bargePeakRef = useRef(0);
  const lastMicAverageRef = useRef(0);
  const lastBargeDiagRef = useRef(0);
  const preSpeechBufferRef = useRef<number[]>([]);
  const startedRef = useRef(false);

  const finishPlayback = useCallback(() => {
    assistantSpeakingRef.current = false;
    bargeInMsRef.current = 0;
    preSpeechBufferRef.current = [];
    setPlaybackActive(false);
    if (assistantIdleTimerRef.current) {
      clearTimeout(assistantIdleTimerRef.current);
      assistantIdleTimerRef.current = null;
    }
    window.electron.voice.notifyPlaybackIdle();
  }, []);

  const stopPlayback = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      player.stop();
    }
    setPlaybackActive(false);
  }, []);

  const playPcm = useCallback(
    (pcm16: Int16Array) => {
      if (!pcm16.length) {
        return;
      }

      if (!playerRef.current) {
        const Player =
          window.platform === 'darwin' ? PcmStreamPlayer : WavStreamPlayer;
        const player = new Player(
          () => {
            // A stopped/replaced player must never reopen the new reply's mic.
            if (playerRef.current === player) finishPlayback();
          },
          (error) => {
            const detail =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            console.warn('[cyrvis] audio player error', detail);
            setError(`Audio playback failed: ${detail}`);
          },
        );
        playerRef.current = player;
        if (outputDeviceIdRef.current) {
          void player.setSinkId(outputDeviceIdRef.current).catch((error) => {
            console.warn('[cyrvis] set playback output failed', error);
          });
        }
        console.log(
          '[cyrvis] stream player created',
          window.platform === 'darwin' ? 'scheduled PCM' : 'WAV',
        );
      }

      assistantSpeakingRef.current = true;
      setPlaybackActive(true);
      if (assistantIdleTimerRef.current) {
        clearTimeout(assistantIdleTimerRef.current);
        assistantIdleTimerRef.current = null;
      }

      playbackChunksRef.current += 1;
      if (
        playbackChunksRef.current <= 2 ||
        playbackChunksRef.current % 50 === 0
      ) {
        console.log('[cyrvis] playback chunk', {
          samples: pcm16.length,
          chunk: playbackChunksRef.current,
        });
      }
      playerRef.current.play(pcm16);
    },
    [finishPlayback],
  );

  const flushPending = useCallback((samples: Float32Array) => {
    let micSum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      micSum += Math.abs(samples[i]);
    }
    lastMicAverageRef.current = samples.length ? micSum / samples.length : 0;
    (window as unknown as { __cyrvisMicAvg?: number }).__cyrvisMicAvg =
      lastMicAverageRef.current;

    // Renderer-side half-duplex gate. While the assistant is speaking we do
    // not send samples, but we still watch the local microphone for a
    // sustained user voice. If detected, stop playback and hand the buffered
    // speech to the provider as a barge-in.
    if (assistantSpeakingRef.current) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        sum += Math.abs(samples[i]);
      }
      const average = samples.length ? sum / samples.length : 0;
      const chunkMs = (samples.length / 16000) * 1000;

      bargePeakRef.current = Math.max(bargePeakRef.current, average);
      const nowMs = Date.now();
      if (nowMs - lastBargeDiagRef.current >= 1000) {
        lastBargeDiagRef.current = nowMs;
        const track = mediaStreamRef.current?.getAudioTracks()[0];
        const settings = track?.getSettings();
        console.log(
          `[cyrvis] barge monitor avg=${Math.round(average)} peak=${Math.round(
            bargePeakRef.current,
          )} ms=${Math.round(bargeInMsRef.current)} sources=${
            playerRef.current?.isActive ? 1 : 0
          } trackMuted=${track?.muted ?? 'none'} track=${
            track?.readyState ?? 'none'
          } ec=${settings?.echoCancellation} ns=${
            settings?.noiseSuppression
          } agc=${settings?.autoGainControl} capture=${
            captureContextRef.current?.state ?? 'none'
          } playback=${playerRef.current ? 'wav' : 'none'}`,
        );
        bargePeakRef.current = 0;
      }

      const preSpeech = preSpeechBufferRef.current;
      for (let i = 0; i < samples.length; i += 1) {
        preSpeech.push(samples[i]);
      }
      if (preSpeech.length > 9600) {
        preSpeech.splice(0, preSpeech.length - 9600);
      }

      // The user's real "停" was measured at ~359 average in the main VAD,
      // and a single syllable lasts ~200 ms. Match the main VAD (250) and use
      // a short 100 ms sustain; echo cancellation keeps TTS out of this path.
      if (average > 800) {
        bargeInMsRef.current += chunkMs;
      } else {
        bargeInMsRef.current = Math.max(0, bargeInMsRef.current - chunkMs);
      }

      if (bargeInMsRef.current >= 150) {
        console.log(
          `[cyrvis] barge-in detected avg=${Math.round(
            average,
          )} peak=${Math.round(bargePeakRef.current)}`,
        );
        bargeInMsRef.current = 0;
        bargePeakRef.current = 0;
        assistantSpeakingRef.current = false;
        if (assistantIdleTimerRef.current) {
          clearTimeout(assistantIdleTimerRef.current);
          assistantIdleTimerRef.current = null;
        }
        stopPlayback();
        window.electron.voice.bargeIn();

        const buffered = preSpeechBufferRef.current.splice(0);
        for (let i = 0; i < buffered.length; i += 320) {
          const pcm = floatToInt16(
            Float32Array.from(buffered.slice(i, i + 320)),
          );
          window.electron.voice.sendAudio(pcm.buffer as ArrayBuffer);
        }
        return;
      }

      pendingSamplesRef.current = [];
      return;
    }

    const pending = pendingSamplesRef.current;
    for (let i = 0; i < samples.length; i += 1) {
      pending.push(samples[i]);
    }
    while (pending.length >= 320) {
      const chunk = pending.splice(0, 320);
      const pcm = floatToInt16(Float32Array.from(chunk));
      window.electron.voice.sendAudio(pcm.buffer as ArrayBuffer);
    }
  }, []);

  const applyOutput = useCallback(async (needle: string) => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const output = devices.find(
      (device) =>
        device.kind === 'audiooutput' &&
        device.label.toLowerCase().includes(needle.toLowerCase()),
    );
    if (!output) {
      console.warn('[cyrvis] output not found', needle);
      return null;
    }
    outputDeviceIdRef.current = output.deviceId;
    const player = playerRef.current;
    if (player) {
      await player.setSinkId(output.deviceId);
    }
    console.log(
      '[cyrvis] output applied',
      output.label,
      output.deviceId.slice(0, 8),
      player ? 'player' : 'stored',
    );
    return `${output.label} (${output.deviceId.slice(0, 8)})`;
  }, []);

  const resetOutput = useCallback(async () => {
    outputDeviceIdRef.current = null;
    const player = playerRef.current;
    if (player) {
      try {
        await player.setSinkId('default');
      } catch (error) {
        console.warn('[cyrvis] reset output failed', error);
      }
    }
  }, []);

  // Audio mode controls echo handling, not a hard-coded Windows output device.
  const applyAudioMode = useCallback(
    (_mode: 'headset' | 'speaker') => {
      void resetOutput();
    },
    [resetOutput],
  );

  const toggleAudioMode = useCallback(async () => {
    const next = audioMode === 'speaker' ? 'headset' : 'speaker';
    setAudioModeState(next);
    await window.electron.voice.setAudioMode(next);
  }, [audioMode]);

  const ensureMic = useCallback(async () => {
    if (startedRef.current && mediaStreamRef.current) {
      return;
    }

    setError(null);
    console.log('[cyrvis] requesting microphone');
    // Echo cancellation suppresses near-end speech while the assistant is
    // playing ("double-talk" suppression), which made the local barge-in
    // detector see almost silence. The user is on a headset, so leakage is
    // low; keep AGC but disable AEC/NS so "停" is measurable during playback.
    const baseAudio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: false,
      // Noise suppression keeps the Bluetooth mic's 260-486 room-noise floor
      // below the VAD threshold; without it every reply was self-cancelled.
      noiseSuppression: true,
      autoGainControl: true,
    };
    let stream = await navigator.mediaDevices.getUserMedia({
      audio: baseAudio,
    });
    let label = stream.getAudioTracks()[0]?.label || 'default';

    // The default/communications endpoints are Windows aliases, not the real
    // USB endpoint. On this headset the alias delivers pure silence while
    // playback is active, so always switch to an explicit physical device.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput');
      console.log(
        '[cyrvis] audio inputs',
        JSON.stringify(
          inputs.map((device) => ({
            label: device.label,
            deviceId: device.deviceId,
          })),
        ),
      );
      const currentDeviceId = stream
        .getAudioTracks()[0]
        ?.getSettings().deviceId;
      const physical = inputs.find(
        (device) =>
          device.deviceId &&
          device.deviceId !== 'default' &&
          device.deviceId !== 'communications' &&
          device.label &&
          !/todesk|virtual|stereo mix|line in/i.test(device.label),
      );
      if (physical && physical.deviceId !== currentDeviceId) {
        stream.getTracks().forEach((track) => track.stop());
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...baseAudio,
            deviceId: { exact: physical.deviceId },
          },
        });
        label = stream.getAudioTracks()[0]?.label || physical.label;
        console.log('[cyrvis] using physical microphone', label);
      } else if (/todesk|virtual|stereo mix|line in/i.test(label)) {
        // Never fall back to a virtual/loopback device: it carries the
        // assistant's own TTS and produces empty or self-triggered commands.
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(
          'No physical microphone found. Connect the headset microphone and restart voice.',
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('No physical microphone')
      ) {
        throw error;
      }
      console.warn('[cyrvis] preferred microphone failed', error);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: baseAudio,
      });
      label = stream.getAudioTracks()[0]?.label || 'default';
    }

    console.log('[cyrvis] microphone stream', label);
    mediaStreamRef.current = stream;

    // Use the device's native rate for both capture and playback. Creating a
    // 16 kHz capture context and a 24 kHz playback context on the same USB
    // headset makes Windows reconfigure the device when playback starts; the
    // capture stream then delivers pure silence for the whole reply, which is
    // exactly what the barge monitor showed (avg=0 peak=0).
    const captureContext = new AudioContext();
    captureContextRef.current = captureContext;
    await captureContext.resume();

    const source = captureContext.createMediaStreamSource(stream);
    let captureNode: AudioNode;

    try {
      const workletUrl = URL.createObjectURL(
        new Blob([WORKLET_CODE], { type: 'application/javascript' }),
      );
      try {
        await captureContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      const worklet = new AudioWorkletNode(captureContext, 'cyrvis-pcm');
      workletNodeRef.current = worklet;
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const resampled = resampleTo16k(event.data, captureContext.sampleRate);
        flushPending(resampled);
      };
      captureNode = worklet;
      console.log('[cyrvis] audio worklet ready');
    } catch (error) {
      console.warn(
        '[cyrvis] audio worklet failed, falling back to ScriptProcessor',
        error,
      );
      const processor = captureContext.createScriptProcessor(1024, 1, 1);
      scriptProcessorRef.current = processor;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        flushPending(resampleTo16k(input, captureContext.sampleRate));
      };
      captureNode = processor;
      console.log('[cyrvis] script processor ready');
    }

    const mute = captureContext.createGain();
    mute.gain.value = 0;
    source.connect(captureNode);
    captureNode.connect(mute);
    mute.connect(captureContext.destination);

    // Assistant playback is created lazily on the first audio chunk by
    // WavStreamPlayer: PCM -> MP3 -> MediaSource -> plain <audio>. Web Audio
    // playback silences the Windows microphone; a media element does not.

    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      // Dev-only probe: route assistant playback to another output device.
      (
        window as unknown as {
          __cyrvisSetOutput?: (needle: string) => Promise<string>;
        }
      ).__cyrvisSetOutput = async (needle: string) => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const output = devices.find(
          (device) =>
            device.kind === 'audiooutput' &&
            device.label.toLowerCase().includes(needle.toLowerCase()),
        );
        if (!output) {
          return `output not found: ${needle}`;
        }
        outputDeviceIdRef.current = output.deviceId;
        const player = playerRef.current;
        if (player) {
          await player.setSinkId(output.deviceId);
          return `${output.label} (${output.deviceId.slice(0, 8)})`;
        }
        return `stored ${output.label} (${output.deviceId.slice(0, 8)})`;
      };

      // Dev-only isolation probe: play a plain WAV file (no Web Audio) and
      // read the microphone level, to see whether ANY playback silences the
      // capture path or only AudioContext-based playback.
      (
        window as unknown as {
          __cyrvisMicLevel?: () => number;
          __cyrvisPlayTone?: (
            needle: string,
            seconds?: number,
          ) => Promise<string>;
        }
      ).__cyrvisMicLevel = () => lastMicAverageRef.current;
      (
        window as unknown as {
          __cyrvisPlayTone?: (
            needle: string,
            seconds?: number,
          ) => Promise<string>;
        }
      ).__cyrvisPlayTone = async (needle: string, seconds = 4) => {
        const sampleRate = 48000;
        const frames = sampleRate * seconds;
        const buffer = new ArrayBuffer(44 + frames * 2);
        const view = new DataView(buffer);
        const write = (offset: number, text: string) => {
          for (let i = 0; i < text.length; i += 1) {
            view.setUint8(offset + i, text.charCodeAt(i));
          }
        };
        write(0, 'RIFF');
        view.setUint32(4, 36 + frames * 2, true);
        write(8, 'WAVE');
        write(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        write(36, 'data');
        view.setUint32(40, frames * 2, true);
        for (let i = 0; i < frames; i += 1) {
          const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3;
          view.setInt16(44 + i * 2, sample * 0x7fff, true);
        }
        const url = URL.createObjectURL(
          new Blob([buffer], { type: 'audio/wav' }),
        );
        const devices = await navigator.mediaDevices.enumerateDevices();
        const output = devices.find(
          (device) =>
            device.kind === 'audiooutput' &&
            device.label.toLowerCase().includes(needle.toLowerCase()),
        );
        const audio = new Audio(url);
        const sinkable = audio as HTMLAudioElement & {
          setSinkId?: (deviceId: string) => Promise<void>;
        };
        if (output && sinkable.setSinkId) {
          await sinkable.setSinkId(output.deviceId);
        }
        (
          window as unknown as { __cyrvisTestAudio?: HTMLAudioElement }
        ).__cyrvisTestAudio = audio;
        await audio.play();
        return output?.label ?? 'default output';
      };
    }

    startedRef.current = true;
    setMicReady(true);
    console.log('[cyrvis] microphone ready', {
      sampleRate: captureContext.sampleRate,
    });
  }, [flushPending]);

  const start = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setError(null);
    try {
      if (window.electron.voice.externalCapture) {
        // Capture lives in a hidden renderer; the main window only plays TTS.
        setMicReady(false);
      } else {
        await ensureMic();
      }
      const result = await window.electron.voice.start();
      if (!result?.ok) throw new Error(result?.error || 'Voice is unavailable');
      setError(null);
      if (result.state) setState(result.state);
      if (window.electron.voice.externalCapture)
        setMicReady(Boolean(result.captureReady));
    } catch (err) {
      const name = err instanceof DOMException ? err.name : 'Error';
      const detail = err instanceof Error ? err.message : String(err);
      const message = `${name}: ${detail}`;
      console.error('[cyrvis] voice start failed', message);
      setError(message);
      setMicReady(false);
      startedRef.current = false;
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }, [ensureMic]);

  const stopCapture = useCallback(async () => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    scriptProcessorRef.current?.disconnect();
    scriptProcessorRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    const player = playerRef.current;
    playerRef.current = null;
    player?.stop();
    await captureContextRef.current?.close();
    captureContextRef.current = null;
    pendingSamplesRef.current = [];
    startedRef.current = false;
    setMicReady(false);
  }, []);

  const restartMic = useCallback(async () => {
    await stopCapture();
    try {
      await ensureMic();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[cyrvis] microphone restart failed', message);
      setError(message);
    }
  }, [ensureMic, stopCapture]);

  const stop = useCallback(async () => {
    setThinking(false);
    stopPlayback();
    finishPlayback();
    await stopCapture();
    await window.electron.voice.stop();
  }, [finishPlayback, stopCapture, stopPlayback]);

  useEffect(() => {
    if (voiceOwner) {
      console.warn('[cyrvis] duplicate voice instance ignored');
      return;
    }
    voiceOwner = ownerRef.current;
    const owner = ownerRef.current;

    void window.electron.voice.getPtt().then((state) => setPtt(state));
    void window.electron.voice.getAudioMode().then(({ mode }) => {
      setAudioModeState(mode);
      applyAudioMode(mode);
    });

    const cleanups = [
      window.electron.voice.onPttState((state) => setPtt(state)),
      window.electron.voice.onAudio(playPcm),
      window.electron.voice.onSpeechStarted(() => {
        setTranscript('');
        setAssistantText('');
        stopPlayback();
      }),
      window.electron.voice.onSpeechStopped(() => undefined),
      window.electron.voice.onThinking(() => setThinking(true)),
      window.electron.voice.onResponseStarted(() => {
        stopPlayback();
        setAssistantText('');
        setThinking(false);
        bargeInMsRef.current = 0;
        preSpeechBufferRef.current = [];
        playbackChunksRef.current = 0;
        assistantSpeakingRef.current = true;
        // A capture AudioContext can be auto-suspended when another context
        // starts; make sure it is running before we listen for barge-in.
        void captureContextRef.current?.resume();
        if (assistantIdleTimerRef.current) {
          clearTimeout(assistantIdleTimerRef.current);
        }
        // Watchdog for a text-only response that produces no audio chunks.
        assistantIdleTimerRef.current = setTimeout(() => {
          assistantIdleTimerRef.current = null;
          assistantSpeakingRef.current = false;
          window.electron.voice.notifyPlaybackIdle();
        }, 10_000);
      }),
      window.electron.voice.onResponseStopped(() => {
        setThinking(false);
        setPlaybackActive(false);
        assistantSpeakingRef.current = false;
        bargeInMsRef.current = 0;
        preSpeechBufferRef.current = [];
        if (assistantIdleTimerRef.current) {
          clearTimeout(assistantIdleTimerRef.current);
          assistantIdleTimerRef.current = null;
        }
        stopPlayback();
        finishPlayback();
      }),
      window.electron.voice.onResponseDone(() => {
        // No audio chunks means this was a tool-call/text-only response; the
        // mic can reopen now instead of waiting for the 10s watchdog.
        console.log(
          `[cyrvis] response done (renderer) chunks=${
            playbackChunksRef.current
          } speaking=${assistantSpeakingRef.current}`,
        );
        if (playbackChunksRef.current === 0) {
          finishPlayback();
          return;
        }
        // Generation can finish seconds before audio playback. Drain every
        // queued sample before finishPlayback reopens the microphone.
        playerRef.current?.finish();
      }),
      window.electron.voice.onTranscript(({ text }) => {
        setTranscript(text);
      }),
      window.electron.voice.onAssistantText(({ text, final }) => {
        setThinking(false);
        setAssistantText((prev) => (final ? text : prev + text));
      }),
      window.electron.voice.onState((next) => {
        setState(next as VoiceUiState);
      }),
      window.electron.voice.onWake(() => {
        setTranscript('');
        setAssistantText('');
      }),
      window.electron.voice.onSleep(() => {
        setThinking(false);
      }),
      window.electron.voice.onCaptureReady(({ label }) => {
        console.log('[cyrvis] external capture ready', label);
        setError(null);
        setMicReady(true);
      }),
      window.electron.voice.onCaptureError(({ message }) => {
        console.error('[cyrvis] external capture error', message);
        setError(message);
        setMicReady(false);
        setThinking(false);
        stopPlayback();
      }),
      window.electron.voice.onSetOutput((label) => {
        void applyOutput(label);
      }),
      window.electron.voice.onAudioMode(({ mode }) => {
        setAudioModeState(mode);
        applyAudioMode(mode);
      }),
    ];

    console.log(
      '[cyrvis] voice bar mounted; audio subscribers:',
      JSON.stringify(window.electron.voice.debugAudioSubscribers()),
    );
    if (window.electron.voice.isTestMode) {
      console.log('[cyrvis] test mode: microphone auto-start disabled');
    } else {
      // Best-effort auto-start. If Chromium requires a gesture, the UI exposes
      // a Start button and the error is shown to the user.
      void start();
    }

    return () => {
      if (voiceOwner === owner) {
        voiceOwner = null;
      }
      if (assistantIdleTimerRef.current) {
        clearTimeout(assistantIdleTimerRef.current);
        assistantIdleTimerRef.current = null;
      }
      cleanups.forEach((cleanup) => cleanup());
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      return;
    }
    const debugWindow = window as unknown as {
      __cyrvisStopMic?: () => void;
      __cyrvisStartMic?: () => void;
    };
    debugWindow.__cyrvisStopMic = () => {
      void stopCapture();
    };
    debugWindow.__cyrvisStartMic = () => {
      void ensureMic().catch((error) => {
        console.warn('[cyrvis] debug mic restart failed', error);
      });
    };
  }, [ensureMic, stopCapture]);

  useEffect(() => {
    if (!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      return;
    }
    const debugWindow = window as unknown as {
      __cyrvisSetOutput?: (needle: string) => Promise<string>;
      __cyrvisResetOutput?: () => Promise<string>;
    };
    debugWindow.__cyrvisSetOutput = async (needle: string) => {
      return (await applyOutput(needle)) ?? `output not found: ${needle}`;
    };
    debugWindow.__cyrvisResetOutput = async () => {
      outputDeviceIdRef.current = null;
      const player = playerRef.current;
      if (player) {
        try {
          await player.setSinkId('default');
        } catch (error) {
          console.warn('[cyrvis] reset output failed', error);
        }
      }
      return 'default';
    };
  }, []);

  useEffect(() => {
    if (!window.electron.voice.externalCapture) {
      return;
    }
    if (!navigator.mediaDevices?.addEventListener) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onDeviceChange = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void window.electron.voice.restartCapture().catch((error) => {
          console.warn('[cyrvis] restart capture failed', error);
        });
      }, 800);
    };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        'devicechange',
        onDeviceChange,
      );
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (window.electron.voice.externalCapture) {
      return;
    }
    if (window.electron.voice.isTestMode) {
      return;
    }
    if (!navigator.mediaDevices?.addEventListener) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const onDeviceChange = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const inputs = devices.filter(
            (device) => device.kind === 'audioinput',
          );
          const realMic = inputs.find(
            (device) =>
              device.deviceId &&
              device.label &&
              !/todesk|virtual|stereo mix|line in/i.test(device.label),
          );
          const currentTrack =
            mediaStreamRef.current?.getAudioTracks()[0] || null;
          const currentLabel = currentTrack?.label || '';
          const currentIsVirtual =
            !currentLabel ||
            /todesk|virtual|stereo mix|line in/i.test(currentLabel);
          const currentEnded =
            !currentTrack || currentTrack.readyState === 'ended';

          console.log(
            '[cyrvis] devicechange',
            JSON.stringify({
              inputs: inputs.map((device) => device.label),
              realMic: realMic?.label || null,
              currentLabel,
            }),
          );

          if (currentEnded || !mediaStreamRef.current) {
            if (realMic) {
              await restartMic();
            } else {
              await stopCapture();
              setError(
                'No physical microphone found. Connect the headset microphone and restart voice.',
              );
            }
            return;
          }

          if (realMic && currentIsVirtual) {
            await restartMic();
          } else if (!realMic && currentIsVirtual) {
            await stopCapture();
            setError(
              'No physical microphone found. Connect the headset microphone and restart voice.',
            );
          }
        } catch (error) {
          console.warn('[cyrvis] devicechange handling failed', error);
        }
      }, 500);
    };

    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        'devicechange',
        onDeviceChange,
      );
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [restartMic, start, stopCapture]);

  return {
    state,
    transcript,
    assistantText,
    micReady,
    thinking,
    connecting,
    playbackActive,
    audioMode,
    error,
    ptt,
    start,
    stop,
    togglePtt: window.electron.voice.togglePtt,
    interrupt: () => window.electron.voice.bargeIn(),
    toggleAudioMode,
    forceAwake: window.electron.voice.forceAwake,
    sleep: window.electron.voice.sleep,
    cancelTask: window.electron.voice.cancelTask,
  };
}
