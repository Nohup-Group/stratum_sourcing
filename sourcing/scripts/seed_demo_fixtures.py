"""Seed local demo fixtures: companies, findings, and completed signal scans.

For local development and demo dry-runs only — never run against production.
Requires the signal library to be seeded first (scripts.seed_signals).

Usage:
    DATABASE_URL="postgresql+asyncpg://postgres@localhost:5433/stratum_sourcing" \
        .venv/bin/python -m scripts.seed_demo_fixtures
"""

import asyncio
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.database import async_session_factory
from app.models import (
    Entity,
    EntityMention,
    EntityScore,
    Evidence,
    Finding,
    ScanRun,
    Signal,
    SignalResult,
    SignalScan,
    Source,
    WatchTarget,
)
from app.services.signal_engine import compute_scan_scoring

NOW = datetime.now(timezone.utc)

COMPANIES = [
    {
        "name": "Keystone Custody",
        "url": "https://keystonecustody.example",
        "description": "MPC-based institutional custody and key-management platform for banks entering tokenised markets. BaFin-supervised, ISO 27001 certified.",
        "tags": ["wallets_key_management", "compliance_trust"],
        "profile": "strong",
    },
    {
        "name": "Meridian Rails",
        "url": "https://meridianrails.example",
        "description": "Settlement infrastructure connecting T2S to tokenised securities venues. Founded by ex-Euroclear product leads; DLT Pilot Regime participant.",
        "tags": ["data_oracles_middleware"],
        "profile": "strong",
    },
    {
        "name": "Attestia",
        "url": "https://attestia.example",
        "description": "eIDAS 2.0 qualified attestation issuer building reusable KYB credentials for financial institutions.",
        "tags": ["identity_permissioning", "compliance_trust"],
        "profile": "moderate",
    },
    {
        "name": "Novara Compliance",
        "url": "https://novaracompliance.example",
        "description": "Transaction monitoring and Travel Rule compliance layer for CASPs; TRISA member with named MLRO.",
        "tags": ["compliance_trust"],
        "profile": "moderate",
    },
    {
        "name": "Glacier Oracle",
        "url": "https://glacieroracle.example",
        "description": "Regulated price oracles and NAV feeds for tokenised money-market funds.",
        "tags": ["data_oracles_middleware"],
        "profile": "moderate_veto",
    },
    {
        "name": "Brightvault",
        "url": "https://brightvault.example",
        "description": "Consumer-facing crypto wallet exploring an institutional pivot.",
        "tags": ["wallets_key_management"],
        "profile": "weak",
    },
    {
        "name": "TokenGrid Labs",
        "url": "https://tokengridlabs.example",
        "description": "Early-stage cross-chain interoperability research project out of ETH Zurich.",
        "tags": ["data_oracles_middleware"],
        "profile": "weak",
    },
    {
        "name": "Ledgerform",
        "url": "https://ledgerform.example",
        "description": "No-code tokenisation widgets for SME fundraising.",
        "tags": [],
        "profile": "insufficient",
    },
]

# Per-profile behaviour: (confirm probability for high signals, for medium, veto-absent numbers)
PROFILES = {
    "strong": (0.62, 0.5, set()),
    "moderate": (0.42, 0.35, set()),
    "moderate_veto": (0.4, 0.35, {90, 109}),
    "weak": (0.22, 0.2, set()),
    "insufficient": (0.08, 0.1, {93}),
}

FINDING_TEMPLATES = [
    ("{name} announces pilot with a Tier-1 European bank", "partnership"),
    ("{name} raises seed round led by a fintech-focused fund", "funding_round"),
    ("{name} joins EU regulatory sandbox cohort", "regulatory"),
    ("{name} ships institutional API v2", "product_launch"),
    ("{name} hiring enterprise sales lead in Frankfurt", "hiring"),
]


