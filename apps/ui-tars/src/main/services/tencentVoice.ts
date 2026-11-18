/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { TENLAI_ASR_DEFAULT_BASE_URL, TENLAI_ASR_MODEL } from '@shared/voice';

const CREATE_TASK_PATH = '/v1/tenlai/asrproxy/create_rec_task';
const DESCRIBE_TASK_PATH = '/v1/tenlai/asrproxy/describe_task_status';

type TenlaiTaskResponse = {
  request_id?: string;
  id?: string | number;
  status?: 'queued' | 'in_progress' | 'completed' | 'failed';
  output?: { text?: string };
  error?: unknown;
};

export type TenlaiAsrConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const normalizeTenlaiModel = (model?: string) => {
  const normalized = model?.trim().toLowerCase();
  return !normalized || normalized === 'tenlai-asr-v1'
    ? TENLAI_ASR_MODEL
    : normalized;
};

export const getTenlaiEndpoints = (baseUrl?: string) => {
  const raw = (baseUrl?.trim() || TENLAI_ASR_DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  let origin = raw;
  if (raw.includes('/v1/tenlai/asrproxy/')) {
    origin = new URL(raw).origin;
  } else if (raw.endsWith('/v1')) {
    origin = raw.slice(0, -3);
  }
  return {
    createTask: `${origin}${CREATE_TASK_PATH}`,
    describeTask: `${origin}${DESCRIBE_TASK_PATH}`,
  };
};

export const stripTenlaiTimestamps = (text: string) =>
  text
    .replace(/\[\d+:\d+(?:\.\d+)?,\d+:\d+(?:\.\d+)?\]\s*/g, '')
    .replace(/\r/g, '')
    .trim();

const readJson = async (response: Response) => {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Tenlai ASR returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    const errorPayload = payload as {
      message?: string;
      error?: { message?: string };
    };
    throw new Error(
      errorPayload.error?.message ||
        errorPayload.message ||
        `Tenlai ASR request failed with HTTP ${response.status}`,
    );
  }
  return payload;
};

const postJson = async ({
  endpoint,
  apiKey,
  body,
  fetchImpl,
}: {
  endpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return (await readJson(response)) as TenlaiTaskResponse;
  } finally {
    clearTimeout(timeout);
  }
};

export const transcribeWithTenlai = async (
  input: { audioBase64: string },
  config: TenlaiAsrConfig,
  fetchImpl: typeof fetch = fetch,
) => {
  if (!config.apiKey.trim()) {
    throw new Error('Tenlai ASR API Key is not configured');
  }
  const model = normalizeTenlaiModel(config.model);
  const endpoints = getTenlaiEndpoints(config.baseUrl);
  const created = await postJson({
    endpoint: endpoints.createTask,
    apiKey: config.apiKey,
    body: { model, data: input.audioBase64 },
    fetchImpl,
  });
  const taskId = String(created.id || '');
  if (!taskId) {
    throw new Error('Tenlai ASR did not return a task id');
  }
  const deadline = Date.now() + (config.timeoutMs ?? 90_000);
  const pollIntervalMs = config.pollIntervalMs ?? 750;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const task = await postJson({
      endpoint: endpoints.describeTask,
      apiKey: config.apiKey,
      body: { model, task_id: taskId },
      fetchImpl,
    });
    if (task.status === 'completed') {
      return {
        text: stripTenlaiTimestamps(task.output?.text || ''),
        taskId,
      };
    }
    if (task.status === 'failed') {
      throw new Error(
        `Tenlai ASR task failed: ${JSON.stringify(task.error || 'unknown error')}`,
      );
    }
    if (task.status !== 'queued' && task.status !== 'in_progress') {
      throw new Error(`Tenlai ASR returned unknown status: ${task.status}`);
    }
  }
  throw new Error(`Tenlai ASR task ${taskId} timed out`);
};
