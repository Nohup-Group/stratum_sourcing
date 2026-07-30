import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { PicksResponse } from "../types";
import { BandPill } from "../components/widgets";

const PAGE = 25;

export default function PicksPage() {
  const [data, setData] = useState<PicksResponse | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [onlyMeet, setOnlyMeet] = useState(true);

  useEffect(() => {
    api.get<PicksResponse>("/api/console/picks").then(setData);
  }, []);

  if (!data) return <div className="loading">Loading picks…</div>;

  const ranked = onlyMeet
    ? data.picks.filter((p) => p.scan.band === "strong" || p.scan.band === "moderate")
    : data.picks;
  const visible = ranked.slice(0, shown);

  return (
    <>
      <div className="page-head">
        <h1>Top picks</h1>
      </div>
      <p className="page-sub">
        Every company that passed the thesis gate, ranked by its 200-signal scan.
        The score is an evidence trail, not an opinion — open any company to see
        exactly which signals were hit and which were not.
      </p>

      <div className="filter-row">
        <div className="seg" role="group" aria-label="Filter picks">
          <button className={onlyMeet ? "on" : ""} onClick={() => { setOnlyMeet(true); setShown(PAGE); }}>
            Worth meeting ({data.picks.filter((p) => p.scan.band === "strong" || p.scan.band === "moderate").length})
          </button>
          <button className={onlyMeet ? "" : "on"} onClick={() => { setOnlyMeet(false); setShown(PAGE); }}>
            All scored ({data.picks.length})
          </button>
        </div>
      </div>

      {ranked.length === 0 ? (
        <div className="empty">No completed signal scans yet.</div>
      ) : (
        <div className="grid">
          {visible.map((pick) => (
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
                  <strong style={{ color: "var(--ok)" }}>
                    {pick.scan.signals_confirmed} signals hit
                  </strong>{" "}
                  · {pick.scan.signals_absent} not hit ·{" "}
                  {Math.round((pick.scan.coverage ?? 0) * 100)}% of the framework resolved
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {shown < ranked.length ? (
        <div style={{ textAlign: "center", margin: "18px 0" }}>
          <button className="btn" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, ranked.length - shown)} more — {ranked.length - shown} remaining
          </button>
        </div>
      ) : null}

    </>
  );
}
