#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP_DIR="$(mktemp -d /tmp/local-subagents-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

TEST_BIN="$TMP_DIR/bin"
TEST_LOGS="$TMP_DIR/logs"
mkdir -p "$TEST_BIN" "$TEST_LOGS"

# 1. Create fake/mock provider binaries
cat << 'EOF' > "$TEST_BIN/claude"
#!/usr/bin/env bash
sleep 0.1
echo "Mock Claude executed: $@"
echo '{"outcome":"done","summary":"Mock claude done","changedFiles":[],"verification":[{"command":"test","status":"passed"}],"blockers":[],"incomplete":[],"nextSteps":[]}'
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
echo '{"outcome":"done","summary":"Mock agy done","changedFiles":[],"verification":[],"blockers":[],"incomplete":[],"nextSteps":[]}'
exit 0
EOF

cat << 'EOF' > "$TEST_BIN/codex"
#!/usr/bin/env bash
sleep 0.1
echo "Mock Codex executed: $@"
echo '{"outcome":"done","summary":"Mock codex done","changedFiles":[],"verification":[],"blockers":[],"incomplete":[],"nextSteps":[]}'
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
echo '{"outcome":"done","summary":"Mock opencode done","changedFiles":[],"verification":[],"blockers":[],"incomplete":[],"nextSteps":[]}'
exit 0
EOF

chmod +x "$TEST_BIN"/*

export PATH="$TEST_BIN:$PATH"
export SUBAGENT_CLAUDE_BIN="$TEST_BIN/claude"
export SUBAGENT_AGY_BIN="$TEST_BIN/agy"
export SUBAGENT_CODEX_BIN="$TEST_BIN/codex"
export SUBAGENT_OPENCODE_BIN="$TEST_BIN/opencode"
export SUBAGENT_LOG_DIR="$TEST_LOGS"

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
  out="$("$@" 2>&1 || true)"
  if echo "$out" | grep -qE "$pattern"; then
    echo "PASS"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL (expected pattern: $pattern)"
    echo "Actual output:"
    echo "$out"
    FAILED=$((FAILED + 1))
  fi
}

echo "=== Running local-subagents mock tests ==="

# Test help flags
assert_output_contains "antigravity-subagent --help" "Usage:" "$REPO_DIR/antigravity-subagent" --help
assert_output_contains "claude-subagent --help" "Usage:" "$REPO_DIR/claude-subagent" --help
assert_output_contains "codex-subagent --help" "Usage:" "$REPO_DIR/codex-subagent" --help
assert_output_contains "opencode-subagent --help" "Usage:" "$REPO_DIR/opencode-subagent" --help

# Test models commands
assert_output_contains "antigravity-subagent --models" "Gemini 3.8 Flash" "$REPO_DIR/antigravity-subagent" --models
assert_output_contains "opencode-subagent --models" "openai/gpt-5.6-sol" "$REPO_DIR/opencode-subagent" --models

# Test argument invocation
assert_output_contains "claude-subagent argument task" "Mock claude done" "$REPO_DIR/claude-subagent" "Test task"
assert_output_contains "antigravity-subagent argument task" "Mock agy done" "$REPO_DIR/antigravity-subagent" "Test task"
assert_output_contains "codex-subagent argument task" "Mock codex done" "$REPO_DIR/codex-subagent" "Test task"
assert_output_contains "opencode-subagent argument task" "Mock opencode done" "$REPO_DIR/opencode-subagent" "Test task"

# Test stdin invocation
assert_output_contains "claude-subagent stdin task" "Mock claude done" bash -c "printf '%s\n' 'Stdin test' | '$REPO_DIR/claude-subagent'"

# Test log file creation
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
