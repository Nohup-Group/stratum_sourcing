import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { CompanyDetail, SignalResultRow } from "../types";
import Radar, { RadarAxis } from "../components/Radar";
import {
  BandPill,
  CategoryBars,
  ResultMark,
  ScorePct,
  timeAgo,
} from "../components/widgets";

type ResultFilter = "all" | "confirmed" | "absent" | "unknown";

export default function CompanyPage() {
  const { id } = useParams();
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [resultFilter, setResultFilter] = useState<ResultFilter>("confirmed");

  const load = useCallback(() => {
    api.get<CompanyDetail>(`/api/console/companies/${id}`).then(setCompany);
  }, [id]);
  useEffect(load, [load]);

  const groupedResults = useMemo(() => {
    if (!company) return [];
    const filtered = company.scan_results.filter(
      (row) => resultFilter === "all" || row.result === resultFilter
    );
    const groups = new Map<string, SignalResultRow[]>();
    for (const row of filtered) {
      const list = groups.get(row.category) ?? [];
      list.push(row);
      groups.set(row.category, list);
    }
    return [...groups.entries()];
  }, [company, resultFilter]);

  if (!company) return <div className="loading">Loading company…</div>;

  const scan = company.latest_scan;
  const p = company.profile;

  // Fixed axis order so two companies can be compared by shape, and so a
  // category with nothing resolved reads as a gap rather than a zero.
  const RADAR_ORDER = [
    "Founder & Team",
    "Regulatory & Compliance",
    "Commercial Traction",
    "Technology & Product",
    "Investor & Funding",
    "Market Presence",
    "Structural & Strategic",
  ];
  const radarAxes: RadarAxis[] = RADAR_ORDER.map((label) => {
    const raw = scan?.category_scores?.[label] as
      | { pct?: number; fit?: number | null; resolved?: number; confirmed?: number; absent?: number }
      | undefined;
    const value = raw == null ? null : raw.fit ?? raw.pct ?? null;
    const detail =
      raw?.confirmed != null && raw?.absent != null
        ? `${raw.confirmed} confirmed / ${raw.confirmed + raw.absent} resolved`
        : undefined;
    return { label, value: value ?? null, detail };
  });


  return (
    <>
      <div className="page-head">
        <h1>{company.display_name}</h1>
        <BandPill band={scan?.band} />
        {scan && scan.veto_flags.length > 0 ? (
          <span className="pill veto">
            {scan.veto_flags.length} review flag{scan.veto_flags.length > 1 ? "s" : ""}
          </span>
        ) : null}
      </div>
      <p className="page-sub">
        {p?.website || company.canonical_url ? (
          <a
            className="evidence-link"
            href={p?.website || company.canonical_url || "#"}
            target="_blank"
            rel="noreferrer"
          >
            {(p?.website || company.canonical_url || "").replace(/^https?:\/\//, "")}
          </a>
        ) : null}
        {company.description ? <> — {company.description}</> : null}
      </p>

      {p ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-title">Company</div>
          <div className="factgrid">
            {[
              ["Headquarters", [p.hq_city, p.hq_country].filter(Boolean).join(", ")],
              ["Founded", p.founded_year],
              ["Stage", p.stage],
              ["Total raised", p.total_raised],
              ["Cheque fit", p.cheque_fit],
              ["Sells to", p.sells_to],
              ["Registry no.", p.registry_id],
            ]
              .filter(([, v]) => v)
              .map(([label, value]) => (
                <div key={String(label)}>
                  <div className="fact-label">{label}</div>
                  <div className="fact-value">{String(value)}</div>
                </div>
              ))}
          </div>

          {p.licences.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="fact-label">Licences &amp; authorisations</div>
              <div className="flex" style={{ gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {p.licences.map((l) => (
                  <span key={l} className="pill high">{l}</span>
                ))}
              </div>
            </div>
          ) : null}

          {p.founders.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="fact-label">Founders</div>
              <ul className="plainlist">
                {p.founders.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <strong>{f.name}</strong>
                    {f.prior ? <span className="muted"> — {f.prior}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {p.investors.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="fact-label">Investors</div>
              <div className="small">{p.investors.join(" · ")}</div>
            </div>
          ) : null}

          {p.found_via?.source_name ? (
            <div style={{ marginTop: 12 }}>
              <div className="fact-label">How we found them</div>
              <div className="small">
                {p.found_via.source_url ? (
                  <a className="evidence-link" href={p.found_via.source_url} target="_blank" rel="noreferrer">
                    {p.found_via.source_name}
                  </a>
                ) : (
                  p.found_via.source_name
                )}
              </div>
            </div>
          ) : null}

          {p.research_gaps.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="fact-label">Check before the call</div>
              <ul className="plainlist small muted">
                {p.research_gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid cols-2">
        <div className="card">
          <div className="section-title">Signal scan</div>
          {scan ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div className="flex spread">
                <ScorePct value={scan.score_pct} />
                <div className="small muted" style={{ textAlign: "right" }}>
                  {Math.round((scan.coverage ?? 0) * 100)}% of signals resolved
                  <br />
                  {scan.signals_confirmed + scan.signals_absent} of{" "}
                  {scan.signals_confirmed +
                    scan.signals_absent +
                    scan.signals_unknown +
                    (scan.signals_not_applicable ?? 0)}{" "}
                  checked
                </div>
              </div>
              <div className="small muted">
                <strong style={{ color: "var(--ok)" }}>{scan.signals_confirmed} hit</strong> ·{" "}
                {scan.signals_absent} not hit · {scan.signals_unknown} unresolved
                {scan.signals_not_applicable
                  ? ` · ${scan.signals_not_applicable} not applicable`
                  : ""}
              </div>
              {scan.rationale ? <p className="small" style={{ margin: 0 }}>{scan.rationale}</p> : null}
              {scan.veto_flags.length > 0 ? (
                <div>
                  {scan.veto_flags.map((flag) => (
                    <div key={flag.number} className="small" style={{ color: "var(--crit)" }}>
                      ⚑ {flag.name}
                      {flag.note ? <span className="muted"> — {flag.note}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="empty">Not signal-scanned yet.</div>
          )}
        </div>

        <div className="card">
          <div className="section-title">Category breakdown</div>
          {scan ? (
            <>
              <Radar axes={radarAxes} />
              <CategoryBars scores={scan.category_scores} />
            </>
          ) : company.heuristic ? (
            <>
              <div className="small muted" style={{ marginBottom: 8 }}>
                Monitoring heuristic (pre-scan): {company.heuristic.score.toFixed(2)}
              </div>
              <CategoryBars
                scores={Object.fromEntries(
                  Object.entries(company.heuristic.components).map(([key, value]) => [
                    key.replaceAll("_", " "),
                    { earned: Math.round(value * 100) / 100, possible: 1, pct: value },
                  ])
                )}
              />
            </>
          ) : (
            <div className="empty">No scores yet.</div>
          )}
        </div>
      </div>

      {company.scan_results.length > 0 ? (
        <>
          <div className="section-title">Signal evidence</div>
          <div className="filter-row">
            <div className="seg" role="group" aria-label="Filter results">
              {(["confirmed", "absent", "unknown", "all"] as const).map((option) => (
                <button
                  key={option}
                  className={resultFilter === option ? "on" : ""}
                  onClick={() => setResultFilter(option)}
                >
                  {option === "all" ? "All" : option}
                </button>
              ))}
            </div>
          </div>
          {groupedResults.map(([category, rows]) => (
            <div key={category} style={{ marginBottom: 14 }}>
              <div className="small muted" style={{ fontWeight: 700, margin: "0 0 6px" }}>
                {category}
              </div>
              <div className="card tablewrap" style={{ padding: "6px 20px" }}>
                <table className="data">
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.number}>
                        <td style={{ width: 40 }}>
                          <ResultMark result={row.result} />
                        </td>
                        <td>
                          <strong>{row.name}</strong>
                          {row.is_veto ? (
                            <span className="pill veto" style={{ marginLeft: 8 }}>
                              veto
                            </span>
                          ) : null}
                          {row.note ? (
                            <div className="small muted">{row.note}</div>
                          ) : null}
                          {row.evidence_url ? (
                            <a
                              className="evidence-link"
                              href={row.evidence_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {row.evidence_url}
                            </a>
                          ) : null}
                        </td>
                        <td className="num" style={{ width: 80 }}>
                          <span className={`pill ${row.strength}`}>{row.strength}</span>
                        </td>
                        <td className="num small" style={{ width: 60 }}>
                          {row.points_earned}/{row.points_possible}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {company.scan_history.filter((s) => s.status === "completed").length > 1 ? (
        <>
          <div className="section-title">Score history</div>
          <div className="card tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Depth</th>
                  <th className="num">Score</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {company.scan_history
                  .filter((s) => s.status === "completed")
                  .map((s) => (
                    <tr key={s.id}>
                      <td>{timeAgo(s.completed_at)}</td>
                      <td>{s.scan_depth}</td>
                      <td className="num">{Math.round(s.score_pct * 100)}%</td>
                      <td>
                        <BandPill band={s.band} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="small faint">
            A rising score across scans is a stronger buy signal than a single high
            score.
          </p>
        </>
      ) : null}

      {company.recent_findings.length > 0 ? (
        <>
          <div className="section-title">Recent intelligence</div>
          <div className="grid">
            {company.recent_findings.map((finding) => (
              <div key={finding.id} className="card">
                <div className="flex spread">
                  <strong>{finding.title}</strong>
                  <span className="small faint">
                    {finding.source ?? "unknown source"} · {timeAgo(finding.created_at)}
                  </span>
                </div>
                <p className="small muted" style={{ margin: "6px 0" }}>
                  {finding.summary}
                </p>
                {finding.evidence.map((evidence) => (
                  <a
                    key={evidence.url}
                    className="evidence-link"
                    href={evidence.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {evidence.url}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
