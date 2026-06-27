#!/usr/bin/env bash
# amutix benchmark harness — solo vs amutix workflow comparison
# See README.md in this directory for documentation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Configuration (override via environment)
BENCH_ROOT="${BENCH_ROOT:-/tmp/amutix-bench}"
SRC_REPO="${SRC_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BASE_COMMIT="${BASE_COMMIT:-$(cd "$SRC_REPO" && git rev-parse HEAD)}"
PI_BIN="${PI_BIN:-pi}"
PI_PROVIDER="${PI_PROVIDER:-}"
PI_MODEL="${PI_MODEL:-}"
PI_THINKING="${PI_THINKING:-}"
BENCH_TIMEOUT_SECONDS="${BENCH_TIMEOUT_SECONDS:-0}"

TASKS_DIR="$SCRIPT_DIR/tasks"
PROMPTS_DIR="$SCRIPT_DIR/prompt-templates"

usage() {
  cat <<EOF
amutix benchmark harness — solo vs amutix comparison

Usage: bench.sh <command> [args]

Commands:
  prepare             Create isolated benchmark workspace metadata
  run-solo <n>        Create solo workspace, prompt, and runnable script for task n
  run-amutix <n>        Create amutix workspace plus architect/developer/reviewer scripts for task n
  collect <arm> <n>   Collect results after a run (arm: solo|amutix)
  report              Generate markdown report from collected results
  stop                Stop benchmark processes running under BENCH_ROOT

Environment:
  BENCH_ROOT          Workspace root (default: /tmp/amutix-bench)
  SRC_REPO            Source repo path (default: repo root)
  BASE_COMMIT         Starting commit (default: HEAD)
  PI_BIN              Pi binary (default: pi)
  PI_PROVIDER         Pin provider (e.g., deepseek)
  PI_MODEL            Pin model (e.g., deepseek/deepseek-v4-pro)
  PI_THINKING         Thinking mode (e.g., high)
  BENCH_TIMEOUT_SECONDS  Optional per-agent timeout; 0 disables timeout
EOF
}

write_metadata() {
  mkdir -p "$BENCH_ROOT" "$BENCH_ROOT/results" "$BENCH_ROOT/pi-sessions"
  echo "$BASE_COMMIT" > "$BENCH_ROOT/base-commit.txt"
  echo "$SRC_REPO" > "$BENCH_ROOT/src-repo.txt"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$BENCH_ROOT/prepared-at.txt"
  echo "${PI_PROVIDER:-not pinned}" > "$BENCH_ROOT/provider.txt"
  echo "${PI_MODEL:-not pinned}" > "$BENCH_ROOT/model.txt"
  echo "${PI_THINKING:-not set}" > "$BENCH_ROOT/thinking.txt"
  echo "$BENCH_TIMEOUT_SECONDS" > "$BENCH_ROOT/timeout-seconds.txt"
}

