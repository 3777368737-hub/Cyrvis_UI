import { describe, expect, it } from 'vitest';

import {
  getTenlaiEndpoints,
  normalizeTenlaiModel,
  stripTenlaiTimestamps,
} from './tencentVoice';

describe('Tenlai ASR helpers', () => {
  it('normalizes model names and endpoints', () => {
    expect(normalizeTenlaiModel('Tenlai-ASR-v1')).toBe('tenlai-asr-v1.0');
    expect(getTenlaiEndpoints('https://tokenhub.tencentmaas.com/v1')).toEqual({
      createTask:
        'https://tokenhub.tencentmaas.com/v1/tenlai/asrproxy/create_rec_task',
      describeTask:
        'https://tokenhub.tencentmaas.com/v1/tenlai/asrproxy/describe_task_status',
    });
  });

  it('removes timestamp decorations from async transcripts', () => {
    expect(stripTenlaiTimestamps('[00:01.000,00:02.000] 你好\r\n世界')).toBe(
      '你好\n世界',
    );
  });
});
