import { createClient, type RedisClientType } from "redis";
import type { PersistedRoomState } from "./game.js";

export interface SnapshotStorage {
  readonly kind: "memory" | "redis";
  connect(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;
  save(state: PersistedRoomState): Promise<void>;
  load(roomCode: string): Promise<PersistedRoomState | null>;
  loadAll(): Promise<PersistedRoomState[]>;
  acquireLease(roomCode: string, owner: string, ttlMs: number): Promise<boolean>;
  renewLease(roomCode: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(roomCode: string, owner: string): Promise<void>;
}

const snapshotKey = (roomCode: string) => `color-turf:room:${roomCode.toUpperCase()}:snapshot`;
const leaseKey = (roomCode: string) => `color-turf:room:${roomCode.toUpperCase()}:lease`;

export class MemorySnapshotStorage implements SnapshotStorage {
  readonly kind = "memory" as const;
  private readonly snapshots = new Map<string, string>();
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>();
  private ready = false;

  async connect(): Promise<void> { this.ready = true; }
  async close(): Promise<void> { this.ready = false; }
  isReady(): boolean { return this.ready; }

  async save(state: PersistedRoomState): Promise<void> {
    this.snapshots.set(state.roomCode, JSON.stringify(state));
  }

  async load(roomCode: string): Promise<PersistedRoomState | null> {
    const raw = this.snapshots.get(roomCode.toUpperCase());
    return raw ? JSON.parse(raw) as PersistedRoomState : null;
  }

  async loadAll(): Promise<PersistedRoomState[]> {
    return [...this.snapshots.values()].map((raw) => JSON.parse(raw) as PersistedRoomState);
  }

  async acquireLease(roomCode: string, owner: string, ttlMs: number): Promise<boolean> {
    const key = roomCode.toUpperCase();
    const lease = this.leases.get(key);
    if (lease && lease.expiresAt > Date.now() && lease.owner !== owner) return false;
    this.leases.set(key, { owner, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async renewLease(roomCode: string, owner: string, ttlMs: number): Promise<boolean> {
    const key = roomCode.toUpperCase();
    const lease = this.leases.get(key);
    if (!lease || lease.owner !== owner || lease.expiresAt <= Date.now()) return false;
    lease.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async releaseLease(roomCode: string, owner: string): Promise<void> {
    const key = roomCode.toUpperCase();
    if (this.leases.get(key)?.owner === owner) this.leases.delete(key);
  }
}

export class RedisSnapshotStorage implements SnapshotStorage {
  readonly kind = "redis" as const;
  private readonly client: RedisClientType;
  private ready = false;

  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (error) => {
      this.ready = false;
      console.error(JSON.stringify({ level: "error", message: "redis client error", error: error.message }));
    });
    this.client.on("ready", () => { this.ready = true; });
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
    this.ready = true;
  }

  async close(): Promise<void> {
    this.ready = false;
    if (this.client.isOpen) await this.client.quit();
  }

  isReady(): boolean { return this.ready && this.client.isReady; }

  async save(state: PersistedRoomState): Promise<void> {
    await this.client.set(snapshotKey(state.roomCode), JSON.stringify(state));
    for (const player of state.players) {
      await this.client.set(`color-turf:session:${player.id}`, JSON.stringify({
        roomCode: state.roomCode,
        playerId: player.id,
        nickname: player.nickname,
        team: player.team,
      }), { EX: 1800 });
    }
  }

  async load(roomCode: string): Promise<PersistedRoomState | null> {
    const raw = await this.client.get(snapshotKey(roomCode));
    return raw ? JSON.parse(raw) as PersistedRoomState : null;
  }

  async loadAll(): Promise<PersistedRoomState[]> {
    const keys = await this.client.keys("color-turf:room:*:snapshot");
    if (keys.length === 0) return [];
    const values = await this.client.mGet(keys);
    return values.filter((value): value is string => Boolean(value)).map((value) => JSON.parse(value) as PersistedRoomState);
  }

  async acquireLease(roomCode: string, owner: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(leaseKey(roomCode), owner, { NX: true, PX: ttlMs });
    return result === "OK";
  }

  async renewLease(roomCode: string, owner: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      { keys: [leaseKey(roomCode)], arguments: [owner, String(ttlMs)] },
    );
    return Number(result) === 1;
  }

  async releaseLease(roomCode: string, owner: string): Promise<void> {
    await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [leaseKey(roomCode)], arguments: [owner] },
    );
  }
}

export const createSnapshotStorage = (redisUrl = process.env.REDIS_URL): SnapshotStorage => (
  redisUrl ? new RedisSnapshotStorage(redisUrl) : new MemorySnapshotStorage()
);
