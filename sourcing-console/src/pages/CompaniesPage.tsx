import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { CompanySummary } from "../types";
import { BandPill, timeAgo } from "../components/widgets";

const BAND_FILTERS = [
  { value: "all", label: "All" },
  { value: "strong", label: "Strong" },
  { value: "moderate", label: "Moderate" },
  { value: "weak", label: "Weak" },
  { value: "poor", label: "Poor" },
  { value: "insufficient-evidence", label: "No evidence" },
] as const;

const PAGE_SIZE = 100;

export default function CompaniesPage() {
  const [items, setItems] = useState<CompanySummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [band, setBand] = useState<string>("all");
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildParams = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (query) params.set("q", query);
      if (band !== "all") params.set("band", band);
      if (eligibleOnly) params.set("eligible_only", "true");
      return params;
    },
    [query, band, eligibleOnly]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .get<{ total: number; items: CompanySummary[] }>(
          `/api/console/companies?${buildParams(0)}`
        )
        .then((data) => {
          setItems(data.items);
          setTotal(data.total);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [buildParams]);

  async function loadMore() {
    if (!items) return;
    setLoadingMore(true);
    try {
      const data = await api.get<{ total: number; items: CompanySummary[] }>(
        `/api/console/companies?${buildParams(items.length)}`
      );
      setItems([...items, ...data.items]);
      setTotal(data.total);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Companies</h1>
      </div>
      <p className="page-sub">
        Every company surfaced by the pipeline — eligible companies first, ranked
        by scan score where one exists, triage score otherwise.
      </p>

      <div className="filter-row">
        <input
          className="input"
          placeholder="Search companies…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="seg" role="group" aria-label="Filter by verdict">
          {BAND_FILTERS.map((option) => (
            <button
              key={option.value}
              className={band === option.value ? "on" : ""}
              onClick={() => setBand(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          className={`btn${eligibleOnly ? " primary" : ""}`}
          onClick={() => setEligibleOnly(!eligibleOnly)}
          aria-pressed={eligibleOnly}
        >
          Eligible only
        </button>
        {items ? (
          <span className="small muted">
            {items.length < total
              ? `Showing ${items.length} of ${total.toLocaleString()}`
              : `${total.toLocaleString()} companies`}
          </span>
        ) : null}
      </div>

      {!items ? (
        <div className="loading">Loading companies…</div>
      ) : items.length === 0 ? (
        <div className="empty">No companies match.</div>
      ) : (
        <>
          <div className="card tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Verdict</th>
                  <th className="num">Scan score</th>
                  <th className="num">Triage score</th>
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
                        {company.is_eligible === false ? (
                          <span className="pill insufficient" style={{ marginLeft: 8 }}>
                            not eligible
                          </span>
                        ) : null}
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
          {items.length < total ? (
            <div style={{ marginTop: 12, textAlign: "center" }}>
              <button className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore
                  ? "Loading…"
                  : `Load more (${(total - items.length).toLocaleString()} remaining)`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
