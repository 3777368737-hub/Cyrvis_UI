import type { ContextEvent } from './types';

export class ContextEventBus {
  private readonly listeners = new Set<(event: ContextEvent) => void>();

  emit(event: ContextEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Context observers must not interrupt state collection.
      }
    }
  }

  subscribe(listener: (event: ContextEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
