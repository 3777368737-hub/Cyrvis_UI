import { describe, expect, it } from 'vitest';

import { isLikelySpeakerEcho } from './speaker-echo';

describe('speaker echo detection', () => {
  it('drops an exact repetition of the assistant reply', () => {
    expect(isLikelySpeakerEcho('我在的。', '我在的。', 1200)).toBe(true);
  });

  it('drops a short partial tail from the assistant reply', () => {
    expect(
      isLikelySpeakerEcho('我在的', '我在的，有什么可以帮你？', 1800),
    ).toBe(true);
  });

  it('drops a short repeated phrase from the middle of the reply', () => {
    expect(
      isLikelySpeakerEcho(
        '整理东西',
        '听起来像是有人在整理东西，或者在翻找什么。',
        1800,
      ),
    ).toBe(true);
  });

  it('keeps a genuine follow-up', () => {
    expect(
      isLikelySpeakerEcho('帮我打开记事本', '我在的，有什么可以帮你？', 1800),
    ).toBe(false);
  });

  it('does not use stale assistant text', () => {
    expect(isLikelySpeakerEcho('我在的', '我在的', 20_000)).toBe(false);
  });

  it('keeps a wake phrase that starts with the assistant greeting', () => {
    expect(isLikelySpeakerEcho('Hello, hello, savage.', 'Hello', 100)).toBe(
      false,
    );
    expect(isLikelySpeakerEcho('你好赛维斯', '你好', 100)).toBe(false);
  });

  it('does not treat a one-word reply as a full echo reference', () => {
    expect(isLikelySpeakerEcho('你好，我在', '你好', 100)).toBe(false);
  });
});
