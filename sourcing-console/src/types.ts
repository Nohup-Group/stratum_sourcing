export interface ScanSummary {
  id: number;
  status: string;
  scan_depth: string;
  trigger: string;
  score_pct: number;
  band: "strong" | "moderate" | "weak" | "insufficient" | null;
  points_earned: number;
  points_possible: number;
  signals_confirmed: number;
  signals_absent: number;
  signals_unknown: number;
  signals_not_applicable: number;
  /** Share of assessed signals actually resolved. Below 0.4 the band is
   *  "insufficient-evidence" — a thin scan is not a moderate company. */
  coverage: number;
  veto_flags: { number: number; name: string; note: string }[];
  category_scores: Record<
    string,
    { earned: number; possible: number; pct: number; confirmed: number; absent: number; unknown: number }
  >;
  rationale: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CompanySummary {
  id: number;
  display_name: string;
  canonical_url: string | null;
  description: string | null;
  thesis_tags: string[];
  first_seen_at: string;
  last_seen_at: string;
  finding_count: number;
  source_count: number;
  domain: string | null;
  is_eligible: boolean | null;
  lifecycle_status: string;
  gate: Record<string, unknown>;
  /** Salience in our sources, NOT thesis fit. Only a signal scan measures fit. */
  triage_score: number | null;
  latest_scan: ScanSummary | null;
}

export interface SignalResultRow {
  number: number;
  category: string;
  subcategory: string | null;
  name: string;
  strength: "high" | "medium";
  is_veto: boolean;
  result: "confirmed" | "absent" | "unknown";
  evidence_url: string | null;
  note: string | null;
  points_earned: number;
  points_possible: number;
}

export interface CompanyProfile {
  website: string | null;
  registry_id: string | null;
  hq_city: string | null;
  hq_country: string | null;
  founded_year: number | null;
  stage: string | null;
  total_raised: string | null;
  cheque_fit: string | null;
  sells_to: string | null;
  licences: string[];
  founders: { name?: string; prior?: string; url?: string }[];
  investors: string[];
  found_via: { source_name?: string; source_url?: string; source_category?: string };
  anti_signals: string[];
  research_gaps: string[];
  recommendation: string | null;
  coverage: number | null;
}

export interface CompanyDetail extends Omit<CompanySummary, "triage_score" | "latest_scan"> {
  profile?: CompanyProfile;
  metadata: Record<string, unknown>;
  heuristic: { score: number; components: Record<string, number>; last_scored_at: string } | null;
  research_summary: string | null;
  latest_scan: ScanSummary | null;
  scan_results: SignalResultRow[];
  scan_history: ScanSummary[];
  recent_findings: {
    id: number;
    title: string;
    summary: string;
    category: string | null;
    relevance_score: number;
    source: string | null;
    created_at: string;
    evidence: { url: string; excerpt: string }[];
  }[];
}

export interface Overview {
  sources: { total: number; by_category: Record<string, number> };
  findings: { total: number; last_7_days: number };
  companies: { total: number; new_last_7_days: number };
  people: { total: number };
  scans: { companies_scanned: number; bands: Record<string, number> };
  attribution: Record<string, number>;
  recent_runs: {
    id: number;
    started_at: string;
    finished_at: string | null;
    status: string;
    sources_total: number;
    sources_ok: number;
    sources_failed: number;
    findings_count: number;
  }[];
}

export interface Pick {
  rank: number;
  entity: Omit<CompanySummary, "triage_score" | "latest_scan">;
  scan: ScanSummary;
  highlights: { name: string; evidence_url: string | null }[];
}

export interface PicksResponse {
  picks: Pick[];
  rising_unscanned: (Omit<CompanySummary, "latest_scan"> & { triage_score: number })[];
}

export interface SignalRow {
  number: number;
  category: string;
  subcategory: string | null;
  name: string;
  indicator: string | null;
  data_source: string | null;
  strength: "high" | "medium";
  threshold: string | null;
  anti_signal: string | null;
  points: number;
  scan_tier: number;
  is_veto: boolean;
  times_confirmed: number;
}

export interface SourceRow {
  id: number;
  name: string;
  category: string;
  url: string | null;
  fetch_strategy: string;
  cadence_bucket: string;
  last_ingested_at: string | null;
  onboarding_status: string;
  discovery_mode: string;
}

export interface Provenance {
  funnel: { stage: string; count: number; note: string }[];
  entity_types: Record<string, number>;
  eligibility: { eligible: number; rejected: number; not_yet_assessed: number };
  bands: Record<string, number>;
  score_histogram: { bucket: string; count: number }[];
  top_sources: { name: string; category: string; companies: number; qualified?: number }[];
  companies_by_source_category: Record<string, number>;
  sources_registered: Record<string, number>;
}
