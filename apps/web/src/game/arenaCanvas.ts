import type { PlayerPublic, RoomSnapshot, TeamId } from "@paint-arena/shared";

export const DEFAULT_CAMERA_SIZE = 72;

/*
 * Canvas responsibility pattern adapted from over-engineer/Socket.io-whiteboard
 * lib/whiteboard.js (MIT): align the backing store to the CSS box and render
 * server-owned state through one adapter. No client paint coordinates are sent.
 */

export interface ArenaCanvasOptions {
  mode?: "full" | "follow" | "minimap";
  viewportWidthCells?: number;
  viewportHeightCells?: number;
}

export interface CameraViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasFit {
  cellSize: number;
  renderWidth: number;
  renderHeight: number;
  offsetX: number;
  offsetY: number;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export const getCanvasFit = (canvasWidth: number, canvasHeight: number, viewportWidth: number, viewportHeight: number): CanvasFit => {
  const cellSize = Math.min(canvasWidth / viewportWidth, canvasHeight / viewportHeight);
  const renderWidth = viewportWidth * cellSize;
  const renderHeight = viewportHeight * cellSize;
  return {
    cellSize,
    renderWidth,
    renderHeight,
    offsetX: (canvasWidth - renderWidth) / 2,
    offsetY: (canvasHeight - renderHeight) / 2,
  };
};

export const getCameraViewport = (
  gridWidth: number,
  gridHeight: number,
  focusX: number,
  focusY: number,
  requestedWidth = DEFAULT_CAMERA_SIZE,
  requestedHeight = DEFAULT_CAMERA_SIZE,
): CameraViewport => {
  const width = Math.min(gridWidth, Math.max(24, requestedWidth));
  const height = Math.min(gridHeight, Math.max(14, requestedHeight));
  return {
    left: clamp(focusX - width / 2, 0, Math.max(0, gridWidth - width)),
    top: clamp(focusY - height / 2, 0, Math.max(0, gridHeight - height)),
    width,
    height,
  };
};

export class ArenaCanvasRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly mode: NonNullable<ArenaCanvasOptions["mode"]>;
  private readonly viewportWidthCells: number;
  private readonly viewportHeightCells: number;
  private snapshot: RoomSnapshot | null = null;
  private focusPlayerId: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private previousPositions = new Map<string, { x: number; y: number }>();