write_runner() {
  local dir="$1" label="$2" prompt_name="$3" log_name="$4"
  local base session_id session_dir pid_file
  base="$(basename "$dir")"
  session_id="${base}-${label}"
  session_dir="$BENCH_ROOT/pi-sessions"
  pid_file=".benchmark-${label}.pid"

  local q_dir q_bin q_provider q_model q_thinking q_timeout q_prompt q_log q_session_dir q_session_id q_pid_file
  printf -v q_dir '%q' "$dir"
  printf -v q_bin '%q' "$PI_BIN"
  printf -v q_provider '%q' "$PI_PROVIDER"
  printf -v q_model '%q' "$PI_MODEL"
  printf -v q_thinking '%q' "$PI_THINKING"
  printf -v q_timeout '%q' "$BENCH_TIMEOUT_SECONDS"
  printf -v q_prompt '%q' "$prompt_name"
  printf -v q_log '%q' "$log_name"
  printf -v q_session_dir '%q' "$session_dir"
  printf -v q_session_id '%q' "$session_id"
  printf -v q_pid_file '%q' "$pid_file"

  cat > "$dir/run-${label}.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $q_dir
PI_BIN=$q_bin
PI_PROVIDER=$q_provider
PI_MODEL=$q_model
PI_THINKING=$q_thinking
BENCH_TIMEOUT_SECONDS=$q_timeout
SESSION_DIR=$q_session_dir
SESSION_ID=$q_session_id
mkdir -p "\$SESSION_DIR"
args=(--session-dir "\$SESSION_DIR" --session-id "\$SESSION_ID" --no-extensions --no-approve --mode text)
[[ -n "\$PI_PROVIDER" ]] && args+=(--provider "\$PI_PROVIDER")
[[ -n "\$PI_MODEL" ]] && args+=(--model "\$PI_MODEL")
[[ -n "\$PI_THINKING" ]] && args+=(--thinking "\$PI_THINKING")

if [[ "\$BENCH_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] && [[ "\$BENCH_TIMEOUT_SECONDS" -gt 0 ]]; then
  echo "Running \$SESSION_ID with timeout \${BENCH_TIMEOUT_SECONDS}s; log: $q_log"
  "\$PI_BIN" "\${args[@]}" -p "\$(cat $q_prompt)" > $q_log 2>&1 &
  pid=\$!
  echo "\$pid" > $q_pid_file
  deadline=\$((SECONDS + BENCH_TIMEOUT_SECONDS))
  while kill -0 "\$pid" 2>/dev/null; do
    if [[ "\$SECONDS" -ge "\$deadline" ]]; then
      echo "Benchmark agent timed out after \${BENCH_TIMEOUT_SECONDS}s; stopping pid \$pid" | tee -a $q_log
      kill "\$pid" 2>/dev/null || true
      sleep 2
      kill -9 "\$pid" 2>/dev/null || true
      rm -f $q_pid_file
      cat $q_log
      exit 124
    fi
    sleep 5
  done
  status=0
  wait "\$pid" || status=\$?
  rm -f $q_pid_file
  cat $q_log
  exit "\$status"
else
  "\$PI_BIN" "\${args[@]}" -p "\$(cat $q_prompt)" 2>&1 | tee $q_log
fi
EOF
  chmod +x "$dir/run-${label}.sh"
}

clone_workspace() {
  local dir="$1" branch="$2"
  rm -rf "$dir"
  mkdir -p "$(dirname "$dir")"
  git clone --quiet --no-checkout "$SRC_REPO" "$dir"
  (cd "$dir" && git checkout --quiet -b "$branch" "$BASE_COMMIT")
}

cmd_prepare() {
  echo "=== Preparing benchmark workspace ==="
  write_metadata
  echo "Source repo:  $SRC_REPO"
  echo "Base commit:  $BASE_COMMIT"
  echo "Workspace:    $BENCH_ROOT"
  echo "Pi sessions:  $BENCH_ROOT/pi-sessions"
  echo "Provider:     ${PI_PROVIDER:-not pinned}"
  echo "Model:        ${PI_MODEL:-not pinned}"
  echo "Thinking:     ${PI_THINKING:-not set}"
  echo "Timeout:      ${BENCH_TIMEOUT_SECONDS}s"
  echo ""
  echo "Ready. Next: bench.sh run-solo <n>  or  bench.sh run-amutix <n>"
}

cmd_run_solo() {
  local n="$1"
  local task="$TASKS_DIR/task-${n}.md"
  [[ -f "$task" ]] || { echo "Error: $task not found."; exit 1; }
  write_metadata

  local dir="$BENCH_ROOT/solo-task-${n}"
  echo "=== Setting up solo arm for task $n ==="
  clone_workspace "$dir" "bench-solo-task-${n}"

  local prompt="$dir/BENCHMARK_PROMPT.md"
  cat "$PROMPTS_DIR/solo.md" > "$prompt"
  printf '\n## Task\n\n' >> "$prompt"
  cat "$task" >> "$prompt"
  write_runner "$dir" "solo" "BENCHMARK_PROMPT.md" "BENCHMARK_SOLO.log"

  echo ""
  echo "Solo workspace ready:"
  echo "  Dir:    $dir"
  echo "  Prompt: $dir/BENCHMARK_PROMPT.md"
  echo "  Run:    $dir/run-solo.sh"
  echo ""
  echo "After:  $SCRIPT_DIR/bench.sh collect solo $n"
}

cmd_run_amutix() {
  local n="$1"
  local task="$TASKS_DIR/task-${n}.md"
  [[ -f "$task" ]] || { echo "Error: $task not found."; exit 1; }
  write_metadata

  local dir="$BENCH_ROOT/amutix-task-${n}"
  echo "=== Setting up amutix-style arm for task $n ==="
  clone_workspace "$dir" "bench-amutix-task-${n}"

  for role in architect developer reviewer; do
    local upper
    upper="$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')"
    local prompt="$dir/BENCHMARK_${upper}_PROMPT.md"
    cat "$PROMPTS_DIR/${role}.md" > "$prompt"
    printf '\n## Task\n\n' >> "$prompt"
    cat "$task" >> "$prompt"
    write_runner "$dir" "$role" "BENCHMARK_${upper}_PROMPT.md" "BENCHMARK_${upper}.log"
  done

  echo ""
  echo "Amux workspace ready:"
  echo "  Dir:       $dir"
  echo "  Architect: $dir/run-architect.sh"
  echo "  Developer: $dir/run-developer.sh"
  echo "  Reviewer:  $dir/run-reviewer.sh"
  echo ""
  echo "Workflow in the same workspace:"
  echo "  1. Run architect; it should write SPEC.md and no implementation."
  echo "  2. Run developer; it should implement from SPEC.md and write HANDOFF.md."
  echo "  3. Run reviewer; it should review spec + diff + tests and write REVIEW.md."
  echo ""
  echo "After:  $SCRIPT_DIR/bench.sh collect amutix $n"
}

copy_if_present() {
  local src="$1" dst_dir="$2"
  [[ -f "$src" ]] || return 0
  cp "$src" "$dst_dir/$(basename "$src")"
}

cmd_collect() {
  local arm="$1" n="$2"
  local out="$BENCH_ROOT/results/${arm}-task-${n}"
  mkdir -p "$out"

  local d
  if [[ "$arm" == "solo" ]]; then
    d="$BENCH_ROOT/solo-task-${n}"
  elif [[ "$arm" == "amutix" ]]; then
    d="$BENCH_ROOT/amutix-task-${n}"
  else
    echo "Error: arm must be 'solo' or 'amutix'"; exit 1
  fi
  [[ -d "$d/.git" ]] || { echo "Error: workspace not found: $d"; exit 1; }

  echo "Collecting $arm results from $d..."
  (cd "$d" && git status --short > "$out/git-status.txt" 2>/dev/null || true)
  (cd "$d" && git diff --stat "$BASE_COMMIT" > "$out/diff-stat.txt" 2>/dev/null || true)
  (cd "$d" && git diff "$BASE_COMMIT" > "$out/diff.patch" 2>/dev/null || true)
  (cd "$d" && git log --oneline "$BASE_COMMIT"..HEAD > "$out/commits.txt" 2>/dev/null || true)
  (cd "$d" && npm test > "$out/test-output.txt" 2>&1 || true)

  copy_if_present "$d/BENCHMARK_SOLO.log" "$out"
  copy_if_present "$d/BENCHMARK_ARCHITECT.log" "$out"
  copy_if_present "$d/BENCHMARK_DEVELOPER.log" "$out"
  copy_if_present "$d/BENCHMARK_REVIEWER.log" "$out"
  copy_if_present "$d/SPEC.md" "$out"
  copy_if_present "$d/HANDOFF.md" "$out"
  copy_if_present "$d/REVIEW.md" "$out"

  date -u +%Y-%m-%dT%H:%M:%SZ > "$out/collected-at.txt"
  echo "Results collected to $out/"
}

count_diff_lines() {
  local patch="$1" prefix="$2"
  local adds dels
  adds=$(grep -c '^+[^+]' "$patch" 2>/dev/null || true)
  dels=$(grep -c '^-[^-]' "$patch" 2>/dev/null || true)
  echo "${prefix}+${adds:-0} -${dels:-0} lines"
}

summarize_log_proxy() {
  local log="$1"
  [[ -f "$log" ]] || return 0
  local chars tokens name
  chars=$(wc -m < "$log" | tr -d ' ')
  tokens=$(( (chars + 3) / 4 ))
  name="$(basename "$log")"
  echo "- ${name}: ~${tokens} stdout-proxy tokens (${chars} chars)"
}

cmd_report() {
  local rpt="$BENCH_ROOT/report.md"
  {
    echo "# Benchmark Report"
    echo ""
    echo "- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "- Base commit: $(cat "$BENCH_ROOT/base-commit.txt" 2>/dev/null || echo unknown)"
    echo "- Provider: $(cat "$BENCH_ROOT/provider.txt" 2>/dev/null || echo "${PI_PROVIDER:-not pinned}")"
    echo "- Model: $(cat "$BENCH_ROOT/model.txt" 2>/dev/null || echo "${PI_MODEL:-not pinned}")"
    echo "- Thinking: $(cat "$BENCH_ROOT/thinking.txt" 2>/dev/null || echo "${PI_THINKING:-not set}")"
    echo "- Timeout: $(cat "$BENCH_ROOT/timeout-seconds.txt" 2>/dev/null || echo "$BENCH_TIMEOUT_SECONDS") seconds"
    echo "- Pi sessions: $BENCH_ROOT/pi-sessions"
    echo ""
    echo "> Token note: stdout-proxy tokens are chars/4 from captured terminal logs. Prefer exact provider/Pi usage from the isolated session dir or provider dashboard for conclusions."
    echo ""

    for rd in "$BENCH_ROOT/results"/*/; do
      [[ -d "$rd" ]] || continue
      local name; name="$(basename "$rd")"
      echo "## $name"
      echo ""

      [[ -f "$rd/diff.patch" ]] && count_diff_lines "$rd/diff.patch" "Diff: "
      if [[ -f "$rd/diff-stat.txt" ]]; then
        echo ""
        echo "Diff stat:"
        echo '```'
        cat "$rd/diff-stat.txt"
        echo '```'
      fi

      if compgen -G "$rd/BENCHMARK_*.log" > /dev/null; then
        echo ""
        echo "Stdout proxy token estimates:"
        for log in "$rd"/BENCHMARK_*.log; do
          summarize_log_proxy "$log"
        done
      fi

      if [[ -f "$rd/test-output.txt" ]]; then
        echo ""
        echo "Tests:"
        echo '```'
        tail -12 "$rd/test-output.txt" | grep -E 'tests|pass|fail|suites' | head -8 || tail -8 "$rd/test-output.txt"
        echo '```'
      fi

      echo ""
      echo "### Quality Score"
      echo ""
      echo "_TODO: copy scorecard-template.md for manual scoring rubric._"
      echo ""
    done
  } > "$rpt"
  echo "Report: $rpt"
}

cmd_stop() {
  local pids_file pids still
  pids_file="$(mktemp)"

  ps ax -o pid=,command= | awk -v root="$BENCH_ROOT" -v self="$$" '
    index($0, root) > 0 && $1 != self { print $1 }
  ' >> "$pids_file" || true

  for name in pi node bash sh npm; do
    for pid in $(pgrep -x "$name" 2>/dev/null || true); do
      [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)
      case "$cwd" in
        "$BENCH_ROOT"*|/private"$BENCH_ROOT"*) echo "$pid" >> "$pids_file" ;;
      esac
    done
  done

  pids=$(sort -u "$pids_file" | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  rm -f "$pids_file"

  if [[ -z "$pids" ]]; then
    echo "No benchmark processes found under $BENCH_ROOT."
    return 0
  fi

  echo "Stopping benchmark processes: $pids"
  kill $pids 2>/dev/null || true
  sleep 2
  still=""
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then still="$still $pid"; fi
  done
  if [[ -n "$still" ]]; then
    echo "Force-killing still-running processes:$still"
    kill -9 $still 2>/dev/null || true
  fi
}

# ─── Dispatch ─────────────────────────────────────────────────
case "${1:-}" in
  prepare)  cmd_prepare ;;
  run-solo) cmd_run_solo "${2:?Task number required}" ;;
  run-amutix) cmd_run_amutix "${2:?Task number required}" ;;
  collect)  cmd_collect "${2:?Arm required (solo|amutix)}" "${3:?Task number required}" ;;
  report)   cmd_report ;;
  stop)     cmd_stop ;;
  help|--help|-h) usage ;;
  *) usage; exit 1 ;;
esac
