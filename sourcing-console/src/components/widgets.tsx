import { ReactNode } from "react";

export function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

const BAND_LABELS: Record<string, string> = {
  strong: "Strong signal",
  moderate: "Moderate",
  weak: "Weak",
  insufficient: "Insufficient",
};

export function BandPill({ band }: { band: string | null | undefined }) {
  if (!band) return <span className="pill insufficient">Not scanned</span>;
  return <span className={`pill ${band}`}>{BAND_LABELS[band] ?? band}</span>;
}

export function ScorePct({ value }: { value: number }) {
  return (
    <span className="score-big">
      {Math.round(value * 100)}
      <small>%</small>
    </span>
  );
}

export function BarRow({
  label,
  pct,
  detail,
  title,
}: {
  label: string;
  pct: number;
  detail?: string;
  title?: string;
}) {
  return (
    <div className="bar-row" title={title ?? `${label}: ${Math.round(pct * 100)}%`}>
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${Math.max(pct * 100, 1.5)}%` }} />
      </div>
      <span className="bar-value">{detail ?? `${Math.round(pct * 100)}%`}</span>
    </div>
  );
}

export function CategoryBars({
  scores,
}: {
  scores: Record<string, { earned: number; possible: number; pct: number }>;
}) {
  const entries = Object.entries(scores).sort((a, b) => b[1].pct - a[1].pct);
  return (
    <div>
      {entries.map(([category, score]) => (
        <BarRow
          key={category}
          label={category}
          pct={score.pct}
          detail={`${score.earned}/${score.possible}`}
          title={`${category}: ${Math.round(score.pct * 100)}% (${score.earned} of ${score.possible} points)`}
        />
      ))}
    </div>
  );
}

export function ResultMark({ result }: { result: "confirmed" | "absent" | "unknown" }) {
  if (result === "confirmed") return <span className="pill strong">Y</span>;
  if (result === "absent") return <span className="pill insufficient">N</span>;
  return <span className="pill medium">?</span>;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
