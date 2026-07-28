import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { SourceRow } from "../types";
import { timeAgo } from "../components/widgets";

const CATEGORY_LABELS: Record<string, string> = {
  company: "Company",
  person: "Person",
  association: "Association",
  newsletter: "Newsletter",
  university: "University",
  conference: "Conference",
  vc: "VC",
  regulator: "Regulator",
};

export default function SourcesPage() {
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [category, setCategory] = useState("all");

  useEffect(() => {
    api.get<{ items: SourceRow[] }>("/api/console/sources").then((data) =>
      setSources(data.items)
    );
  }, []);

  const categories = useMemo(() => {
    if (!sources) return [];
    return [...new Set(sources.map((s) => s.category))].sort();
  }, [sources]);

  if (!sources) return <div className="loading">Loading sources…</div>;

  const filtered =
    category === "all" ? sources : sources.filter((s) => s.category === category);

  return (
    <>
      <div className="page-head">
        <h1>Sources</h1>
      </div>
      <p className="page-sub">
        {sources.length} active sources feed the pipeline — newsletters, regulators,
        VC portfolios, conferences, universities, and the companies themselves. New
        sources are discovered automatically as entities prove sourceable.
      </p>

      <div className="filter-row">
        <select
          className="input"
          style={{ width: 200 }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="all">All categories ({sources.length})</option>
          {categories.map((option) => (
            <option key={option} value={option}>
              {CATEGORY_LABELS[option] ?? option} (
              {sources.filter((s) => s.category === option).length})
            </option>
          ))}
        </select>
      </div>

      <div className="card tablewrap">
        <table className="data">
          <thead>
            <tr>
              <th>Source</th>
              <th>Category</th>
              <th>Strategy</th>
              <th>Cadence</th>
              <th>Discovery</th>
              <th>Last ingested</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((source) => (
              <tr key={source.id}>
                <td>
                  {source.url ? (
                    <a
                      className="evidence-link"
                      style={{ fontSize: "13.5px" }}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {source.name}
                    </a>
                  ) : (
                    <strong>{source.name}</strong>
                  )}
                </td>
                <td>
                  <span className="pill tier">
                    {CATEGORY_LABELS[source.category] ?? source.category}
                  </span>
                </td>
                <td className="muted">{source.fetch_strategy}</td>
                <td className="muted">{source.cadence_bucket}</td>
                <td className="muted">{source.discovery_mode}</td>
                <td>{timeAgo(source.last_ingested_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
