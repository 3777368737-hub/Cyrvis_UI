/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';

import { logger } from '@main/logger';
import { SettingStore } from '@main/store/setting';

import { cleanSpeechText, spokenCharacterCount } from './tars-speech';
import { shouldDisableThinking, shouldUseCascadeTools } from './cascade-policy';
import type { VoiceToolCallWithId } from './provider';
import { CYRVIS_VOICE_TOOLS } from './tools';

type StreamingToolCall = {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type CascadeConversationCallbacks = {
  onAssistantDelta?: (text: string) => void;
  onSpeechDelta?: (text: string) => void;
  onToolCall?: (call: VoiceToolCallWithId) => void;
};

type RunResult = {
  text: string;
};

const BASE_INSTRUCTIONS = `You are CYRVIS, a Windows desktop voice assistant.

Answer ordinary conversation directly and concisely. Use the provided tools only
when the user explicitly asks to operate the computer, manage a task, inspect
status, or remember a durable fact. Never claim that a GUI task is complete until
the tool result or the task event confirms it.

Every final answer is sent to text-to-speech. Return plain spoken language with
natural punctuation. Do not return Markdown, tables, code fences, emoji, raw
JSON, shell commands, or URLs unless the user explicitly asks to hear them.
Start with a complete, self-contained short sentence. Continue with essential
detail only when needed. If the user speaks Chinese, answer in Simplified
Chinese. Never reveal hidden chain-of-thought.`;

export class CascadeConversationClient {
  private context = '';
  private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private readonly pendingToolResults = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }
  >();

  setContext(context: string): void {
    this.context = context.trim();
  }

  sendToolResult(callId: string, output: string): void {
    const pending = this.pendingToolResults.get(callId);
    if (!pending) {
      logger.warn('[CascadeConversation] Tool result without pending call', {
        callId,
      });
      return;
    }
    this.pendingToolResults.delete(callId);
    pending.resolve(output);
  }

  cancelPendingToolResults(error: Error): void {
    for (const pending of this.pendingToolResults.values()) {
      pending.reject(error);
    }
    this.pendingToolResults.clear();
  }

  async ask(
    userText: string,
    options: {
      signal: AbortSignal;
      callbacks: CascadeConversationCallbacks;
    },
  ): Promise<RunResult> {
    const settings = SettingStore.getStore();
    const apiKey = settings.conversationApiKey?.trim() || '';
    const baseURL = settings.conversationBaseUrl?.trim();
    const model = settings.conversationModelName?.trim() || 'qwen-plus';
    if (!apiKey || !baseURL) {
      throw new Error(
        'Conversation LLM is not configured. Set CONVERSATION_BASE_URL and CONVERSATION_API_KEY.',
      );
    }

    const client = new OpenAI({ apiKey, baseURL });
    const toolsEnabled = shouldUseCascadeTools(userText);
    const requiredLanguage = /\p{Script=Han}/u.test(userText)
      ? 'Simplified Chinese'
      : 'the same language as the user';
    const tools = (toolsEnabled
      ? CYRVIS_VOICE_TOOLS.filter(
          (tool) =>
            tool.function.name !== 'remember_fact' ||
            /记住|记忆|remember/i.test(userText),
        )
      : []) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[];

    const requestMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [
        {
          role: 'system',
          content: `${BASE_INSTRUCTIONS}

Required reply language: ${requiredLanguage}.

Long-term memory and recent conversation context:
${this.context || '(empty)'}`,
        },
        ...this.history,
        { role: 'user', content: userText },
      ];

    try {
      const result = await this.runCompletion({
        client,
        baseURL,
        model,
        messages: requestMessages,
        tools,
        signal: options.signal,
        callbacks: options.callbacks,
      });

      this.history.push({ role: 'user', content: userText });
      if (result.text.trim()) {
        this.history.push({ role: 'assistant', content: result.text.trim() });
      }
      this.history = this.history.slice(-20);
      return result;
    } catch (error) {
      this.cancelPendingToolResults(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private async runCompletion({
    client,
    baseURL,
    model,
    messages,
    tools,
    signal,
    callbacks,
  }: {
    client: OpenAI;
    baseURL: string;
    model: string;
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    signal: AbortSignal;
    callbacks: CascadeConversationCallbacks;
  }): Promise<RunResult> {
    const disableThinking = shouldDisableThinking(baseURL, model);
    const requestBody: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
      thinking?: { type: 'enabled' | 'disabled' };
    } = {
      model,
      temperature: 0.3,
      stream: true,
      ...(tools.length
        ? {
            tools,
            tool_choice: 'auto' as const,
          }
        : {}),
      ...(disableThinking
        ? {
            thinking: { type: 'disabled' as const },
          }
        : {}),
      messages,
    };

    const stream = await client.chat.completions.create(requestBody, {
      signal,
    });
    const toolCalls = new Map<number, StreamingToolCall>();
    let rawContent = '';
    let publishedSpeechText = '';

    for await (const chunk of stream) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        rawContent += delta.content;
        callbacks.onAssistantDelta?.(delta.content);

        const speechText = cleanSpeechText(rawContent);
        if (
          speechText &&
          spokenCharacterCount(speechText) >= 4 &&
          speechText !== publishedSpeechText &&
          (!publishedSpeechText || speechText.startsWith(publishedSpeechText))
        ) {
          const nextSpeechDelta = publishedSpeechText
            ? speechText.slice(publishedSpeechText.length)
            : speechText;
          publishedSpeechText = speechText;
          if (nextSpeechDelta) {
            callbacks.onSpeechDelta?.(nextSpeechDelta);
          }
        }
      }

      for (const toolCallDelta of delta?.tool_calls || []) {
        const index = toolCallDelta.index;
        const current = toolCalls.get(index) || {
          function: { name: '', arguments: '' },
        };
        if (toolCallDelta.id) {
          current.id = toolCallDelta.id;
        }
        if (toolCallDelta.type === 'function') {
          current.type = 'function';
        }
        if (toolCallDelta.function?.name) {
          current.function.name += toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          current.function.arguments += toolCallDelta.function.arguments;
        }
        toolCalls.set(index, current);
      }
    }

    if (toolCalls.size) {
      const assistantToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call], index) => ({
          id: call.id || `call_${index}_${Date.now()}`,
          type: 'function' as const,
          function: call.function,
        }));
      messages.push({
        role: 'assistant',
        content: rawContent || null,
        tool_calls: assistantToolCalls,
      });

      const outputs = await Promise.all(
        assistantToolCalls.map(async (call) => {
          let args: Record<string, unknown> = {};
          if (call.function.arguments.trim()) {
            try {
              args = JSON.parse(call.function.arguments) as Record<
                string,
                unknown
              >;
            } catch {
              return {
                callId: call.id,
                output:
                  'ERROR: invalid tool arguments JSON. Retry with valid JSON.',
              };
            }
          }

          const output = await new Promise<string>((resolve, reject) => {
            this.pendingToolResults.set(call.id, { resolve, reject });
            callbacks.onToolCall?.({
              name: call.function.name,
              args,
              callId: call.id,
            } as VoiceToolCallWithId);
          });
          return { callId: call.id, output };
        }),
      );

      for (const output of outputs) {
        messages.push({
          role: 'tool',
          tool_call_id: output.callId,
          content: output.output,
        });
      }

      return this.runCompletion({
        client,
        baseURL,
        model,
        messages,
        tools,
        signal,
        callbacks,
      });
    }

    const finalText = rawContent.trim();
    const finalSpeechText = cleanSpeechText(finalText);
    if (
      finalSpeechText &&
      finalSpeechText !== publishedSpeechText &&
      finalSpeechText.startsWith(publishedSpeechText)
    ) {
      const remainder = finalSpeechText.slice(publishedSpeechText.length);
      if (remainder) {
        callbacks.onSpeechDelta?.(remainder);
      }
    }
    return { text: finalText };
  }
}
