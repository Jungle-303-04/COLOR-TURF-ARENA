import { useId } from "react";

interface MetricHelpProps {
  label: string;
  description: string;
  source: string;
  unit?: string;
  refreshInterval?: string;
  valueKind?: "actual" | "configured" | "identity" | "simulation" | "mixed";
}

const valueKindLabels: Record<NonNullable<MetricHelpProps["valueKind"]>, string> = {
  actual: "실제 관측값",
  configured: "설정값",
  identity: "식별 정보",
  simulation: "데모 시뮬레이션",
  mixed: "실측·시뮬레이션 혼합",
};

export const MetricHelp = ({
  label,
  description,
  source,
  unit = "화면 표기 단위",
  refreshInterval = "Ops Snapshot 수신 시 · 약 1초",
  valueKind = "actual",
}: MetricHelpProps) => {
  const tooltipId = useId();

  return (
    <span className="metric-help">
      <button type="button" aria-label={`${label} 설명`} aria-describedby={tooltipId}>?</button>
      <span className="metric-help-popover" id={tooltipId} role="tooltip">
        <b>{description}</b>
        <span><small>단위</small><em>{unit}</em></span>
        <span><small>출처</small><em>{source}</em></span>
        <span><small>갱신</small><em>{refreshInterval}</em></span>
        <span><small>구분</small><em>{valueKindLabels[valueKind]}</em></span>
      </span>
    </span>
  );
};

export const MetricLabel = (props: MetricHelpProps) => (
  <span className="metric-label">
    <span className="metric-label-text">{props.label}</span>
    <MetricHelp {...props} />
  </span>
);
