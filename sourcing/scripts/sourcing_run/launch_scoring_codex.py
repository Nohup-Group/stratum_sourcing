"""Score candidates using `codex exec` sessions.

The Claude account hit its session limit at 00:53 Europe/Berlin (resets 04:50),
which killed every in-flight `claude -p` scoring session. Codex is a separate
quota with its own web search, so the scoring run continues there.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

SP = "/private/tmp/claude-501/-Users-szimmer-code-nohup-stratum-sourcing/aaafea7c-b852-4c4c-a292-342e50b06c14/scratchpad"

PROMPT = """You are a venture-capital signal analyst for Stratum3 Ventures, a European VC investing at Seed/Series A in institutional digital-finance infrastructure.

Read these two files first and follow them exactly:
- {sp}/SCORING_CONTRACT.md   (the scoring rules)
- {sp}/SIGNAL_LIBRARY.md     (the 200 signals)

SCORE THESE {n} COMPANIES:
{block}

FOR EACH COMPANY:
1. Run the 7-gate eligibility check FIRST (contract section 1). Capital ceiling is EUR 30m: under 20m = cheque_fit "core", 20-30m = "stretch". Any gate FAIL => verdict "INELIGIBLE", no fit score, and say which gate failed.
2. If eligible, resolve at least 25 signals with real web evidence, weighted toward Regulatory & Compliance, Founder & Team, Commercial Traction, Technology & Product.
3. Verify any claimed licence against the actual public register (EBA, FCA register, BaFin, FINMA, national CASP/VASP registers). Company copy is a claim; the register is the truth. A lapsed or missing licence is a veto flag.
4. Confirm the company is still independent and alive (not acquired, not dissolved).

SCORING RULES THAT MATTER MOST:
- Verdicts are Y (confirmed, REQUIRES a real URL), N (positively absent), ? (unknown), NA (cannot apply to this vertical).
- "?" and "NA" are BOTH excluded from the denominator. Never half-credit them, never score an inapplicable signal as N.
- fit = (points from Y) / (points from Y and N only), blended by category weight: Founder & Team 0.30, Regulatory & Compliance 0.20, Commercial Traction 0.20, Technology & Product 0.12, Investor & Funding 0.10, Market Presence 0.04, Structural & Strategic 0.04.
- coverage = resolved / assessed, reported separately. coverage < 0.40 => band "insufficient-evidence".
- Bands: >=0.70 strong, 0.50-0.69 moderate, 0.35-0.49 weak, <0.35 poor.
- NEVER invent a URL, licence number, customer or partnership. An honest "?" is worth far more than a fabricated "Y".
- Evidence about a partner, investor or co-mentioned company is NOT evidence about this company.

OUTPUT: write a JSON array to {out}
One object per company with these keys: company, verdict ("SCORED"|"INELIGIBLE"|"UNRESOLVED"), gate (object of the 7 gates with result+evidence), ineligible_reason, one_liner, hq_city_country, founded_year, total_raised_eur, cheque_fit, founders (array), signals (array of {{n, category, name, strength, verdict, evidence, url}}), category_scores, fit_score, coverage, band, anti_signals, veto_flags, recommendation ("meet"|"monitor"|"pass"|"ineligible"), why, research_gaps.

Write the file INCREMENTALLY — rewrite the whole array after finishing each company — so partial work survives if you are cut off. Then reply with one line per company: name | verdict | fit | coverage | band | recommendation.
"""


def norm(v: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (v or "").lower()).strip()


def block_for(rows: list[dict]) -> str:
    out = []
    for i, c in enumerate(rows, 1):
        out.append(
            f"{i}. {c['name']} — {c.get('domain','?')} | {c.get('hq_city','?')}, "
            f"{c.get('hq_country','?')} | founded {c.get('founded_year','?')} | "
            f"stage {c.get('stage','?')} | raised {c.get('total_raised','?')} | "
            f"vertical {c.get('vertical','?')} | licences: "
            f"{'; '.join(c.get('licences') or []) or 'none claimed'} | "
            f"{(c.get('what_it_does') or '')[:160]}"
        )
    return "\n".join(out)


CLAIMS = f"{SP}/inflight_claims.json"


def already_scored() -> set[str]:
    import glob

    done = set()
    for path in glob.glob(f"{SP}/scored_*.json"):
        try:
            rows = json.load(open(path, encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        for row in rows if isinstance(rows, list) else [rows]:
            if isinstance(row, dict) and row.get("company"):
                done.add(norm(row["company"]))
    return done


def load_claims() -> dict[str, str]:
    """Companies already handed to a session that has not written its file yet.

    Without this, a second wave launched while the first is still working sees
    those companies as unscored and assigns them again — which is exactly what
    happened on the first attempt.
    """
    try:
        return json.load(open(CLAIMS, encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def save_claims(claims: dict[str, str]) -> None:
    json.dump(claims, open(CLAIMS, "w", encoding="utf-8"), indent=1)


def live_session_tags() -> set[str]:
    """Tags of sessions still running, so dead sessions release their claims."""
    try:
        out = subprocess.run(
            ["ps", "ax", "-o", "command"], capture_output=True, text=True, check=False
        ).stdout
    except Exception:  # noqa: BLE001
        return set()
    return {m for m in re.findall(r"scored_([a-z]+\d+)\.json", out)}


def main() -> None:
    per_slice = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    max_sessions = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    tag = sys.argv[3] if len(sys.argv) > 3 else "cx"

    pool = json.load(open(f"{SP}/candidate_pool.json", encoding="utf-8"))
    done = already_scored()

    live = live_session_tags()
    claims = {k: v for k, v in load_claims().items() if v in live}
    done |= set(claims)

    # Highest-signal first: high confidence, then those with a claimed licence.
    def rank(c: dict) -> tuple:
        conf = {"high": 0, "medium": 1, "low": 2}.get(c.get("confidence", "low"), 2)
        return (conf, 0 if c.get("licences") else 1, c.get("name", "").lower())

    todo = [c for c in pool if norm(c["name"]) not in done]
    todo.sort(key=rank)

    slices = [todo[i : i + per_slice] for i in range(0, len(todo), per_slice)][:max_sessions]
    os.makedirs(f"{SP}/cli_logs", exist_ok=True)

    for idx, rows in enumerate(slices, 1):
        out = f"{SP}/scored_{tag}{idx}.json"
        if os.path.exists(out):
            print(f"skip {tag}{idx}")
            continue
        prompt = PROMPT.format(sp=SP, n=len(rows), block=block_for(rows), out=out)
        log = open(f"{SP}/cli_logs/score_{tag}{idx}.log", "w")
        subprocess.Popen(
            [
                "codex", "exec",
                "--skip-git-repo-check",
                "-s", "workspace-write",
                "-C", SP,
                "--enable", "web_search",
                prompt,
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        for c in rows:
            claims[norm(c["name"])] = f"{tag}{idx}"
        print(f"launched {tag}{idx}: {', '.join(c['name'] for c in rows)}")

    save_claims(claims)
    remaining = len(todo) - sum(len(s) for s in slices)
    print(f"\n{len(slices)} codex sessions launched; {remaining} companies unclaimed")


if __name__ == "__main__":
    main()
