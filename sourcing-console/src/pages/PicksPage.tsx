import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { PicksResponse } from "../types";
import { BandPill, timeAgo } from "../components/widgets";

export default function PicksPage() {
  const [data, setData] = useState<PicksResponse | null>(null);
  useEffect(() => {
    api.get<PicksResponse>("/api/console/picks").then(setData);
  }, []);

  if (!data) return <div className="loading">Loading picks…</div>;

  return (
    <>
      <div className="page-head">
        <h1>Top picks</h1>
      </div>
      <p className="page-sub">
        Companies ranked by their latest 200-signal scan. Each score is an evidence
        trail, not an opinion — open a company to see exactly which signals fired.
      </p>

      {data.picks.length === 0 ? (
        <div className="empty">
          No completed signal scans yet. Queue scans from a company page.
        </div>
      ) : (
        <div className="grid">
          {data.picks.map((pick) => (
            <Link key={pick.entity.id} to={`/companies/${pick.entity.id}`}>
              <div className="card" style={{ display: "grid", gap: 10 }}>
                <div className="flex spread">
                  <div className="flex">
                    <span
                      className="mono muted"
                      style={{ fontWeight: 700, fontSize: 15 }}
                    >
                      {String(pick.rank).padStart(2, "0")}
                    </span>
                    <strong style={{ fontSize: 16 }}>{pick.entity.display_name}</strong>
                    <BandPill band={pick.scan.band} />
                    {pick.scan.veto_flags.length > 0 ? (
                      <span className="pill veto">
                        {pick.scan.veto_flags.length} review flag
                        {pick.scan.veto_flags.length > 1 ? "s" : ""}
                      </span>
                    ) : null}
                  </div>
                  <div className="score-big" style={{ fontSize: 26 }}>
                    {Math.round(pick.scan.score_pct * 100)}
                    <small>%</small>
                  </div>
                </div>
                {pick.entity.description ? (
                  <div className="muted small" style={{ maxWidth: "80ch" }}>
                    {pick.entity.description.slice(0, 220)}
                    {pick.entity.description.length > 220 ? "…" : ""}
                  </div>
                ) : null}
                {pick.highlights.length > 0 ? (
                  <div className="flex" style={{ gap: 6 }}>
                    {pick.highlights.map((highlight) => (
                      <span key={highlight.name} className="pill high">
                        {highlight.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="small faint">
                  {pick.scan.signals_confirmed} confirmed · {pick.scan.signals_absent}{" "}
                  absent · {pick.scan.signals_unknown} unknown — scanned{" "}
                  {timeAgo(pick.scan.completed_at)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {data.rising_unscanned.length > 0 ? (
        <>
          <div className="section-title">Rising — not yet signal-scanned</div>
          <div className="card tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Company</th>
                  <th className="num">Monitor score</th>
                  <th className="num">Findings</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.rising_unscanned.map((entity) => (
                  <tr key={entity.id} className="rowlink">
                    <td>
                      <Link to={`/companies/${entity.id}`}>
                        <strong>{entity.display_name}</strong>
                      </Link>
                    </td>
                    <td className="num">{(entity.triage_score ?? 0).toFixed(2)}</td>
                    <td className="num">{entity.finding_count}</td>
                    <td>{timeAgo(entity.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
