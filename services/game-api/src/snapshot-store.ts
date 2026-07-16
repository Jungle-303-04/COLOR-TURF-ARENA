import { createClient, type RedisClientType } from "redis";
import type { EventLogEntry } from "@paint-arena/shared";
import type { PersistedRoomState } from "./game.js";

export interface SnapshotStorage {
  readonly kind: "memory" | "redis";
  connect(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;
  save(state: PersistedRoomState): Promise<void>;
  load(roomCode: string): Promise<PersistedRoomState | null>;
  loadAll(): Promise<PersistedRoomState[]>;
  activeRoomCode(): Promise<string | null>;
  activateSingleRoom(roomCode: string): Promise<void>;
  appendEvent(entry: EventLogEntry): Promise<void>;
  loadRecentEvents(limit?: number): Promise<EventLogEntry[]>;
  clearAll(): Promise<void>;
  acquireLease(roomCode: string, owner: string, ttlMs: number): Promise<boolean>;
  renewLease(roomCode: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(roomCode: string, owner: string): Promise<void>;
}

const snapshotKey = (roomCode: string) => `color-turf:room:${roomCode.toUpperCase()}:snapshot`;
const leaseKey = (roomCode: string) => `color-turf:room:${roomCode.toUpperCase()}:lease`;
const opsEventsKey = "color-turf:ops:events";
const MAX_RECENT_EVENTS = 200;
const eventLimit = (limit: number): number => Math.max(0, Math.min(MAX_RECENT_EVENTS, Math.floor(limit)));

export class MemorySnapshotStorage implements SnapshotStorage {
  readonly kind = "memory" as const;
  private readonly snapshots = new Map<string, string>();
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>();
  private readonly events: string[] = [];
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

  async activeRoomCode(): Promise<string | null> {
    return this.snapshots.keys().next().value ?? null;
  }

  async activateSingleRoom(roomCode: string): Promise<void> {
    const keep = roomCode.toUpperCase();
    for (const code of [...this.snapshots.keys()]) if (code !== keep) this.snapshots.delete(code);
    for (const code of [...this.leases.keys()]) if (code !== keep) this.leases.delete(code);
  }

  async appendEvent(entry: EventLogEntry): Promise<void> {
    this.events.unshift(JSON.stringify(entry));
    if (this.events.length > MAX_RECENT_EVENTS) this.events.length = MAX_RECENT_EVENTS;
  }

  async loadRecentEvents(limit = MAX_RECENT_EVENTS): Promise<EventLogEntry[]> {
    return this.events
      .slice(0, eventLimit(limit))
      .map((raw) => JSON.parse(raw) as EventLogEntry);
  }

  async clearAll(): Promise<void> {
    this.snapshots.clear();
    this.leases.clear();
    this.events.length = 0;
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
  private readonly activeRoomKey = "color-turf:active-room";

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
    const activeRoom = await this.activeRoomCode();
    if (activeRoom && activeRoom !== state.roomCode.toUpperCase()) return;
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
    const activeRoom = await this.activeRoomCode();
    const keys = activeRoom
      ? [snapshotKey(activeRoom)]
      : await this.client.keys("color-turf:room:*:snapshot");
    if (keys.length === 0) return [];
    const values = await this.client.mGet(keys);
    return values.filter((value): value is string => Boolean(value)).map((value) => JSON.parse(value) as PersistedRoomState);
  }

  async activeRoomCode(): Promise<string | null> {
    return this.client.get(this.activeRoomKey);
  }

  async activateSingleRoom(roomCode: string): Promise<void> {
    const keep = roomCode.toUpperCase();
    await this.client.set(this.activeRoomKey, keep);
    const keys = await this.client.keys("color-turf:*");
    const stale = keys.filter((key) => key !== this.activeRoomKey && key !== snapshotKey(keep) && key !== opsEventsKey);
    if (stale.length > 0) await this.client.del(stale);
  }

  async appendEvent(entry: EventLogEntry): Promise<void> {
    await this.client.multi()
      .lPush(opsEventsKey, JSON.stringify(entry))
      .lTrim(opsEventsKey, 0, MAX_RECENT_EVENTS - 1)
      .exec();
  }

  async loadRecentEvents(limit = MAX_RECENT_EVENTS): Promise<EventLogEntry[]> {
    const boundedLimit = eventLimit(limit);
    if (boundedLimit === 0) return [];
    const values = await this.client.lRange(opsEventsKey, 0, boundedLimit - 1);
    const entries: EventLogEntry[] = [];
    for (const value of values) {
      try {
        entries.push(JSON.parse(value) as EventLogEntry);
      } catch {
        // Ignore a malformed historical entry so observability remains available.
      }
    }
    return entries;
  }

  async clearAll(): Promise<void> {
    const keys = await this.client.keys("color-turf:*");
    if (keys.length > 0) await this.client.del(keys);
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
