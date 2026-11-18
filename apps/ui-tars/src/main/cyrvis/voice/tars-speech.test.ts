import { describe, expect, it } from 'vitest';

import {
  cleanSpeechText,
  spokenCharacterCount,
  takeTtsChunks,
} from './tars-speech';

describe('UI-tars speech helpers', () => {
  it('removes non-spoken markup and keeps spoken punctuation', () => {
    expect(cleanSpeechText('**你好**，[世界](https://example.com)！')).toBe(
      '你好，世界！',
    );
    expect(spokenCharacterCount('你好，世界！')).toBe(4);
  });

  it('uses a short first chunk and larger follow-up chunks', () => {
    const first = takeTtsChunks(
      '这是第一段回复。后面还有一段更长的回复内容需要继续播报。',
      { firstChunk: true },
    );
    expect(first.chunks[0]).toBe('这是第一段回复。');
    expect(first.chunks[0].length).toBeLessThanOrEqual(18);

    const next = takeTtsChunks(
      '后续内容继续生成并且会按照较长分块送入语音合成服务。',
      {
        firstChunk: false,
      },
    );
    expect(next.chunks[0]).toBe(
      '后续内容继续生成并且会按照较长分块送入语音合成服务。',
    );
  });
});
