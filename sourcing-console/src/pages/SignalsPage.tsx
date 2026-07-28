import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { SignalRow } from "../types";

const CATEGORY_ORDER = [
  "Founder & Team",
  "Technology & Product",
  "Regulatory & Compliance",
  "Commercial Traction",
  "Investor & Funding",
  "Market Presence",
  "Structural & Strategic",
];

export default function SignalsPage() {
  const [signals, setSignals] = useState<SignalRow[] | null>(null);
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    api.get<{ items: SignalRow[] }>("/api/console/signals").then((data) =>
      setSignals(data.items)
    );
  }, []);

  const filtered = useMemo(() => {
    if (!signals) return [];
    return signals.filter((signal) => {
      if (category !== "all" && signal.category !== category) return false;
      if (
        query &&
        !`${signal.name} ${signal.indicator ?? ""} ${signal.subcategory ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        return false;
      return true;
    });
  }, [signals, category, query]);

  if (!signals) return <div className="loading">Loading signal library…</div>;

  const highCount = signals.filter((s) => s.strength === "high").length;
  const tier1Count = signals.filter((s) => s.scan_tier === 1).length;

  return (
    <>
      <div className="page-head">
        <h1>Signal library</h1>
      </div>
      <p className="page-sub">
        {signals.length} observable signals across {CATEGORY_ORDER.length} categories —{" "}
        {highCount} high-strength (2 pts), {signals.length - highCount} medium (1 pt).{" "}
        {tier1Count} run in every standard scan; the full set runs on shortlisted
        companies. Every signal is public and searchable — no self-reported data.
      </p>

      <div className="filter-row">
        <input
          className="input"
          placeholder="Search signals…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="input"
          style={{ width: 240 }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="all">All categories</option>
          {CATEGORY_ORDER.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <span className="small muted">{filtered.length} shown</span>
      </div>

      <div className="card tablewrap" style={{ padding: "6px 20px" }}>
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>Signal</th>
              <th>Sub-category</th>
              <th>Strength</th>
              <th>Tier</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((signal) => (
              <>
                <tr
                  key={signal.number}
                  className="rowlink"
                  onClick={() =>
                    setExpanded(expanded === signal.number ? null : signal.number)
                  }
                >
                  <td className="mono muted">{signal.number}</td>
                  <td>
                    <strong>{signal.name}</strong>
                    {signal.is_veto ? (
                      <span className="pill veto" style={{ marginLeft: 8 }}>
                        veto
                      </span>
                    ) : null}
                    {signal.times_confirmed > 0 ? (
                      <span className="faint small">
                        {" "}
                        · confirmed {signal.times_confirmed}×
                      </span>
                    ) : null}
                  </td>
                  <td className="muted">{signal.subcategory ?? "—"}</td>
                  <td>
                    <span className={`pill ${signal.strength}`}>{signal.strength}</span>
                  </td>
                  <td>
                    <span className="pill tier">
                      {signal.scan_tier === 1 ? "standard" : "full"}
                    </span>
                  </td>
                </tr>
                {expanded === signal.number ? (
                  <tr key={`${signal.number}-detail`}>
                    <td />
                    <td colSpan={4} className="small muted">
                      {signal.indicator ? (
                        <p style={{ margin: "0 0 6px" }}>
                          <strong>Look for:</strong> {signal.indicator}
                        </p>
                      ) : null}
                      {signal.threshold ? (
                        <p style={{ margin: "0 0 6px" }}>
                          <strong>Confirmed when:</strong> {signal.threshold}
                        </p>
                      ) : null}
                      {signal.anti_signal ? (
                        <p style={{ margin: "0 0 6px", color: "var(--crit)" }}>
                          <strong>Red flag:</strong> {signal.anti_signal}
                        </p>
                      ) : null}
                      {signal.data_source ? (
                        <p style={{ margin: 0 }}>
                          <strong>Sources:</strong> {signal.data_source}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