  constructor(private readonly canvas: HTMLCanvasElement, options: ArenaCanvasOptions = {}) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D context is unavailable");
    this.context = context;
    this.mode = options.mode ?? "full";
    this.viewportWidthCells = Math.max(24, options.viewportWidthCells ?? DEFAULT_CAMERA_SIZE);
    this.viewportHeightCells = Math.max(14, options.viewportHeightCells ?? DEFAULT_CAMERA_SIZE);
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas);
  }

  update(snapshot: RoomSnapshot, focusPlayerId?: string | null): void {
    this.previousPositions = new Map(this.snapshot?.players.map((player) => [player.id, { ...player.position }]) ?? []);
    this.snapshot = snapshot;
    this.focusPlayerId = focusPlayerId ?? null;
    this.draw();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private resizeBackingStore(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width: rect.width, height: rect.height };
  }

  private viewport(snapshot: RoomSnapshot, focus: PlayerPublic | undefined): CameraViewport {
    const { gridWidth, gridHeight } = snapshot.config;
    if (this.mode !== "follow" || !focus) return { left: 0, top: 0, width: gridWidth, height: gridHeight };
    return getCameraViewport(gridWidth, gridHeight, focus.position.x, focus.position.y, this.viewportWidthCells, this.viewportHeightCells);
  }

  private draw(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const { width, height } = this.resizeBackingStore();
    const ctx = this.context;
    const { gridWidth, gridHeight, teams } = snapshot.config;
    const focus = snapshot.players.find((player) => player.id === this.focusPlayerId);
    const viewport = this.viewport(snapshot, focus);
    const { cellSize, renderWidth, renderHeight, offsetX, offsetY } = getCanvasFit(width, height, viewport.width, viewport.height);
    const startX = Math.max(0, Math.floor(viewport.left));
    const endX = Math.min(gridWidth, Math.ceil(viewport.left + viewport.width));
    const startY = Math.max(0, Math.floor(viewport.top));
    const endY = Math.min(gridHeight, Math.ceil(viewport.top + viewport.height));
    const toCanvasX = (value: number) => offsetX + (value - viewport.left) * cellSize;
    const toCanvasY = (value: number) => offsetY + (value - viewport.top) * cellSize;

    ctx.fillStyle = "#090b13";
    ctx.fillRect(0, 0, width, height);
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const owner = snapshot.grid[y * gridWidth + x];
        if (!owner) continue;
        const drawX = toCanvasX(x);
        const drawY = toCanvasY(y);
        ctx.fillStyle = teams[owner].softColor;
        ctx.fillRect(drawX, drawY, Math.ceil(cellSize + 0.5), Math.ceil(cellSize + 0.5));
        ctx.globalAlpha = 0.44;
        ctx.fillStyle = teams[owner].color;
        ctx.fillRect(drawX, drawY, Math.ceil(cellSize + 0.5), Math.ceil(cellSize + 0.5));
        ctx.globalAlpha = 1;
      }
    }

    ctx.strokeStyle = "rgba(255,255,255,.09)";
    ctx.lineWidth = 1;
    ctx.strokeRect(offsetX + 0.5, offsetY + 0.5, renderWidth - 1, renderHeight - 1);
    for (const player of snapshot.players) {
      if (player.position.x < viewport.left - 1 || player.position.x > viewport.left + viewport.width + 1 || player.position.y < viewport.top - 1 || player.position.y > viewport.top + viewport.height + 1) continue;
      const centerX = toCanvasX(player.position.x);
      const centerY = toCanvasY(player.position.y);
      const team = teams[player.team as TeamId];
      const radius = this.mode === "minimap" ? Math.max(2, Math.min(renderWidth / 90, 5)) : this.mode === "follow" ? Math.max(7, Math.min(renderWidth / 34, 15)) : Math.max(4, Math.min(renderWidth / 60, 12));
      ctx.save();
      ctx.globalAlpha = player.connected ? 1 : 0.35;
      const previous = this.previousPositions.get(player.id);
      if (previous) {
        const previousX = toCanvasX(previous.x);
        const previousY = toCanvasY(previous.y);
        const distance = Math.hypot(centerX - previousX, centerY - previousY);
        if (distance > 0.2 && previousX >= offsetX - radius && previousX <= offsetX + renderWidth + radius && previousY >= offsetY - radius && previousY <= offsetY + renderHeight + radius) {
          ctx.globalAlpha = player.connected ? 0.8 : 0.2;
          ctx.strokeStyle = team.color;
          ctx.lineWidth = Math.max(this.mode === "minimap" ? 1 : 2, radius * 0.45);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(previousX, previousY);
          ctx.lineTo(centerX, centerY);
          ctx.stroke();
          ctx.globalAlpha = player.connected ? 1 : 0.35;
        }
      }
      ctx.shadowColor = team.color;
      ctx.shadowBlur = player.id === this.focusPlayerId ? radius * 2.4 : this.mode === "minimap" ? 2 : radius;
      ctx.fillStyle = team.color;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = player.id === this.focusPlayerId ? (this.mode === "minimap" ? 2 : 3) : 1.5;
      ctx.strokeStyle = player.id === this.focusPlayerId ? "#ffffff" : "rgba(255,255,255,.7)";
      ctx.stroke();
      if (player.isBot && this.mode !== "minimap") {
        ctx.fillStyle = "#080a10";
        ctx.font = `800 ${Math.max(6, radius * .85)}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("B", centerX, centerY + .5);
      }
      if (this.mode === "follow") {
        const isFocus = player.id === this.focusPlayerId;
        const label = isFocus ? `YOU · ${player.nickname}` : player.nickname;
        ctx.font = `${isFocus ? "900" : "800"} ${isFocus ? 10 : 9}px ui-monospace, monospace`;
        const labelWidth = ctx.measureText(label).width;
        const labelCenterX = clamp(centerX, offsetX + (labelWidth / 2) + 6, offsetX + renderWidth - (labelWidth / 2) - 6);
        const labelBaselineY = Math.max(offsetY + 14, centerY - radius - 7);
        ctx.fillStyle = isFocus ? "rgba(5,6,11,.88)" : "rgba(5,6,11,.72)";
        ctx.fillRect(labelCenterX - (labelWidth / 2) - 4, labelBaselineY - 11, labelWidth + 8, 14);
        ctx.fillStyle = isFocus ? "#ffffff" : team.color;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, labelCenterX, labelBaselineY);
      }
      ctx.restore();
    }

    if (this.mode === "minimap" && focus) {
      const camera = getCameraViewport(gridWidth, gridHeight, focus.position.x, focus.position.y, this.viewportWidthCells, this.viewportHeightCells);
      ctx.save();
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,.9)";
      ctx.strokeRect(offsetX + (camera.left / gridWidth) * renderWidth, offsetY + (camera.top / gridHeight) * renderHeight, (camera.width / gridWidth) * renderWidth, (camera.height / gridHeight) * renderHeight);
      ctx.restore();
    }

    if (this.mode === "follow") {
      const centerX = offsetX + renderWidth / 2;
      const centerY = offsetY + renderHeight / 2;
      const vignette = ctx.createRadialGradient(centerX, centerY, Math.min(renderWidth, renderHeight) * 0.18, centerX, centerY, Math.max(renderWidth, renderHeight) * 0.72);
      vignette.addColorStop(0.55, "rgba(3,4,9,0)");
      vignette.addColorStop(1, "rgba(3,4,9,.68)");
      ctx.fillStyle = vignette;
      ctx.fillRect(offsetX, offsetY, renderWidth, renderHeight);
    }
  }
}
