import { useEffect, useState } from 'react';
import { Cloud, HardDrive } from 'lucide-react';
import { toast } from 'sonner';

import type { LocalStore } from '@main/store/validate';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/switch';
import { useSetting } from '@renderer/hooks/useSetting';
import {
  BREEZE_TTS_DEFAULT_BASE_URL,
  BREEZE_TTS_DEFAULT_INSTRUCTION,
  BREEZE_TTS_DEFAULT_SEED,
  BREEZE_TTS_MODEL,
  QWEN_ASR_DEFAULT_WS_URL,
  QWEN_ASR_MODEL,
  VOICE_DEFAULT_SILENCE_TIMEOUT_MS,
  VOICE_MAX_SILENCE_TIMEOUT_MS,
  VOICE_MIN_SILENCE_TIMEOUT_MS,
} from '@shared/voice';
import {
  QWEN_TTS_AUDIO_CLONE_MODEL,
  QWEN_TTS_AUDIO_CLONE_WS_URL,
  QWEN_TTS_REALTIME_HTTP_BASE_URL,
  QWEN_TTS_REALTIME_MODEL,
  QWEN_TTS_REALTIME_PREFERRED_NAME,
  QWEN_TTS_REALTIME_REFERENCE_AUDIO_PATH,
  QWEN_TTS_REALTIME_WS_URL,
  QWEN_TTS_SYSTEM_VOICE,
} from '@shared/qwenTtsRealtime';

type VoiceSettingsState = Required<
  Pick<
    LocalStore,
    | 'voiceEnabled'
    | 'conversationBaseUrl'
    | 'conversationApiKey'
    | 'conversationModelName'
    | 'voiceRequireWakeWord'
    | 'voiceWakeWord'
    | 'voiceLanguage'
    | 'voiceSilenceTimeoutMs'
    | 'voiceSttProvider'
    | 'voiceSttBaseUrl'
    | 'voiceSttApiKey'
    | 'voiceSttModel'
    | 'voiceTtsEnabled'
    | 'voiceTtsProvider'
    | 'voiceTtsBaseUrl'
    | 'voiceTtsApiKey'
    | 'voiceTtsModel'
    | 'voiceTtsVoice'
    | 'voiceTtsInstruction'
    | 'voiceTtsCfgScale'
    | 'voiceTtsSeed'
    | 'voiceTtsRuntimeDir'
    | 'voiceTtsModelPath'
    | 'voiceQwenTtsHttpBaseUrl'
    | 'voiceQwenTtsWsUrl'
    | 'voiceQwenTtsApiKey'
    | 'voiceQwenTtsWorkspace'
    | 'voiceQwenTtsModel'
    | 'voiceQwenTtsVoice'
    | 'voiceQwenTtsVoiceModel'
    | 'voiceQwenTtsReferenceAudioPath'
    | 'voiceQwenTtsPreferredName'
    | 'voiceQwenTtsMode'
    | 'voiceQwenTtsLanguage'
  >
>;

const DEFAULTS: VoiceSettingsState = {
  voiceEnabled: true,
  conversationBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  conversationApiKey: '',
  conversationModelName: 'qwen-plus',
  voiceRequireWakeWord: true,
  voiceWakeWord: '小T',
  voiceLanguage: 'zh',
  voiceSilenceTimeoutMs: VOICE_DEFAULT_SILENCE_TIMEOUT_MS,
  voiceSttProvider: 'auto',
  voiceSttBaseUrl: QWEN_ASR_DEFAULT_WS_URL,
  voiceSttApiKey: '',
  voiceSttModel: QWEN_ASR_MODEL,
  voiceTtsEnabled: true,
  voiceTtsProvider: 'breeze-local',
  voiceTtsBaseUrl: BREEZE_TTS_DEFAULT_BASE_URL,
  voiceTtsApiKey: 'local-breeze',
  voiceTtsModel: BREEZE_TTS_MODEL,
  voiceTtsVoice: '',
  voiceTtsInstruction: BREEZE_TTS_DEFAULT_INSTRUCTION,
  voiceTtsCfgScale: 1,
  voiceTtsSeed: BREEZE_TTS_DEFAULT_SEED,
  voiceTtsRuntimeDir: '',
  voiceTtsModelPath: '',
  voiceQwenTtsHttpBaseUrl: QWEN_TTS_REALTIME_HTTP_BASE_URL,
  voiceQwenTtsWsUrl: QWEN_TTS_AUDIO_CLONE_WS_URL,
  voiceQwenTtsApiKey: '',
  voiceQwenTtsWorkspace: '',
  voiceQwenTtsModel: QWEN_TTS_AUDIO_CLONE_MODEL,
  voiceQwenTtsVoice: '',
  voiceQwenTtsVoiceModel: '',
  voiceQwenTtsReferenceAudioPath: QWEN_TTS_REALTIME_REFERENCE_AUDIO_PATH,
  voiceQwenTtsPreferredName: QWEN_TTS_REALTIME_PREFERRED_NAME,
  voiceQwenTtsMode: 'commit',
  voiceQwenTtsLanguage: 'Chinese',
};