async def main() -> None:
    rng = random.Random(7)
    async with async_session_factory() as db:
        signals = (
            (await db.execute(select(Signal).where(Signal.scan_tier == 1).order_by(Signal.number)))
            .scalars()
            .all()
        )
        if not signals:
            raise SystemExit("Seed the signal library first: python -m scripts.seed_signals")

        source = (
            await db.execute(select(Source).where(Source.name == "Demo Fixture Wire"))
        ).scalar_one_or_none()
        if source is None:
            source = Source(
                name="Demo Fixture Wire",
                category="newsletter",
                fetch_strategy="rss",
                url="https://fixtures.example/feed",
                description="Synthetic demo source",
            )
            db.add(source)
            await db.flush()

        run = ScanRun(
            started_at=NOW - timedelta(hours=6),
            finished_at=NOW - timedelta(hours=5, minutes=40),
            status="completed",
            sources_total=138,
            sources_ok=131,
            sources_failed=7,
            findings_count=42,
        )
        db.add(run)
        await db.flush()

        for index, spec in enumerate(COMPANIES):
            normalized = spec["name"].lower().replace(" ", " ")
            existing = (
                await db.execute(
                    select(Entity).where(
                        Entity.entity_type == "company",
                        Entity.normalized_name == normalized,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                continue

            entity = Entity(
                entity_type="company",
                display_name=spec["name"],
                normalized_name=normalized,
                canonical_url=spec["url"],
                description=spec["description"],
                thesis_tags=spec["tags"],
                first_seen_at=NOW - timedelta(days=45 - index * 3),
                last_seen_at=NOW - timedelta(days=index),
                finding_count=3,
                source_count=2,
            )
            db.add(entity)
            await db.flush()

            for template, category in rng.sample(FINDING_TEMPLATES, 3):
                finding = Finding(
                    run_id=run.id,
                    source_id=source.id,
                    title=template.format(name=spec["name"]),
                    summary=f"{spec['name']}: {spec['description'][:140]}",
                    category=category,
                    relevance_score=round(rng.uniform(0.55, 0.9), 2),
                    vertical_tags=spec["tags"],
                    dedup_hash=f"demo-{entity.id}-{template[:18]}",
                )
                db.add(finding)
                await db.flush()
                db.add(
                    Evidence(
                        finding_id=finding.id,
                        url=f"{spec['url']}/news/{finding.id}",
                        excerpt=finding.title,
                        captured_at=NOW - timedelta(days=rng.randint(1, 20)),
                    )
                )
                db.add(
                    EntityMention(
                        entity_id=entity.id,
                        finding_id=finding.id,
                        source_id=source.id,
                        mention_text=spec["name"],
                        confidence=0.9,
                    )
                )

            heuristic = round(rng.uniform(0.55, 0.8), 3)
            db.add(
                EntityScore(
                    entity_id=entity.id,
                    score=heuristic,
                    components={
                        "thesis_fit": round(rng.uniform(0.4, 1.0), 2),
                        "stage_fit": round(rng.uniform(0.3, 0.9), 2),
                        "europe_relevance": round(rng.uniform(0.4, 1.0), 2),
                        "recency_momentum": round(rng.uniform(0.5, 1.0), 2),
                        "source_authority": round(rng.uniform(0.4, 0.8), 2),
                        "evidence_depth": round(rng.uniform(0.3, 0.8), 2),
                    },
                    rationale="Demo heuristic score",
                )
            )

            confirm_high, confirm_medium, veto_absent = PROFILES[spec["profile"]]
            results_by_number: dict[int, dict] = {}
            for signal in signals:
                roll = rng.random()
                threshold = confirm_high if signal.strength == "high" else confirm_medium
                if signal.number in veto_absent:
                    verdict = "absent"
                elif signal.is_veto:
                    verdict = "confirmed" if rng.random() < 0.7 else "unknown"
                elif roll < threshold:
                    verdict = "confirmed"
                elif roll < threshold + 0.32:
                    verdict = "absent"
                else:
                    verdict = "unknown"
                results_by_number[signal.number] = {
                    "result": verdict,
                    "evidence_url": (
                        f"{spec['url']}/evidence/{signal.number}"
                        if verdict == "confirmed"
                        else ""
                    ),
                    "note": {
                        "confirmed": f"Public evidence meets threshold for {signal.name}.",
                        "absent": "Searched registers and press; not present.",
                        "unknown": "Inconclusive from public sources.",
                    }[verdict],
                }

            scoring = compute_scan_scoring(signals, results_by_number)
            scan = SignalScan(
                entity_id=entity.id,
                status="completed",
                scan_depth="standard",
                trigger="manual",
                points_earned=scoring["points_earned"],
                points_possible=scoring["points_possible"],
                score_pct=scoring["score_pct"],
                band=scoring["band"],
                veto_flags=scoring["veto_flags"],
                category_scores=scoring["category_scores"],
                signals_confirmed=scoring["counts"]["confirmed"],
                signals_absent=scoring["counts"]["absent"],
                signals_unknown=scoring["counts"]["unknown"],
                rationale=(
                    f"{spec['name']} scored {scoring['points_earned']}/{scoring['points_possible']} "
                    f"({round(scoring['score_pct'] * 100)}%, {scoring['band']}) on a standard scan."
                ),
                started_at=NOW - timedelta(days=index, hours=2),
                completed_at=NOW - timedelta(days=index, hours=1),
                created_at=NOW - timedelta(days=index, hours=2),
            )
            db.add(scan)
            await db.flush()
            for item in scoring["per_signal"]:
                db.add(
                    SignalResult(
                        scan_id=scan.id,
                        signal_id=item["signal"].id,
                        result=item["result"],
                        evidence_url=item["evidence_url"],
                        note=item["note"],
                        points_earned=item["points_earned"],
                    )
                )

            db.add(
                WatchTarget(
                    entity_id=entity.id,
                    target_type="company",
                    status="active" if scoring["band"] in ("strong", "moderate") else "watch",
                    score=scoring["score_pct"],
                )
            )
            print(
                f"{spec['name']:>20}: {round(scoring['score_pct'] * 100)}% {scoring['band']}"
                + (f" ({len(scoring['veto_flags'])} veto)" if scoring["veto_flags"] else "")
            )

        await db.commit()
        print("Demo fixtures seeded.")


if __name__ == "__main__":
    asyncio.run(main())
