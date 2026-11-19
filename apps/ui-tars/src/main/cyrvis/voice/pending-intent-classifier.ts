import OpenAI from 'openai';

import type { PendingConfirmationSnapshot } from '../tools/types';

export type PendingIntentLabel =
  | 'confirm'
  | 'cancel'
  | 'new_command'
  | 'unclear';

export interface PendingIntentDecision {
  intent: PendingIntentLabel;
  confidence: number;
  reason: string;
}

export interface PendingIntentInput {
  text: string;
  pending: PendingConfirmationSnapshot;
  context?: string;
}

export interface PendingIntentClassifierOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

const clampConfidence = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(1, number));
};

const parseDecision = (value: string): PendingIntentDecision | null => {
  try {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || value;
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    const json =
      start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
    const parsed = JSON.parse(json) as {
      intent?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    if (
      parsed.intent !== 'confirm' &&
      parsed.intent !== 'cancel' &&
      parsed.intent !== 'new_command' &&
      parsed.intent !== 'unclear'
    ) {
      return null;
    }
    return {
      intent: parsed.intent,
      confidence: clampConfidence(parsed.confidence),
      reason:
        typeof parsed.reason === 'string'
          ? parsed.reason.slice(0, 200)
          : 'semantic classification',
    };
  } catch {
    return null;
  }
};

export class PendingIntentClassifier {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: PendingIntentClassifierOptions) {
    this.client = new OpenAI({
      // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      timeout: options.timeoutMs ?? 3_000,
      maxRetries: 0,
    });
    this.model = options.model || 'qwen-plus';
  }

  async classify(input: PendingIntentInput): Promise<PendingIntentDecision> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Classify a reply to a pending high-risk action. Return JSON only: ' +
            '{"intent":"confirm|cancel|new_command|unclear","confidence":0..1,"reason":"short"}. ' +
            'Use confirm only for an unambiguous affirmative response to the pending action. ' +
            'Use cancel for refusal or cancellation. Use new_command when the user asks for a different action. ' +
            'When uncertain, use unclear. Never execute the action.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            reply: input.text.slice(0, 500),
            pending: {
              tool: input.pending.tool,
              risk: input.pending.risk,
              domain: input.pending.domain,
              reason: input.pending.confirmationReason,
            },
            recentContext: input.context?.slice(-1_500) || '',
          }),
        },
      ],
    });
    const content = response.choices[0]?.message?.content?.trim() || '';
    return (
      parseDecision(content) || {
        intent: 'unclear',
        confidence: 0,
        reason: 'invalid classifier response',
      }
    );
  }
}

export const createPendingIntentClassifier = (
  options: PendingIntentClassifierOptions,
): PendingIntentClassifier | null =>
  options.apiKey.trim() ? new PendingIntentClassifier(options) : null;
