import type { ServerWebSocket } from "bun";

type WSMessage = Record<string, unknown>;
type WSClient = ServerWebSocket<undefined>;

const clients = new Set<WSClient>();

export function broadcast(message: WSMessage): void {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    try {
      ws.send(data);
    } catch {
      clients.delete(ws);
    }
  }
}

export function addClient(ws: WSClient): void {
  clients.add(ws);
}

export function removeClient(ws: WSClient): void {
  clients.delete(ws);
}

export function getClientCount(): number {
  return clients.size;
}
