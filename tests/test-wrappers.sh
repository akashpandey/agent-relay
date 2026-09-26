#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP_DIR="$(mktemp -d /tmp/agent-relay-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

TEST_BIN="$TMP_DIR/bin"
TEST_LOGS="$TMP_DIR/logs"
TEST_DATA="$TMP_DIR/data"
mkdir -p "$TEST_BIN" "$TEST_LOGS" "$TEST_DATA"

# 1. Create fake/mock provider binaries
cat << 'EOF' > "$TEST_BIN/claude"
#!/usr/bin/env bash
sleep 0.1
echo "Mock Claude executed: $@"
echo '{"type":"result","result":"{\"outcome\":\"done\",\"summary\":\"Mock claude done\",\"changedFiles\":[],\"verification\":[{\"command\":\"test\",\"status\":\"passed\"}],\"blockers\":[],\"incomplete\":[],\"nextSteps\":[]}"}'
exit 0
EOF

cat << 'EOF' > "$TEST_BIN/agy"
#!/usr/bin/env bash
if [ "${1:-}" = "models" ]; then
  echo "gemini-3.8-flash-high     Gemini 3.8 Flash (High)"
  echo "gemini-3.1-pro-high       Gemini 3.1 Pro (High)"
  exit 0
fi
sleep 0.1
echo "Mock Antigravity executed: $@"
echo '{"type":"result","result":"{\"outcome\":\"done\",\"summary\":\"Mock agy done\",\"changedFiles\":[],\"verification\":[],\"blockers\":[],\"incomplete\":[],\"nextSteps\":[]}"}'
exit 0
EOF

cat << 'EOF' > "$TEST_BIN/codex"
#!/usr/bin/env bash
sleep 0.1
echo "Mock Codex executed: $@"
echo '{"type":"result","result":"{\"outcome\":\"done\",\"summary\":\"Mock codex done\",\"changedFiles\":[],\"verification\":[],\"blockers\":[],\"incomplete\":[],\"nextSteps\":[]}"}'
exit 0
EOF

cat << 'EOF' > "$TEST_BIN/opencode"
#!/usr/bin/env bash
if [ "${1:-}" = "models" ]; then
  echo "openai/gpt-5.6-sol"
  echo "zai-coding-plan/glm-5.3"
  echo "opencode-go/qwen3.8-max"
  exit 0
fi
sleep 0.1
echo "Mock OpenCode executed: $@"
echo '{"type":"result","result":"{\"outcome\":\"done\",\"summary\":\"Mock opencode done\",\"changedFiles\":[],\"verification\":[],\"blockers\":[],\"incomplete\":[],\"nextSteps\":[]}"}'
exit 0
EOF

chmod +x "$TEST_BIN"/*

export PATH="$TEST_BIN:$PATH"
export AGENT_RELAY_CLAUDE_BIN="$TEST_BIN/claude"
export AGENT_RELAY_AGY_BIN="$TEST_BIN/agy"
export AGENT_RELAY_CODEX_BIN="$TEST_BIN/codex"
export AGENT_RELAY_OPENCODE_BIN="$TEST_BIN/opencode"
export AGENT_RELAY_LOG_DIR="$TEST_LOGS"
export AGENT_RELAY_DATA_DIR="$TEST_DATA"
export AGENT_RELAY_DB_PATH="$TEST_DATA/agents.db"

PASSED=0
FAILED=0

assert_success() {
  local desc="$1"
  shift
  echo -n "Running: $desc ... "
  if "$@" >/dev/null 2>&1; then
    echo "PASS"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL"
    FAILED=$((FAILED + 1))
  fi
}

assert_output_contains() {
  local desc="$1"
  local pattern="$2"
  shift 2
  echo -n "Running: $desc ... "
  local out
  touch "$TMP_DIR/output-marker"
  out="$("$@" 2>&1 || true)"
  if { printf '%s\n' "$out"; find "$TEST_LOGS" -maxdepth 1 -type f -name '*.log' -newer "$TMP_DIR/output-marker" -exec cat {} +; } | grep -E "$pattern" >/dev/null; then
    echo "PASS"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL (expected pattern: $pattern)"
    echo "Actual output:"
    echo "$out"
    FAILED=$((FAILED + 1))
  fi
}

echo "=== Running agent-relay mock tests ==="

# Test help flags
assert_output_contains "antigravity-agent --help" "Usage:" "$REPO_DIR/antigravity-agent" --help
assert_output_contains "claude-agent --help" "Usage:" "$REPO_DIR/claude-agent" --help
assert_output_contains "codex-agent --help" "Usage:" "$REPO_DIR/codex-agent" --help
assert_output_contains "opencode-agent --help" "Usage:" "$REPO_DIR/opencode-agent" --help

# Test models commands
assert_output_contains "antigravity-agent --models" "Gemini 3.8 Flash" "$REPO_DIR/antigravity-agent" --models
assert_output_contains "opencode-agent --models" "openai/gpt-5.6-sol" "$REPO_DIR/opencode-agent" --models
assert_output_contains "codex-agent --models" "gpt" "$REPO_DIR/codex-agent" --models
assert_output_contains "claude-agent --models" "opus" "$REPO_DIR/claude-agent" --models
assert_output_contains "relay models" "codex" "$REPO_DIR/relay" models

# Test argument invocation
assert_output_contains "claude-agent argument task" "Mock claude done" "$REPO_DIR/claude-agent" "Test task"
assert_output_contains "antigravity-agent argument task" "Mock agy done" "$REPO_DIR/antigravity-agent" "Test task"
assert_output_contains "codex-agent argument task" "Mock codex done" "$REPO_DIR/codex-agent" "Test task"
assert_output_contains "opencode-agent argument task" "Mock opencode done" "$REPO_DIR/opencode-agent" "Test task"

# Test stdin invocation
assert_output_contains "claude-agent stdin task" "Mock claude done" bash -c "printf '%s\n' 'Stdin test' | '$REPO_DIR/claude-agent'"

# Test relay CLI and takeover command
assert_output_contains "relay help" "takeover" "$REPO_DIR/relay"
assert_output_contains "relay takeover help" "Usage: relay takeover" "$REPO_DIR/relay" takeover
assert_output_contains "relay opencode task" "Mock opencode done" "$REPO_DIR/relay" opencode "Complete testing"

# Test log file creation
assert_success "all runs persist result payloads" node --input-type=module -e '
  import fs from "node:fs";
  import assert from "node:assert/strict";
  const dir = process.env.AGENT_RELAY_LOG_DIR;
  const logs = fs.readdirSync(dir).filter(f => f.endsWith(".log"));
  assert.ok(logs.length >= 4);
  for (const log of logs) {
    const done = JSON.parse(fs.readFileSync(`${dir}/${log.replace(/\.log$/, ".done")}`, "utf8"));
    assert.equal(done.exitCode, 0);
    assert.equal(done.result.outcome, "done");
    assert.match(done.result.summary, /^Mock /);
    assert.ok(Array.isArray(done.result.verification));
  }
'
log_count=$(find "$TEST_LOGS" -type f -name "*.log" | wc -l)
echo -n "Verifying run logs were written ($log_count found) ... "
if [ "$log_count" -ge 4 ]; then
  echo "PASS"
  PASSED=$((PASSED + 1))
else
  echo "FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "=== Test Summary ==="
echo "Passed: $PASSED"
echo "Failed: $FAILED"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