const getVoiceSettings = (
  settings: Partial<LocalStore>,
): VoiceSettingsState => ({
  voiceEnabled: settings.voiceEnabled ?? DEFAULTS.voiceEnabled,
  conversationBaseUrl:
    settings.conversationBaseUrl ?? DEFAULTS.conversationBaseUrl,
  conversationApiKey:
    settings.conversationApiKey ?? DEFAULTS.conversationApiKey,
  conversationModelName:
    settings.conversationModelName ?? DEFAULTS.conversationModelName,
  voiceRequireWakeWord:
    settings.voiceRequireWakeWord ?? DEFAULTS.voiceRequireWakeWord,
  voiceWakeWord: settings.voiceWakeWord ?? DEFAULTS.voiceWakeWord,
  voiceLanguage: settings.voiceLanguage ?? DEFAULTS.voiceLanguage,
  voiceSilenceTimeoutMs:
    settings.voiceSilenceTimeoutMs ?? DEFAULTS.voiceSilenceTimeoutMs,
  voiceSttProvider: settings.voiceSttProvider ?? DEFAULTS.voiceSttProvider,
  voiceSttBaseUrl: settings.voiceSttBaseUrl ?? DEFAULTS.voiceSttBaseUrl,
  voiceSttApiKey: settings.voiceSttApiKey ?? DEFAULTS.voiceSttApiKey,
  voiceSttModel: settings.voiceSttModel ?? DEFAULTS.voiceSttModel,
  voiceTtsEnabled: settings.voiceTtsEnabled ?? DEFAULTS.voiceTtsEnabled,
  voiceTtsProvider: settings.voiceTtsProvider ?? DEFAULTS.voiceTtsProvider,
  voiceTtsBaseUrl: settings.voiceTtsBaseUrl ?? DEFAULTS.voiceTtsBaseUrl,
  voiceTtsApiKey: settings.voiceTtsApiKey ?? DEFAULTS.voiceTtsApiKey,
  voiceTtsModel: settings.voiceTtsModel ?? DEFAULTS.voiceTtsModel,
  voiceTtsVoice: settings.voiceTtsVoice ?? DEFAULTS.voiceTtsVoice,
  voiceTtsInstruction:
    settings.voiceTtsInstruction ?? DEFAULTS.voiceTtsInstruction,
  voiceTtsCfgScale: settings.voiceTtsCfgScale ?? DEFAULTS.voiceTtsCfgScale,
  voiceTtsSeed: settings.voiceTtsSeed ?? DEFAULTS.voiceTtsSeed,
  voiceTtsRuntimeDir:
    settings.voiceTtsRuntimeDir ?? DEFAULTS.voiceTtsRuntimeDir,
  voiceTtsModelPath: settings.voiceTtsModelPath ?? DEFAULTS.voiceTtsModelPath,
  voiceQwenTtsHttpBaseUrl:
    settings.voiceQwenTtsHttpBaseUrl ?? DEFAULTS.voiceQwenTtsHttpBaseUrl,
  voiceQwenTtsWsUrl: settings.voiceQwenTtsWsUrl ?? DEFAULTS.voiceQwenTtsWsUrl,
  voiceQwenTtsApiKey:
    settings.voiceQwenTtsApiKey ?? DEFAULTS.voiceQwenTtsApiKey,
  voiceQwenTtsWorkspace:
    settings.voiceQwenTtsWorkspace ?? DEFAULTS.voiceQwenTtsWorkspace,
  voiceQwenTtsModel: settings.voiceQwenTtsModel ?? DEFAULTS.voiceQwenTtsModel,
  voiceQwenTtsVoice: settings.voiceQwenTtsVoice ?? DEFAULTS.voiceQwenTtsVoice,
  voiceQwenTtsVoiceModel:
    settings.voiceQwenTtsVoiceModel ?? DEFAULTS.voiceQwenTtsVoiceModel,
  voiceQwenTtsReferenceAudioPath:
    settings.voiceQwenTtsReferenceAudioPath ??
    DEFAULTS.voiceQwenTtsReferenceAudioPath,
  voiceQwenTtsPreferredName:
    settings.voiceQwenTtsPreferredName ?? DEFAULTS.voiceQwenTtsPreferredName,
  voiceQwenTtsMode: settings.voiceQwenTtsMode ?? DEFAULTS.voiceQwenTtsMode,
  voiceQwenTtsLanguage:
    settings.voiceQwenTtsLanguage ?? DEFAULTS.voiceQwenTtsLanguage,
});

