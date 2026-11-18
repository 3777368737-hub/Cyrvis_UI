/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RUNTIME_RELATIVE_PATH = path.join(
  '.runtime',
  'breeze-tts-2',
  'runtime-v0.1.7',
  'breeze-tts-2-v0.1.7-windows-x64-vulkan',
);
const DEFAULT_MODEL_RELATIVE_PATH = path.join(
  '.runtime',
  'breeze-tts-2',
  'breeze-tts-2-q8_0.gguf',
);
const DEFAULT_VOICES_RELATIVE_PATH = path.join(
  '.runtime',
  'breeze-tts-2',
  'voices',
);

export type BreezeTtsPathInput = {
  rootDir: string;
  configuredRuntimeDir?: string;
  configuredModelPath?: string;
};

export type BreezeTtsPaths = {
  runtimeDir: string;
  modelPath: string;
  voicesDir: string;
  runtimeFallbackFrom?: string;
  modelFallbackFrom?: string;
};

const hasRuntime = (runtimeDir: string) =>
  fs.existsSync(path.join(runtimeDir, 'breeze-server.exe'));

const hasModel = (modelPath: string) => fs.existsSync(modelPath);

export const resolveBreezeTtsPaths = ({
  rootDir,
  configuredRuntimeDir,
  configuredModelPath,
}: BreezeTtsPathInput): BreezeTtsPaths => {
  const defaultRuntimeDir = path.join(rootDir, DEFAULT_RUNTIME_RELATIVE_PATH);
  const defaultModelPath = path.join(rootDir, DEFAULT_MODEL_RELATIVE_PATH);
  const runtimeDir = configuredRuntimeDir?.trim();
  const modelPath = configuredModelPath?.trim();
  const selectedRuntimeDir =
    runtimeDir && hasRuntime(runtimeDir) ? runtimeDir : defaultRuntimeDir;
  const selectedModelPath =
    modelPath && hasModel(modelPath) ? modelPath : defaultModelPath;

  return {
    runtimeDir: selectedRuntimeDir,
    modelPath: selectedModelPath,
    voicesDir: path.join(rootDir, DEFAULT_VOICES_RELATIVE_PATH),
    ...(runtimeDir &&
    path.resolve(runtimeDir) !== path.resolve(selectedRuntimeDir)
      ? { runtimeFallbackFrom: runtimeDir }
      : {}),
    ...(modelPath && path.resolve(modelPath) !== path.resolve(selectedModelPath)
      ? { modelFallbackFrom: modelPath }
      : {}),
  };
};
