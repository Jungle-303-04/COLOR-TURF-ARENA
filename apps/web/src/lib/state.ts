import type { RoomSnapshot, StateDelta } from "@paint-arena/shared";

export const applyStateDelta = (snapshot: RoomSnapshot | null, delta: StateDelta): RoomSnapshot | null => {
  if (!snapshot || snapshot.roomCode !== delta.roomCode || delta.sequence <= snapshot.sequence) return snapshot;
  const grid = [...snapshot.grid];
  for (const cell of delta.changedCells) {
    const index = cell.y * snapshot.config.gridWidth + cell.x;
    if (index >= 0 && index < grid.length) grid[index] = cell.team;
  }
  return {
    ...snapshot,
    grid,
    players: delta.players,
    scores: delta.scores,
    remainingMs: delta.remainingMs,
    status: delta.status,
    winner: delta.winner,
    activeEvents: delta.activeEvents,
    announcement: delta.announcement,
    server: delta.server,
    sequence: delta.sequence,
    updatedAt: delta.updatedAt,
  };
};