const SettingRow = ({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) => (
  <div className="flex items-center justify-between gap-6 rounded-lg border p-4">
    <div>
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </div>
);

export function VoiceSettings() {
  const { settings, updateSetting } = useSetting();
  const [values, setValues] = useState(DEFAULTS);
  const [creatingVoice, setCreatingVoice] = useState(false);
  const [switchingProvider, setSwitchingProvider] = useState(false);

  useEffect(() => {
    if (Object.keys(settings).length) {
      setValues(getVoiceSettings(settings));
    }
  }, [settings]);

  const setValue = <K extends keyof VoiceSettingsState>(
    key: K,
    value: VoiceSettingsState[K],
  ) => setValues((current) => ({ ...current, [key]: value }));

  const save = async (showToast = true) => {
    await updateSetting({ ...settings, ...values });
    if (showToast) {
      toast.success(
        'Voice settings saved. Restart CYRVIS to apply provider changes.',
      );
    }
  };

  const changeQwenModel = (model: string) => {
    setValues((current) =>
      model === QWEN_TTS_AUDIO_CLONE_MODEL
        ? {
            ...current,
            voiceQwenTtsModel: model,
            voiceQwenTtsWsUrl: QWEN_TTS_AUDIO_CLONE_WS_URL,
            voiceQwenTtsVoice:
              current.voiceQwenTtsVoiceModel === model
                ? current.voiceQwenTtsVoice
                : '',
            voiceQwenTtsVoiceModel: '',
          }
        : {
            ...current,
            voiceQwenTtsModel: QWEN_TTS_REALTIME_MODEL,
            voiceQwenTtsWsUrl: QWEN_TTS_REALTIME_WS_URL,
            voiceQwenTtsVoice: QWEN_TTS_SYSTEM_VOICE,
            voiceQwenTtsVoiceModel: '',
          },
    );
  };

  const createQwenVoice = async () => {
    setCreatingVoice(true);
    try {
      await save(false);
      const result = await window.electron.voice.prepareQwenTtsVoice({
        force: true,
      });
      setValues((current) => ({
        ...current,
        voiceQwenTtsVoice: result.voice,
        voiceQwenTtsVoiceModel: result.model,
      }));
      toast.success('Qwen voice created from the reference audio');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to create Qwen voice',
      );
    } finally {
      setCreatingVoice(false);
    }
  };

  const switchTtsProvider = async (
    provider: 'breeze-local' | 'qwen-tts-realtime',
  ) => {
    if (values.voiceTtsProvider === provider || switchingProvider) {
      return;
    }
    const previous = values;
    const next = { ...values, voiceTtsProvider: provider };
    setValues(next);
    setSwitchingProvider(true);
    try {
      await updateSetting({ ...settings, ...next });
      toast.success(
        provider === 'qwen-tts-realtime'
          ? 'Qwen Realtime TTS enabled'
          : 'Local Breeze TTS enabled',
      );
    } catch (error) {
      setValues(previous);
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to switch TTS provider',
      );
    } finally {
      setSwitchingProvider(false);
    }
  };

  const qwenClone = values.voiceQwenTtsModel === QWEN_TTS_AUDIO_CLONE_MODEL;
  const qwenMode: 'breeze-local' | 'qwen-tts-realtime' =
    values.voiceTtsProvider === 'qwen-tts-realtime'
      ? 'qwen-tts-realtime'
      : 'breeze-local';

  return (
    <div className="space-y-6 pb-8">
      <SettingRow
        title="Always-on voice mode"
        description="Keep the microphone active and listen for spoken commands."
        checked={values.voiceEnabled}
        onCheckedChange={(checked) => setValue('voiceEnabled', checked)}
      />
      <div className="space-y-4 rounded-lg border p-4">
        <h3 className="font-semibold">Conversation LLM</h3>
        <Input
          value={values.conversationBaseUrl}
          onChange={(event) =>
            setValue('conversationBaseUrl', event.target.value)
          }
          placeholder="OpenAI-compatible Base URL"
        />
        <Input
          type="password"
          value={values.conversationApiKey}
          onChange={(event) =>
            setValue('conversationApiKey', event.target.value)
          }
          placeholder="Conversation API Key"
        />
        <Input
          value={values.conversationModelName}
          onChange={(event) =>
            setValue('conversationModelName', event.target.value)
          }
          placeholder="qwen-plus"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <label className="space-y-2">
          <span className="text-sm font-medium">Wake word</span>
          <Input
            value={values.voiceWakeWord}
            onChange={(event) => setValue('voiceWakeWord', event.target.value)}
          />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium">Spoken language</span>
          <Select
            value={values.voiceLanguage}
            onValueChange={(value) =>
              setValue('voiceLanguage', value as 'auto' | 'zh' | 'en')
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto detect</SelectItem>
              <SelectItem value="zh">Chinese</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      <SettingRow
        title="Require wake word"
        description="Only start a task after the configured wake word."
        checked={values.voiceRequireWakeWord}
        onCheckedChange={(checked) => setValue('voiceRequireWakeWord', checked)}
      />
      <label className="block max-w-xs space-y-2">
        <span className="text-sm font-medium">End-of-speech silence (ms)</span>
        <Input
          type="number"
          min={VOICE_MIN_SILENCE_TIMEOUT_MS}
          max={VOICE_MAX_SILENCE_TIMEOUT_MS}
          value={values.voiceSilenceTimeoutMs}
          onChange={(event) =>
            setValue('voiceSilenceTimeoutMs', Number(event.target.value))
          }
        />
      </label>

      <div className="space-y-4 rounded-lg border p-4">
        <h3 className="font-semibold">Speech-to-text API</h3>
        <Select
          value={values.voiceSttProvider}
          onValueChange={(value) =>
            setValue(
              'voiceSttProvider',
              value as
                | 'auto'
                | 'openai-compatible'
                | 'tenlai-async'
                | 'qwen-dashscope-streaming',
            )
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto detect by model</SelectItem>
            <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
            <SelectItem value="tenlai-async">Tenlai async</SelectItem>
            <SelectItem value="qwen-dashscope-streaming">
              Qwen DashScope streaming
            </SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={values.voiceSttBaseUrl}
          onChange={(event) => setValue('voiceSttBaseUrl', event.target.value)}
        />
        <Input
          type="password"
          value={values.voiceSttApiKey}
          onChange={(event) => setValue('voiceSttApiKey', event.target.value)}
          placeholder="DashScope API key"
        />
        <Input
          value={values.voiceSttModel}
          onChange={(event) => setValue('voiceSttModel', event.target.value)}
        />
      </div>

      <SettingRow
        title="Voice responses"
        description="Speak progress, questions, and task results."
        checked={values.voiceTtsEnabled}
        onCheckedChange={(checked) => setValue('voiceTtsEnabled', checked)}
      />
      <div className="space-y-4 rounded-lg border p-4">
        <h3 className="font-semibold">Text-to-speech API</h3>
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
          <Button
            type="button"
            variant={qwenMode === 'breeze-local' ? 'default' : 'ghost'}
            className="h-auto min-h-14 justify-start text-left"
            disabled={switchingProvider}
            onClick={() => void switchTtsProvider('breeze-local')}
          >
            <HardDrive />
            Local Breeze TTS
          </Button>
          <Button
            type="button"
            variant={qwenMode === 'qwen-tts-realtime' ? 'default' : 'ghost'}
            className="h-auto min-h-14 justify-start text-left"
            disabled={switchingProvider}
            onClick={() => void switchTtsProvider('qwen-tts-realtime')}
          >
            <Cloud />
            Qwen Cloud TTS
          </Button>
        </div>

        {qwenMode === 'qwen-tts-realtime' ? (
          <div className="space-y-4 rounded-md border border-dashed p-4">
            <Input
              type="password"
              value={values.voiceQwenTtsApiKey}
              onChange={(event) =>
                setValue('voiceQwenTtsApiKey', event.target.value)
              }
              placeholder="DashScope / Model Studio API Key"
            />
            <Input
              value={values.voiceQwenTtsHttpBaseUrl}
              onChange={(event) =>
                setValue('voiceQwenTtsHttpBaseUrl', event.target.value)
              }
            />
            <Input
              value={values.voiceQwenTtsWsUrl}
              onChange={(event) =>
                setValue('voiceQwenTtsWsUrl', event.target.value)
              }
            />
            <Input
              value={values.voiceQwenTtsWorkspace}
              onChange={(event) =>
                setValue('voiceQwenTtsWorkspace', event.target.value)
              }
              placeholder="Optional workspace ID"
            />
            <Select
              value={values.voiceQwenTtsModel}
              onValueChange={changeQwenModel}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={QWEN_TTS_AUDIO_CLONE_MODEL}>
                  Qwen Audio TTS Flash (cloned voice)
                </SelectItem>
                <SelectItem value={QWEN_TTS_REALTIME_MODEL}>
                  Qwen3 TTS Flash Realtime (system voice)
                </SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={values.voiceQwenTtsVoice}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  voiceQwenTtsVoice: event.target.value,
                  voiceQwenTtsVoiceModel: '',
                }))
              }
              placeholder={
                qwenClone ? 'Created Voice ID' : QWEN_TTS_SYSTEM_VOICE
              }
            />
            <div className="grid grid-cols-2 gap-4">
              <Input
                value={values.voiceQwenTtsReferenceAudioPath}
                onChange={(event) =>
                  setValue('voiceQwenTtsReferenceAudioPath', event.target.value)
                }
                placeholder="Reference WAV/MP3/M4A"
              />
              <Input
                value={values.voiceQwenTtsPreferredName}
                onChange={(event) =>
                  setValue('voiceQwenTtsPreferredName', event.target.value)
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Select
                value={values.voiceQwenTtsMode}
                onValueChange={(value) =>
                  setValue(
                    'voiceQwenTtsMode',
                    value as 'commit' | 'server_commit',
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="commit">Commit mode</SelectItem>
                  <SelectItem value="server_commit">Server commit</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={values.voiceQwenTtsLanguage}
                onValueChange={(value) =>
                  setValue(
                    'voiceQwenTtsLanguage',
                    value as VoiceSettingsState['voiceQwenTtsLanguage'],
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Chinese">Chinese</SelectItem>
                  <SelectItem value="English">English</SelectItem>
                  <SelectItem value="Auto">Auto</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {qwenClone ? (
              <Button
                type="button"
                variant="secondary"
                disabled={
                  creatingVoice ||
                  !values.voiceQwenTtsApiKey.trim() ||
                  !values.voiceQwenTtsReferenceAudioPath.trim()
                }
                onClick={() => void createQwenVoice()}
              >
                {creatingVoice
                  ? 'Creating and validating voice...'
                  : values.voiceQwenTtsVoice
                    ? 'Create a new Qwen voice'
                    : 'Create Qwen voice'}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              value={values.voiceTtsBaseUrl}
              onChange={(event) =>
                setValue('voiceTtsBaseUrl', event.target.value)
              }
            />
            <Input
              value={values.voiceTtsVoice}
              onChange={(event) =>
                setValue('voiceTtsVoice', event.target.value)
              }
              placeholder="Optional saved Breeze voice ID"
            />
            <Input
              value={values.voiceTtsInstruction}
              onChange={(event) =>
                setValue('voiceTtsInstruction', event.target.value)
              }
            />
            <div className="grid grid-cols-2 gap-4">
              <Input
                type="number"
                min={1}
                max={3}
                step={0.5}
                value={values.voiceTtsCfgScale}
                onChange={(event) =>
                  setValue('voiceTtsCfgScale', Number(event.target.value))
                }
              />
              <Input
                type="number"
                min={0}
                max={2_147_483_647}
                value={values.voiceTtsSeed}
                onChange={(event) =>
                  setValue('voiceTtsSeed', Number(event.target.value))
                }
              />
            </div>
            <Input
              value={values.voiceTtsRuntimeDir}
              onChange={(event) =>
                setValue('voiceTtsRuntimeDir', event.target.value)
              }
              placeholder="Optional Breeze runtime directory"
            />
            <Input
              value={values.voiceTtsModelPath}
              onChange={(event) =>
                setValue('voiceTtsModelPath', event.target.value)
              }
              placeholder="Optional Breeze GGUF model path"
            />
          </div>
        )}
      </div>
      <Button type="button" onClick={() => void save()}>
        Save Voice Settings
      </Button>
    </div>
  );
}
