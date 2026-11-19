import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import type { ConversationWithSoM } from '@main/shared/types';

export interface ConversationTurn {
  role: 'human' | 'assistant';
  text?: string;
  actions: string[];
  answers: string[];
}

const actionLabels: Record<string, string> = {
  call_user: 'Requested your input',
  error_env: 'Reported an environment error',
  hotkey: 'Used a keyboard shortcut',
  left_double: 'Double-click',
  right_single: 'Right-click',
  scroll: 'Scroll',
  type: 'Enter text',
  wait: 'Wait',
  click: 'Click',
  drag: 'Drag',
};

/** Presentation only: retain stored images and raw model data in the database. */
export function conversationTurns(
  messages: ConversationWithSoM[],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.from === 'human') {
      if (message.value?.trim() && message.value !== IMAGE_PLACEHOLDER)
        turns.push({
          role: 'human',
          text: message.value,
          actions: [],
          answers: [],
        });
      continue;
    }
    const steps = message.predictionParsed ?? [];
    const actions = steps
      .filter(
        (step) =>
          step.action_type &&
          !['screenshot', 'finished'].includes(step.action_type),
      )
      .map((step) => actionLabels[step.action_type] ?? 'Task action');
    const answers = steps
      .filter((step) => step.action_type === 'finished')
      .map((step) => step.action_inputs.content?.trim())
      .filter((answer): answer is string => Boolean(answer));
    if (
      !steps.length &&
      message.value?.trim() &&
      message.value !== IMAGE_PLACEHOLDER
    )
      answers.push(message.value.trim());
    const previous = turns.at(-1);
    if (previous?.role === 'assistant') {
      previous.actions.push(...actions);
      previous.answers.push(...answers);
    } else if (actions.length || answers.length) {
      turns.push({ role: 'assistant', actions, answers });
    }
  }
  return turns;
}
