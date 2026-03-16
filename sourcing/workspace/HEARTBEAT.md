# Heartbeat: Periodic Self-Checks

## On Each Conversation Start

1. Verify sidecar is reachable: `GET /healthz`
2. Check recent scan status: `GET /api/findings?limit=1` (confirms DB connectivity)
3. If either fails, inform the user that the monitoring system may be down

## Daily Health Indicators

- **Last scan run**: Should be within 24 hours. If older, the nightly cron may have failed.
- **Finding count**: Zero findings from the last run is unusual -- may indicate fetcher issues.
- **Source coverage**: Check if any sources consistently fail (check scan_runs.error_log).

## Proactive Alerts

If asked "how is the system doing?" or "any issues?", check:
1. Recent scan run status and error count
2. Whether findings are being generated
3. Whether Notion sync and Slack digest are firing
