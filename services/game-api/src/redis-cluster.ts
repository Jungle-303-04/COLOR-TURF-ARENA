import { randomUUID } from "node:crypto";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient, type RedisClientType } from "redis";
import type { Server as SocketServer } from "socket.io";

const RPC_PREFIX = "color-turf:rpc";
const SOCKET_PREFIX = "color-turf:socket.io";

const leaseKey = (roomCode: string) => `color-turf:room:${roomCode.toUpperCase()}:lease`;
const requestChannel = (ownerId: string) => `${RPC_PREFIX}:request:${ownerId}`;
const responseChannel = (ownerId: string) => `${RPC_PREFIX}:response:${ownerId}`;

interface RpcRequest<TCommand> {
  id: string;
  requesterId: string;
  roomCode: string;
  command: TCommand;
}

interface RpcResponse<TResponse> {
  id: string;
  response: TResponse | null;
}

type PendingResponse<TResponse> = {
  resolve: (response: TResponse | null) => void;
  timer: NodeJS.Timeout;
};

const reportRedisError = (component: string) => (error: Error) => {
  if (process.env.NODE_ENV === "test") return;
  console.error(JSON.stringify({
    level: "error",
    message: `${component} Redis connection error`,
    error: error.message,
  }));
};

const closeClient = async (client: RedisClientType): Promise<void> => {
  if (client.isOpen) await client.quit();
};

/**
 * Direct, owner-targeted RPC for authoritative room mutations.
 *
 * Socket.IO server-side events broadcast to every replica. That is useful for
 * rare control messages, but turns high-rate player input into O(replicas)
 * work. This coordinator reads the room lease and sends each command only to
 * its current authority.
 */
export class RedisRoomCoordinator<TCommand, TResponse> {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly pending = new Map<string, PendingResponse<TResponse>>();
  private handler: ((command: TCommand) => Promise<TResponse> | TResponse) | null = null;
  private connected = false;

  constructor(
    url: string,
    readonly ownerId: string,
    private readonly timeoutMs = 800,
  ) {
    this.publisher = createClient({ url });
    this.subscriber = createClient({ url });
    this.publisher.on("error", reportRedisError("room RPC publisher"));
    this.subscriber.on("error", reportRedisError("room RPC subscriber"));
  }

  async connect(handler: (command: TCommand) => Promise<TResponse> | TResponse): Promise<void> {
    if (this.connected) return;
    this.handler = handler;
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(requestChannel(this.ownerId), (raw) => {
      void this.handleRequest(raw);
    });
    await this.subscriber.subscribe(responseChannel(this.ownerId), (raw) => {
      this.handleResponse(raw);
    });
    this.connected = true;
  }

  async locate(roomCode: string): Promise<string | null> {
    if (!this.connected || !this.publisher.isReady) return null;
    try {
      return await this.publisher.get(leaseKey(roomCode));
    } catch {
      return null;
    }
  }

  async request(roomCode: string, command: TCommand): Promise<TResponse | null> {
    const ownerId = await this.locate(roomCode);
    if (!ownerId) return null;
    if (ownerId === this.ownerId) return this.handler?.(command) ?? null;
    const first = await this.requestOwner(ownerId, roomCode, command);
    if (first !== null) return first;

    // The authority may have changed during a rolling restart. Retry once only
    // when the lease points at a different live owner.
    const nextOwnerId = await this.locate(roomCode);
    if (!nextOwnerId || nextOwnerId === ownerId) return null;
    if (nextOwnerId === this.ownerId) return this.handler?.(command) ?? null;
    return this.requestOwner(nextOwnerId, roomCode, command);
  }

  private async requestOwner(ownerId: string, roomCode: string, command: TCommand): Promise<TResponse | null> {
    if (!this.publisher.isReady) return null;
    const id = randomUUID();
    const result = new Promise<TResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
    const request: RpcRequest<TCommand> = { id, requesterId: this.ownerId, roomCode, command };
    try {
      await this.publisher.publish(requestChannel(ownerId), JSON.stringify(request));
    } catch {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(null);
      }
    }
    return result;
  }

  private async handleRequest(raw: string): Promise<void> {
    if (!this.handler) return;
    try {
      const request = JSON.parse(raw) as RpcRequest<TCommand>;
      if (!request.id || !request.requesterId || !request.roomCode) return;
      // A lease can move between the requester's lookup and message delivery.
      // Recheck at the authority boundary so two replicas never mutate a room.
      const activeOwner = await this.locate(request.roomCode);
      const response = activeOwner === this.ownerId
        ? await this.handler(request.command)
        : null;
      const payload: RpcResponse<TResponse> = { id: request.id, response };
      await this.publisher.publish(responseChannel(request.requesterId), JSON.stringify(payload));
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.error(JSON.stringify({
          level: "error",
          message: "room RPC request failed",
          error: error instanceof Error ? error.message : "Unknown RPC error",
        }));
      }
    }
  }

  private handleResponse(raw: string): void {
    try {
      const response = JSON.parse(raw) as RpcResponse<TResponse>;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response.response);
    } catch {
      // Ignore responses that do not match this version's JSON contract.
    }
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pending.clear();
    this.connected = false;
    this.handler = null;
    await Promise.all([closeClient(this.subscriber), closeClient(this.publisher)]);
  }
}

/** Shared Socket.IO rooms and broadcasts across every game-server replica. */
export class RedisSocketCluster {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private attached = false;

  constructor(url: string) {
    this.publisher = createClient({ url });
    this.subscriber = createClient({ url });
    this.publisher.on("error", reportRedisError("Socket.IO publisher"));
    this.subscriber.on("error", reportRedisError("Socket.IO subscriber"));
  }

  async attach(io: SocketServer): Promise<void> {
    if (this.attached) return;
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    io.adapter(createAdapter(this.publisher, this.subscriber, {
      key: SOCKET_PREFIX,
      requestsTimeout: 1_500,
      publishOnSpecificResponseChannel: true,
    }));
    this.attached = true;
  }

  async close(): Promise<void> {
    this.attached = false;
    await Promise.all([closeClient(this.subscriber), closeClient(this.publisher)]);
  }
}
