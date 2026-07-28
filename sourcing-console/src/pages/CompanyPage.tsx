import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { CompanyDetail, SignalResultRow } from "../types";
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
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);

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

  async function queueScan(depth: "standard" | "full") {
    setQueueing(true);
    setScanMessage(null);
    try {
      const response = await api.post<{ status: string; reason?: string }>(
        `/api/console/companies/${id}/scan`,
        { scan_depth: depth, force: Boolean(scan) }
      );
      setScanMessage(
        response.status === "queued"
          ? `Scan queued (${depth}) — results appear here when the worker completes it.`
          : `Skipped: ${response.reason}`
      );
    } catch {
      setScanMessage("Could not queue the scan.");
    } finally {
      setQueueing(false);
    }
  }

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
        {company.canonical_url ? (
          <a
            className="evidence-link"
            href={company.canonical_url}
            target="_blank"
            rel="noreferrer"
          >
            {company.canonical_url}
          </a>
        ) : null}
        {company.description ? <> — {company.description}</> : null}
      </p>

      <div className="grid cols-2">
        <div className="card">
          <div className="section-title">Signal scan</div>
          {scan ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div className="flex spread">
                <ScorePct value={scan.score_pct} />
                <div className="small muted" style={{ textAlign: "right" }}>
                  {scan.points_earned} / {scan.points_possible} points
                  <br />
                  {scan.scan_depth} scan · {timeAgo(scan.completed_at)}
                </div>
              </div>
              <div className="small muted">
                {scan.signals_confirmed} confirmed · {scan.signals_absent} absent ·{" "}
                {scan.signals_unknown} unknown
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
            <div className="empty">
              Not signal-scanned yet. Queue a scan to score this company against the
              framework.
            </div>
          )}
          <div className="flex" style={{ marginTop: 14 }}>
            <button
              className="btn primary"
              disabled={queueing}
              onClick={() => queueScan("standard")}
            >
              {scan ? "Re-scan (standard)" : "Run standard scan"}
            </button>
            <button className="btn" disabled={queueing} onClick={() => queueScan("full")}>
              Full 200-signal scan
            </button>
          </div>
          {scanMessage ? (
            <p className="small muted" style={{ marginBottom: 0 }}>
              {scanMessage}
            </p>
          ) : null}
        </div>

        <div className="card">
          <div className="section-title">Category breakdown</div>
          {scan ? (
            <CategoryBars scores={scan.category_scores} />
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
