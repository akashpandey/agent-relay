import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStructuredOutcome } from '../dashboard/parser.js';

test('Outcome Parser: infers done when contract fields exist without explicit outcome key', () => {
  const snippet = `{"verification":[{"command":"node -e '... process.exit(1);'","status":"passed"}],"blockers":[],"incomplete":[],"nextSteps":[]}`;
  const res = extractStructuredOutcome(snippet, '', 'completed');
  assert.equal(res.outcome, 'done');
  assert.equal(res.attentionRequired, false);
  assert.equal(res.verification.length, 1);
  assert.equal(res.verification[0].status, 'passed');
});

test('Outcome Parser: infers blocked when blockers are present without explicit outcome key', () => {
  const snippet = `{"verification":[],"blockers":["Missing API key for service"],"incomplete":[]}`;
  const res = extractStructuredOutcome(snippet, '', 'completed');
  assert.equal(res.outcome, 'blocked');
  assert.equal(res.attentionRequired, true);
});

test('Outcome Parser: infers partial when incomplete tasks are present without explicit outcome key', () => {
  const snippet = `{"verification":[],"blockers":[],"incomplete":["Need to write documentation"]}`;
  const res = extractStructuredOutcome(snippet, '', 'completed');
  assert.equal(res.outcome, 'partial');
  assert.equal(res.attentionRequired, true);
});

test('Outcome Parser: does not let benign phrases trigger negative outcome in prose fallback', () => {
  const prose1 = 'TCP is connection-oriented, guaranteeing ordered, error-checked delivery via a handshake; UDP is connectionless.';
  const res1 = extractStructuredOutcome(prose1, '', 'completed');
  assert.equal(res1.outcome, 'done');

  const prose2 = 'Completed the auth refactor. All 18 tests passed (0 failed, 0 errors, 0 skipped, 0 remaining).';
  const res2 = extractStructuredOutcome(prose2, '', 'completed');
  assert.equal(res2.outcome, 'done');

  const prose3 = 'Added robust error handling around payment webhook processing.';
  const res3 = extractStructuredOutcome(prose3, '', 'completed');
  assert.equal(res3.outcome, 'done');
});

test('Outcome Parser: correctly identifies genuine errors in prose fallback', () => {
  const failProse = 'Encountered an unrecoverable error while connecting to the database: connection refused.';
  const res = extractStructuredOutcome(failProse, '', 'failed');
  assert.equal(res.outcome, 'failed');
  assert.equal(res.attentionRequired, true);
});
