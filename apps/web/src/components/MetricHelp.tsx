import { useId } from "react";

interface MetricHelpProps {
  label: string;
  description: string;
  source: string;
}

export const MetricHelp = ({ label, description, source }: MetricHelpProps) => {
  const tooltipId = useId();

  return (
    <span className="metric-help">
      <button type="button" aria-label={`${label} 설명`} aria-describedby={tooltipId}>?</button>
      <span className="metric-help-popover" id={tooltipId} role="tooltip">
        <b>{description}</b>
        <small>출처 · {source}</small>
      </span>
    </span>
  );
};

export const MetricLabel = ({ label, description, source }: MetricHelpProps) => (
  <span className="metric-label">
    <span className="metric-label-text">{label}</span>
    <MetricHelp label={label} description={description} source={source} />
  </span>
);
