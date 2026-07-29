import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { CompanySummary } from "../types";
import { BandPill, timeAgo } from "../components/widgets";

const BAND_FILTERS = ["all", "strong", "moderate", "weak", "insufficient"] as const;

export default function CompaniesPage() {
  const [items, setItems] = useState<CompanySummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [band, setBand] = useState<(typeof BAND_FILTERS)[number]>("all");

  useEffect(() => {
    const params = new URLSearchParams({ limit: "100" });
    if (query) params.set("q", query);
    if (band !== "all") params.set("band", band);
    const timer = setTimeout(() => {
      api
        .get<{ items: CompanySummary[] }>(`/api/console/companies?${params}`)
        .then((data) => setItems(data.items));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, band]);

  return (
    <>
      <div className="page-head">
        <h1>Companies</h1>
      </div>
      <p className="page-sub">
        Every company surfaced by the pipeline, ranked by scan score where one
        exists, monitor score otherwise.
      </p>

      <div className="filter-row">
        <input
          className="input"
          placeholder="Search companies…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="seg" role="group" aria-label="Filter by band">
          {BAND_FILTERS.map((option) => (
            <button
              key={option}
              className={band === option ? "on" : ""}
              onClick={() => setBand(option)}
            >
              {option === "all" ? "All" : option}
            </button>
          ))}
        </div>
      </div>

      {!items ? (
        <div className="loading">Loading companies…</div>
      ) : items.length === 0 ? (
        <div className="empty">No companies match.</div>
      ) : (
        <div className="card tablewrap">
          <table className="data">
            <thead>
              <tr>
                <th>Company</th>
                <th>Verdict</th>
                <th className="num">Scan score</th>
                <th className="num">Monitor score</th>
                <th className="num">Findings</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {items.map((company) => (
                <tr key={company.id} className="rowlink">
                  <td>
                    <Link to={`/companies/${company.id}`}>
                      <strong>{company.display_name}</strong>
                      {company.thesis_tags.length > 0 ? (
                        <span className="faint small">
                          {" "}
                          · {company.thesis_tags.join(", ")}
                        </span>
                      ) : null}
                    </Link>
                  </td>
                  <td>
                    <BandPill band={company.latest_scan?.band} />
                  </td>
                  <td className="num">
                    {company.latest_scan
                      ? `${Math.round(company.latest_scan.score_pct * 100)}%`
                      : "—"}
                  </td>
                  <td className="num">
                    {company.triage_score != null
                      ? company.triage_score.toFixed(2)
                      : "—"}
                  </td>
                  <td className="num">{company.finding_count}</td>
                  <td>{timeAgo(company.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
