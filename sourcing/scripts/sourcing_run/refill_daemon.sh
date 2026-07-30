#!/bin/zsh
# Keep the codex scoring pipeline topped up overnight.
#
# Holds a target number of concurrent `codex exec` sessions, launching a new
# wave whenever sessions finish. Stops once the shortlist is deep enough or the
# candidate pool is exhausted. Backs off if machine load gets high — 33
# concurrent sessions earlier tonight drove load to 55 and exhausted an account
# quota, which is the failure this guard exists to prevent.
SP="/private/tmp/claude-501/-Users-szimmer-code-nohup-stratum-sourcing/aaafea7c-b852-4c4c-a292-342e50b06c14/scratchpad"
cd "$SP" || exit 1

TARGET_SESSIONS=24
TARGET_SHORTLIST=400      # chasing 100 meet-rated; meet rate is ~16%
MAX_LOAD=30

for round in $(seq 1 400); do
  alive=$(ps aux | grep -c "[c]odex exec")
  load=$(uptime | sed 's/.*load averages*: //' | awk '{print int($1)}')
  shortlist=$(python3 -c "
import json
try:
    print(len(json.load(open('shortlist.json'))))
except Exception:
    print(0)" 2>/dev/null || echo 0)

  if [ "$shortlist" -ge "$TARGET_SHORTLIST" ]; then
    echo "$(date '+%H:%M') shortlist=$shortlist reached target — stopping refill"
    break
  fi

  if [ "$load" -lt "$MAX_LOAD" ] && [ "$alive" -lt "$TARGET_SESSIONS" ]; then
    # launch_scoring_codex.py takes (companies_per_slice, sessions_to_launch),
    # so this is the session deficit directly — dividing it by the slice size
    # was throttling refills to a fifth of what was intended.
    want=$(( TARGET_SESSIONS - alive ))
    [ "$want" -lt 1 ] && want=1
    [ "$want" -gt 12 ] && want=12
    out=$(python3 launch_scoring_codex.py 5 "$want" "r${round}" 2>&1 | tail -2)
    echo "$(date '+%H:%M') alive=$alive load=$load shortlist=$shortlist -> $out"
    if echo "$out" | grep -q "0 codex sessions launched"; then
      echo "$(date '+%H:%M') candidate pool exhausted — stopping refill"
      break
    fi
  else
    echo "$(date '+%H:%M') alive=$alive load=$load shortlist=$shortlist — holding"
  fi

  # Rebuild the shortlist each round so progress is always readable on disk.
  python3 build_shortlist.py > /dev/null 2>&1
  sleep 120
done
echo "refill daemon finished at $(date)"
