declare module 'ws' {
  import { EventEmitter } from 'node:events';

  export interface ClientOptions {
    headers?: Record<string, string>;
    handshakeTimeout?: number;
    perMessageDeflate?: boolean;
  }

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocketServer extends EventEmitter {
    constructor(options: {
      server?: unknown;
      path?: string;
      host?: string;
      port?: number;
    });
    on(
      event: 'connection',
      listener: (socket: WebSocket, request: unknown) => void,
    ): this;
    close(callback?: () => void): void;
  }

  export default class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    static readonly CLOSED: number;

    constructor(url: string, options?: ClientOptions);

    readonly readyState: number;

    send(
      data: string | Buffer | ArrayBuffer | ArrayBufferView,
      callback?: (error?: Error) => void,
    ): void;
    send(
      data: string | Buffer | ArrayBuffer | ArrayBufferView,
      options: { binary?: boolean; compress?: boolean },
      callback?: (error?: Error) => void,
    ): void;
    close(code?: number, reason?: string): void;

    once(event: 'open', listener: () => void): this;
    on(event: 'open', listener: () => void): this;
    once(
      event: 'message',
      listener: (data: RawData, isBinary: boolean) => void,
    ): this;
    on(
      event: 'message',
      listener: (data: RawData, isBinary: boolean) => void,
    ): this;
    once(event: 'error', listener: (error: Error) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    once(
      event: 'close',
      listener: (code: number, reason: Buffer) => void,
    ): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    removeAllListeners(event?: string): this;
  }
}
