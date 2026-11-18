/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type StreamingAsrEvent =
  | {
      type: 'started';
      sessionId: string;
      turnId?: string;
    }
  | {
      type: 'partial';
      sessionId: string;
      turnId?: string;
      text: string;
      requestId?: string;
      finalizedFromPartial?: boolean;
    }
  | {
      type: 'final';
      sessionId: string;
      turnId?: string;
      text: string;
      requestId?: string;
    }
  | {
      type: 'error';
      sessionId: string;
      turnId?: string;
      error: string;
    }
  | {
      type: 'closed';
      sessionId: string;
      turnId?: string;
    };

export type StreamingAsrStartInput = {
  turnId?: string;
  sampleRate?: number;
};

export type StreamingAsrClaimInput = {
  sessionId: string;
  turnId: string;
};

export type StreamingAsrAudioInput = {
  sessionId: string;
  audio?: ArrayBuffer;
  audioBase64?: string;
};

export type StreamingAsrFinishInput = {
  sessionId: string;
};

export type StreamingAsrFinishResult = {
  text: string;
  requestId?: string;
  finalizedFromPartial?: boolean;
};
