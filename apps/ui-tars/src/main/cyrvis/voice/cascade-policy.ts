/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export const shouldDisableThinking = (baseURL: string, model: string) => {
  const normalized = model.trim().toLowerCase();
  // Qwen3 plus models default to reasoning, which added 30-48s before the
  // first voice token in the cascade path. Voice replies need a direct answer.
  if (normalized.startsWith('qwen3') || normalized.startsWith('deepseek-')) {
    return true;
  }
  try {
    return new URL(baseURL).hostname.endsWith('deepseek.com');
  } catch {
    return false;
  }
};
