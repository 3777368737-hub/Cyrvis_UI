import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

import type {
  CyrvisActivityEvent,
  CyrvisMemorySnapshot,
  CyrvisMemoryTurn,
  CyrvisMemoryTurnRole,
} from '@shared/cyrvis';

import { buildMemoryContext, isSensitiveMemoryText } from './memory-context';

interface DurableFact {
  id: string;
  text: string;
  createdAt: number;
  lastUsedAt: number;
}

interface VoiceMemoryFile {
  version: 1;
  turns: CyrvisMemoryTurn[];
  activities: CyrvisActivityEvent[];
  facts: DurableFact[];
}

const EMPTY_MEMORY: VoiceMemoryFile = {
  version: 1,
  turns: [],
  activities: [],
  facts: [],
};

const MAX_TURNS = 80;
const MAX_ACTIVITIES = 120;
const MAX_FACTS = 100;

class VoiceMemoryService {
  private writeQueue: Promise<unknown> = Promise.resolve();

  private getFilePath(): string {
    return path.join(app.getPath('userData'), 'cyrvis-memory.json');
  }

  private async read(): Promise<VoiceMemoryFile> {
    try {
      const parsed = JSON.parse(
        await readFile(this.getFilePath(), 'utf8'),
      ) as Partial<VoiceMemoryFile>;
      const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
      return {
        version: 1,
        turns: Array.isArray(parsed.turns) ? parsed.turns : [],
        activities: Array.isArray(parsed.activities) ? parsed.activities : [],
        facts: facts.flatMap((fact) => {
          if (typeof fact === 'string') {
            return [
              {
                id: randomUUID(),
                text: fact,
                createdAt: 0,
                lastUsedAt: 0,
              },
            ];
          }
          if (
            fact &&
            typeof fact === 'object' &&
            typeof fact.text === 'string'
          ) {
            return [fact];
          }
          return [];
        }),
      };
    } catch {
      return { ...EMPTY_MEMORY };
    }
  }

  private async write(memory: VoiceMemoryFile): Promise<void> {
    await mkdir(path.dirname(this.getFilePath()), { recursive: true });
    await writeFile(
      this.getFilePath(),
      `${JSON.stringify(memory, null, 2)}\n`,
      'utf8',
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  async appendTurn(
    role: CyrvisMemoryTurnRole,
    text: string,
  ): Promise<CyrvisMemoryTurn | null> {
    const normalized = text.trim();
    if (!normalized || isSensitiveMemoryText(normalized)) {
      return null;
    }

    return this.enqueue(async () => {
      const memory = await this.read();
      const turn: CyrvisMemoryTurn = {
        id: randomUUID(),
        role,
        text: normalized,
        createdAt: Date.now(),
      };
      memory.turns = [...memory.turns, turn].slice(-MAX_TURNS);
      await this.write(memory);
      return turn;
    });
  }

  async appendActivity(event: CyrvisActivityEvent): Promise<void> {
    if (!event.text.trim() || isSensitiveMemoryText(event.text)) {
      return;
    }

    await this.enqueue(async () => {
      const memory = await this.read();
      memory.activities = [...memory.activities, event].slice(-MAX_ACTIVITIES);
      await this.write(memory);
    });
  }

  async rememberFact(text: string): Promise<string | null> {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error('Memory text cannot be empty');
    }
    if (isSensitiveMemoryText(normalized)) {
      throw new Error('Secrets cannot be stored in long-term memory');
    }

    return this.enqueue(async () => {
      const memory = await this.read();
      const existing = memory.facts.find(
        (fact) => fact.text.toLowerCase() === normalized.toLowerCase(),
      );
      if (existing) {
        existing.lastUsedAt = Date.now();
        await this.write(memory);
        return existing.text;
      }

      memory.facts = [
        ...memory.facts,
        {
          id: randomUUID(),
          text: normalized,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        },
      ].slice(-MAX_FACTS);
      await this.write(memory);
      return normalized;
    });
  }

  async getContext(): Promise<string> {
    const memory = await this.read();
    return buildMemoryContext(
      memory.turns,
      memory.facts
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .map((fact) => fact.text),
    );
  }

  async getSnapshot(): Promise<CyrvisMemorySnapshot> {
    const memory = await this.read();
    return {
      turns: memory.turns,
      activities: memory.activities,
      facts: memory.facts
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .map((fact) => fact.text),
    };
  }
}

export const voiceMemoryService = new VoiceMemoryService();
