import type { PrefetchMessage, ServerMessage, ViewMessage } from '@way/shared';

export interface ConnectionHandlers {
  onMessage(msg: ServerMessage): void;
  onState(state: 'open' | 'closed'): void;
}

/** WebSocket to the API with automatic reconnection; the last view is replayed. */
export class Connection {
  private ws: WebSocket | null = null;
  private lastView: ViewMessage | null = null;
  private retry = 0;

  constructor(private handlers: ConnectionHandlers) {
    this.connect();
  }

  sendView(view: ViewMessage): void {
    this.lastView = view;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(view));
  }

  /** Background loads are not replayed: the idle loop sends them again. Returns whether it was sent. */
  sendPrefetch(msg: PrefetchMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.handlers.onState('open');
      if (this.lastView) ws.send(JSON.stringify(this.lastView));
    };
    ws.onmessage = (e) => {
      try {
        this.handlers.onMessage(JSON.parse(e.data as string) as ServerMessage);
      } catch (err) {
        console.warn('bad message', err);
      }
    };
    ws.onclose = () => {
      this.handlers.onState('closed');
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }
}
