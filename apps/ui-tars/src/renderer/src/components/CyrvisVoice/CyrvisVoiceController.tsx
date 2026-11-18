import { useVoiceAudio } from './useVoiceAudio';

/**
 * The hidden settings/main window owns assistant audio playback. Keeping this
 * controller mounted is required even though it renders no visible UI.
 */
export function CyrvisVoiceController() {
  useVoiceAudio();
  return null;
}
