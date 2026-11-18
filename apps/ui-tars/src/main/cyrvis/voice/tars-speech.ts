/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export const TASK_ACKNOWLEDGED_SPEECH = '任务指令已收到。';
export const TASK_PROCESSING_SPEECH = '任务正在处理中。';

export const cleanSpeechText = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, '代码内容已省略。')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}(#{1,6}|[-+*])\s*/gm, '')
    .replace(/[*_#>|~^]/g, ' ')
    .replace(/[()[\]{}<>]/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u2600-\u27bf]/gu, ' ')
    .replace(/[^\p{L}\p{N}\p{Script=Han}，。！？、：；.!?;:'"\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？、：；])/g, '$1')
    .trim();

export const spokenCharacterCount = (text: string) =>
  Array.from(cleanSpeechText(text).replace(/[^\p{L}\p{N}]/gu, '')).length;

export const takeTtsChunks = (
  text: string,
  options: {
    minimumChars?: number;
    maximumChars?: number;
    firstMinimumChars?: number;
    firstMaximumChars?: number;
    firstChunk?: boolean;
  } = {},
) => {
  const chunks: string[] = [];
  let current = '';
  let spokenChars = 0;

  for (const character of text) {
    current += character;
    if (!/\s/.test(character)) {
      spokenChars += 1;
    }
    const isFirstChunk = options.firstChunk === true && chunks.length === 0;
    const minimumChars = isFirstChunk
      ? (options.firstMinimumChars ?? 4)
      : (options.minimumChars ?? 24);
    const maximumChars = isFirstChunk
      ? (options.firstMaximumChars ?? 18)
      : (options.maximumChars ?? 48);
    const sentenceBoundary = /[。！？!?]/.test(character);
    const clauseBoundary = /[，、；;,:：]/.test(character);
    if (
      ((sentenceBoundary || clauseBoundary) && spokenChars >= minimumChars) ||
      spokenChars >= maximumChars
    ) {
      const chunk = current.trim();
      if (chunk) {
        chunks.push(chunk);
      }
      current = '';
      spokenChars = 0;
    }
  }

  return {
    chunks,
    remainder: current,
  };
};
