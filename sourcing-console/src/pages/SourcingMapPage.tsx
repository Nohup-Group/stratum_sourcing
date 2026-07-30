import { useEffect, useState } from "react";
import { api } from "../api";
import { Provenance } from "../types";

const SOURCE_CATEGORY_LABELS: Record<string, string> = {
  register: "Regulatory registers",
  sandbox: "Sandboxes & pilot regimes",
  accelerator: "Accelerator cohorts",
  vc_portfolio: "VC portfolios",
  consortium: "Consortium rosters",
  association: "Industry associations",
  directory: "Ecosystem directories",
  conference: "Conference exhibitors",
  unknown: "Other",
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  company: "Companies",
  person: "People",
  investor: "Investors",
  regulator: "Regulators",
  media: "Media",
  event: "Events",
  association: "Associations",
  academic: "Academic",
  protocol: "Protocols",
  token: "Tokens & tickers",
  standard: "Standards & laws",
  product: "Products",
  place: "Places",
  concept: "Concepts",
};

const BAND_LABELS: Record<string, string> = {
  strong: "Strong",
  moderate: "Moderate",
  weak: "Weak",
  poor: "Poor",
  "insufficient-evidence": "Insufficient evidence",
};

export default function SourcingMapPage() {
  const [data, setData] = useState<Provenance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Provenance>("/api/console/provenance")
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="loading">Could not load sourcing map: {error}</div>;
  if (!data) return <div className="loading">Loading sourcing map…</div>;

  const top = data.funnel[0]?.count || 1;
  const sourceCats = Object.entries(data.companies_by_source_category).sort(
    (a, b) => b[1] - a[1],
  );
  const sourceTotal = sourceCats.reduce((sum, [, n]) => sum + n, 0) || 1;
  const entityTypes = Object.entries(data.entity_types).sort((a, b) => b[1] - a[1]);
  const entityTotal = entityTypes.reduce((sum, [, n]) => sum + n, 0) || 1;
  const histMax = Math.max(...data.score_histogram.map((h) => h.count), 1);

  return (
    <>
      <div className="page-head">
        <h1>Sourcing map</h1>
      </div>
      <p className="page-sub">
        How a name in a monitored source becomes an investable company — and how much
        falls away at each stage.
      </p>

      {/* ---------- funnel ---------- */}
      <section className="panel">
        <h2 className="panel-title">The funnel</h2>
        <div className="funnel">
          {data.funnel.map((stage, i) => {
            const pct = (stage.count / top) * 100;
            const prev = i > 0 ? data.funnel[i - 1].count : null;
            const dropped = prev != null ? prev - stage.count : null;
            const survived = prev ? (stage.count / prev) * 100 : null;
            return (
              <div key={stage.stage} className="funnel-row">
                <div className="funnel-meta">
                  <span className="funnel-stage">{stage.stage}</span>
                  <span className="funnel-note">{stage.note}</span>
                </div>
                <div className="funnel-bar-wrap">
                  {/* Absolute scale — the collapse from thousands to a handful
                      is the point, so the bars are not normalised per stage.
                      The survival rate carries the detail the bar cannot. */}
                  <div
                    className="funnel-bar"
                    style={{ width: `${Math.max(pct, 0.6)}%` }}
                    data-final={i === data.funnel.length - 1 ? "true" : undefined}
                  />
                  <span className="funnel-count">{stage.count.toLocaleString()}</span>
                  {survived != null ? (
                    <span className="funnel-rate">
                      {survived < 1 ? survived.toFixed(1) : Math.round(survived)}% of previous
                    </span>
                  ) : null}
                </div>
                {dropped != null && dropped > 0 ? (
                  <div className="funnel-drop">−{dropped.toLocaleString()} filtered out</div>
                ) : (
                  <div className="funnel-drop" />
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid-2">
        {/* ---------- what the extractor actually found ---------- */}
        <section className="panel">
          <h2 className="panel-title">What gets extracted</h2>
          <p className="panel-sub">
            Every proper noun in a monitored source becomes an entity. Only companies
            enter the funnel; the rest stay as context.
          </p>
          <div className="split-bar">
            {entityTypes.map(([type, n]) => (
              <span
                key={type}
                className={`split-seg seg-${type}`}
                style={{ width: `${(n / entityTotal) * 100}%` }}
                title={`${ENTITY_TYPE_LABELS[type] ?? type}: ${n}`}
              />
            ))}
          </div>
          <ul className="legend">
            {entityTypes.map(([type, n]) => (
              <li key={type}>
                <span className={`dot seg-${type}`} />
                {ENTITY_TYPE_LABELS[type] ?? type}
                <b>{n.toLocaleString()}</b>
              </li>
            ))}
          </ul>
        </section>

        {/* ---------- where the good ones come from ---------- */}
        <section className="panel">
          <h2 className="panel-title">Where companies come from</h2>
          <p className="panel-sub">
            Source type behind every company that passed the gate. Registers, sandbox
            cohorts and member directories outperform news.
          </p>
          {sourceCats.map(([cat, n]) => (
            <div key={cat} className="bar-row">
              <span className="bar-label">{SOURCE_CATEGORY_LABELS[cat] ?? cat}</span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${(n / sourceTotal) * 100}%` }} />
              </div>
              <span className="bar-value">{n}</span>
            </div>
          ))}
        </section>
      </div>

      <div className="grid-2">
        {/* ---------- named sources ---------- */}
        <section className="panel">
          <h2 className="panel-title">Highest-yield sources</h2>
          <p className="panel-sub">Named lists, ranked by how many companies worth meeting they produced — not by raw volume.</p>
          <table className="table compact">
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th className="num">Worth meeting</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.top_sources.slice(0, 14).map((s) => (
                <tr key={`${s.name}-${s.category}`}>
                  <td>{s.name}</td>
                  <td>
                    <span className="pill subtle">
                      {SOURCE_CATEGORY_LABELS[s.category] ?? s.category}
                    </span>
                  </td>
                  <td className="num"><strong>{s.qualified ?? 0}</strong></td>
                  <td className="num muted">{s.companies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* ---------- scores ---------- */}
        <section className="panel">
          <h2 className="panel-title">Score distribution</h2>
          <p className="panel-sub">
            Signal fit across every scanned company. Fit counts only signals that were
            actually resolved — unknowns are excluded, never half-credited.
          </p>
          <div className="hist">
            {data.score_histogram.map((h) => (
              <div key={h.bucket} className="hist-col" title={`${h.bucket}: ${h.count}`}>
                <div
                  className="hist-bar"
                  style={{ height: `${(h.count / histMax) * 100}%` }}
                />
                <span className="hist-x">{h.bucket.split("-")[0]}</span>
              </div>
            ))}
          </div>
          <div className="band-chips">
            {Object.entries(data.bands)
              .sort((a, b) => b[1] - a[1])
              .map(([band, n]) => (
                <span key={band} className={`pill ${band}`}>
                  {BAND_LABELS[band] ?? band} <b>{n}</b>
                </span>
              ))}
          </div>
        </section>
      </div>
    </>
  );
}
