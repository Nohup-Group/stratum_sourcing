import { useEffect, useState } from "react";
import { api } from "../api";
import { Overview } from "../types";
import {BarRow, StatTile} from "../components/widgets";

const SOURCE_CATEGORY_LABELS: Record<string, string> = {
  company: "Companies",
  person: "People / thought leaders",
  association: "Associations & institutions",
  newsletter: "Newsletters",
  university: "Universities",
  conference: "Conferences",
  vc: "VC portfolios",
  regulator: "Regulators",
};

const BAND_ORDER = [
  "strong",
  "moderate",
  "weak",
  "poor",
  "insufficient-evidence",
] as const;
const BAND_LABELS: Record<string, string> = {
  strong: "Strong (≥70%)",
  moderate: "Moderate (50–69%)",
  weak: "Weak (35–49%)",
  poor: "Poor (<35%)",
  "insufficient-evidence": "Insufficient evidence (<40% coverage)",
};

export default function PipelinePage() {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    api.get<Overview>("/api/console/overview").then(setData);
  }, []);

  if (!data) return <div className="loading">Loading pipeline…</div>;

  const attributionTotal = Object.values(data.attribution).reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="page-head">
        <h1>Pipeline</h1>
      </div>
      <p className="page-sub">
        Continuous monitoring across {data.sources.total} sources. Every finding is
        scored against the thesis; promising companies graduate to a 200-signal scan.
      </p>

      <div className="grid tiles">
        <StatTile
          label="Sources monitored"
          value={data.sources.total}
          note={`${Object.keys(data.sources.by_category).length} categories`}
        />
        <StatTile
          label="Findings"
          value={data.findings.total.toLocaleString()}
          note={
            <>
              <span className="up">+{data.findings.last_7_days}</span> this week
            </>
          }
        />
        <StatTile
          label="Companies tracked"
          value={data.companies.total.toLocaleString()}
          note={
            <>
              <span className="up">+{data.companies.new_last_7_days}</span> this week
            </>
          }
        />
        <StatTile
          label="Signal-scanned"
          value={data.scans.companies_scanned}
          note="200-signal framework"
        />
        <StatTile
          label="Strong + moderate"
          value={(data.scans.bands.strong ?? 0) + (data.scans.bands.moderate ?? 0)}
          note="ready for first call"
        />
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="section-title">Coverage by source type</div>
          {attributionTotal === 0 ? (
            <div className="empty">No attribution data yet.</div>
          ) : (
            Object.entries(data.attribution)
              .sort((a, b) => b[1] - a[1])
              .map(([category, count]) => (
                <BarRow
                  key={category}
                  label={SOURCE_CATEGORY_LABELS[category] ?? category}
                  pct={count / attributionTotal}
                  detail={String(count)}
                  title={`${count} companies first surfaced via ${category} sources`}
                />
              ))
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>
            How much raw coverage each source type produces — not how many
            investable companies it yields. See the sourcing map for that:
            registers and sandbox cohorts convert far better than newsletters.
          </p>
        </div>

        <div className="card">
          <div className="section-title">Scan verdicts</div>
          {data.scans.companies_scanned === 0 ? (
            <div className="empty">No signal scans completed yet.</div>
          ) : (
            BAND_ORDER.map((band) => (
              <BarRow
                key={band}
                label={BAND_LABELS[band]}
                pct={(data.scans.bands[band] ?? 0) / Math.max(data.scans.companies_scanned, 1)}
                detail={String(data.scans.bands[band] ?? 0)}
              />
            ))
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>
            Latest completed scan per company, banded per the Stratum³ framework.
          </p>
        </div>
      </div>

    </>
  );
}
