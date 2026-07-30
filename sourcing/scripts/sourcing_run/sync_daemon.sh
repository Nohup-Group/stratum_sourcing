#!/bin/zsh
# Keep production in step with the scoring run, so the console always shows
# current data for the demo rather than a snapshot from whenever I last ran the
# import by hand. Import is idempotent (one scan row per entity per provenance)
# so re-running is safe.
SP="/private/tmp/claude-501/-Users-szimmer-code-nohup-stratum-sourcing/aaafea7c-b852-4c4c-a292-342e50b06c14/scratchpad"
PY="/Users/szimmer/code/nohup/stratum_sourcing/sourcing/.venv/bin/python"
cd "$SP" || exit 1
for round in $(seq 1 200); do
  python3 merge_candidates.py > /dev/null 2>&1
  python3 build_shortlist.py > /dev/null 2>&1
  out=$("$PY" import_to_db.py --commit 2>&1 | tail -1)
  meet=$(python3 -c "
import json
try:
    s=json.load(open('shortlist.json')); print(sum(1 for r in s if r['rec']=='meet'))
except Exception: print('?')" 2>/dev/null)
  echo "$(date '+%H:%M') meet=$meet | $out"
  sleep 600
done
