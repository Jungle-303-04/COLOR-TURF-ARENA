import { useEffect, useRef } from "react";
import { formatNumber } from "../lib/format";
import { MetricLabel } from "./MetricHelp";

export interface MetricPoint {
  at: number;
  value: number;
}

interface MetricChartProps {
  title: string;
  unit: string;
  description: string;
  source: string;
  color: string;
  points: MetricPoint[];
  decimals?: number;
  refreshInterval?: string;
}

export const MetricChart = ({ title, unit, description, source, color, points, decimals = 1, refreshInterval }: MetricChartProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latest = [...points].reverse().find((point) => Number.isFinite(point.value))?.value;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const width = rect.width;
      const height = rect.height;
      const top = 8;
      const bottom = height - 15;
      const left = 6;
      const right = width - 6;

      context.clearRect(0, 0, width, height);
      context.strokeStyle = "rgba(255,255,255,.075)";
      context.lineWidth = 1;
      for (let row = 0; row <= 3; row += 1) {
        const y = top + ((bottom - top) * row) / 3;
        context.beginPath();
        context.moveTo(left, y + 0.5);
        context.lineTo(right, y + 0.5);
        context.stroke();
      }

      const finitePoints = points.filter((point) => Number.isFinite(point.value));
      if (finitePoints.length === 0) return;
      const maximum = Math.max(1, ...finitePoints.map((point) => point.value)) * 1.12;
      const xFor = (index: number) => finitePoints.length === 1 ? (left + right) / 2 : left + ((right - left) * index) / (finitePoints.length - 1);
      const yFor = (value: number) => bottom - (clamp(value / maximum, 0, 1) * (bottom - top));

      const gradient = context.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, `${color}45`);
      gradient.addColorStop(1, `${color}00`);
      context.beginPath();
      finitePoints.forEach((point, index) => {
        const x = xFor(index);
        const y = yFor(point.value);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.lineTo(xFor(finitePoints.length - 1), bottom);
      context.lineTo(xFor(0), bottom);
      context.closePath();
      context.fillStyle = gradient;
      context.fill();

      context.beginPath();
      finitePoints.forEach((point, index) => {
        const x = xFor(index);
        const y = yFor(point.value);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.stroke();

      const lastIndex = finitePoints.length - 1;
      context.fillStyle = color;
      context.beginPath();
      context.arc(xFor(lastIndex), yFor(finitePoints[lastIndex]?.value ?? 0), 3, 0, Math.PI * 2);
      context.fill();
    };

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [color, points]);

  return <article className="metric-chart-card"><div className="metric-chart-heading"><div><MetricLabel label={title} description={description} source={source} unit={unit || "개수"} refreshInterval={refreshInterval ?? "Socket.IO Ops Snapshot 수신 시 · 약 1초"} valueKind="actual" /><small>{description}</small></div><strong>{latest === undefined ? "—" : formatNumber(latest, decimals)}<em>{latest === undefined ? "" : unit}</em></strong></div><canvas ref={canvasRef} aria-label={`${title} 최근 2분 시계열 그래프`} /></article>;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
