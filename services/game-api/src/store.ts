import type { GameConfig, RoomSnapshot, RoomSummary, ServerIdentity, TeamId } from "@paint-arena/shared";
import { DEFAULT_GAME_CONFIG, GameRoom, type GameEvent, type PersistedRoomState } from "./game.js";

export interface RoomStore {
  create(config?: GameConfig): GameRoom;
  restore(state: PersistedRoomState, preserveConnections?: boolean): GameRoom;
  replace(state: PersistedRoomState): GameRoom;
  remove(roomCode: string): GameRoom | undefined;
  get(roomCode: string): GameRoom | undefined;
  list(): GameRoom[];
  tickAll(): GameRoom[];
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, GameRoom>();

  constructor(
    private readonly onRoomEvent: (roomCode: string, event: GameEvent) => void,
    private readonly identity: () => ServerIdentity,
  ) {}

  private options(code: string) {
    return {
      serverIdentity: this.identity(),
      onEvent: (event: GameEvent) => this.onRoomEvent(code, event),
    };
  }

  create(config: GameConfig = DEFAULT_GAME_CONFIG): GameRoom {
    let code = "";
    do {
      code = Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
    } while (this.rooms.has(code));
    const room = new GameRoom(code, config, this.options(code));
    this.rooms.set(code, room);
    return room;
  }

  restore(state: PersistedRoomState, preserveConnections = false): GameRoom {
    const code = state.roomCode.toUpperCase();
    if (this.rooms.has(code)) return this.rooms.get(code)!;
    const room = GameRoom.restore(state, { ...this.options(code), preserveConnections });
    room.setServerIdentity(this.identity());
    this.rooms.set(code, room);
    return room;
  }

  replace(state: PersistedRoomState): GameRoom {
    const code = state.roomCode.toUpperCase();
    const room = GameRoom.restore(state, this.options(code));
    room.setServerIdentity(this.identity());
    this.rooms.set(code, room);
    return room;
  }

  remove(roomCode: string): GameRoom | undefined {
    const code = roomCode.toUpperCase();
    const room = this.rooms.get(code);
    this.rooms.delete(code);
    return room;
  }

  get(roomCode: string): GameRoom | undefined {
    return this.rooms.get(roomCode.toUpperCase());
  }

  list(): GameRoom[] {
    return [...this.rooms.values()];
  }

  tickAll(): GameRoom[] {
    return this.list().filter((room) => room.tick());
  }
}

export const summarizeRoom = (snapshot: RoomSnapshot): RoomSummary => {
  const teamPlayers: Record<TeamId, number> = { A: 0, B: 0 };
  const connectedTeamPlayers: Record<TeamId, number> = { A: 0, B: 0 };
  for (const player of snapshot.players) {
    teamPlayers[player.team] += 1;
    if (player.connected) connectedTeamPlayers[player.team] += 1;
  }
  const bots = snapshot.players.filter((player) => player.isBot).length;
  return {
    roomCode: snapshot.roomCode,
    status: snapshot.status,
    players: snapshot.players.length,
    humanPlayers: snapshot.players.length - bots,
    bots,
    connectedPlayers: snapshot.players.filter((player) => player.connected).length,
    teamPlayers,
    connectedTeamPlayers,
    scores: { ...snapshot.scores.cells },
    percentages: { ...snapshot.scores.percentage },
    remainingMs: snapshot.remainingMs,
    version: snapshot.server.version,
    cluster: snapshot.server.cluster,
    releaseChannel: snapshot.config.releaseChannel,
    broadcastMode: snapshot.server.broadcastMode,
    updatedAt: snapshot.updatedAt,
  };
};
