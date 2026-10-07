import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { EvidenceLedger } from '../src/domain/evidence';

const report = (app: ReturnType<typeof buildApp>, key: string) =>
  app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'vehicle', id: `car-${key}` }], loss: { currency: 'CNY', gross: 18000 } }, 'test', key);

test('duplicate submissions from mobile, agent and retries are idempotent', () => {
  const app = buildApp();
  const claim = report(app, 'dup');
  const first = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'a' } }, 'mobile');
  const retried = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'a' } }, 'mobile');
  const viaAgent = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: { image: 'a' } }, 'agent');
  assert.equal(first.evidence.length, 1);
  assert.equal(retried.evidence.length, 1);
  assert.equal(viaAgent.evidence.length, 1);
  assert.equal(retried.version, first.version);
  assert.equal(viaAgent.version, first.version);
  assert.equal(viaAgent.evidence[0].version, 1);
  assert.equal(viaAgent.evidence[0].source, 'mobile');
});

test('a new version of a kind supersedes the current one and only one stays active', () => {
  const app = buildApp();
  const ledger = new EvidenceLedger();
  const claim = report(app, 'chain');
  const v1 = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'agent', content: { items: ['bumper'] } }, 'agent').evidence[0];
  const state = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'mobile', content: { items: ['bumper', 'lamp'] } }, 'mobile');
  const v2 = state.evidence.find((record) => record.id !== v1.id)!;
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes, v1.id);
  // both versions remain stored for audit, but only the replacement is active
  assert.equal(state.evidence.length, 2);
  assert.deepEqual(ledger.active(state.evidence).map((record) => record.id), [v2.id]);
  assert.deepEqual(ledger.versionsForKind(state.evidence, 'repair-estimate').map((record) => record.version), [1, 2]);
});

test('reviewing a superseded version stays auditable but cannot drive adjustment', () => {
  const app = buildApp();
  const ledger = new EvidenceLedger();
  const claim = report(app, 'stale-review');
  const v1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'old' } }, 'mobile').evidence[0];
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: { image: 'new' } }, 'agent');
  const reviewed = app.claims.reviewEvidence(claim.id, v1.id, true, 'adjuster');
  const stale = reviewed.evidence.find((record) => record.id === v1.id)!;
  assert.equal(stale.reviewed, true);
  assert.equal(stale.accepted, true);
  // the accepted conclusion on the old version must not leak into current selection
  assert.equal(ledger.latestAccepted(reviewed.evidence), undefined);
  const decision = app.rules.evaluate(reviewed, reviewed.ruleSnapshot!);
  assert.ok(decision.reasons.some((reason) => reason.startsWith('missing-evidence')));
  // reviewing the current version unblocks the rule
  const current = ledger.active(reviewed.evidence)[0];
  const accepted = app.claims.reviewEvidence(claim.id, current.id, true, 'adjuster');
  assert.equal(ledger.latestAccepted(accepted.evidence)?.id, current.id);
  assert.ok(!app.rules.evaluate(accepted, accepted.ruleSnapshot!).reasons.some((reason) => reason.startsWith('missing-evidence')));
});

test('replacement chains reject stale, unknown and cross-kind supersedes targets', () => {
  const app = buildApp();
  const claim = report(app, 'chain-guard');
  const v1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'one' } }, 'mobile').evidence[0];
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'two' } }, 'mobile');
  const other = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'agent', content: { items: [] } }, 'agent').evidence.find((record) => record.kind === 'repair-estimate')!;
  assert.throws(() => app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'three' }, supersedes: v1.id }, 'mobile'), /already superseded/);
  assert.throws(() => app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'three' }, supersedes: 'evidence_missing' }, 'mobile'), /unknown evidence/);
  assert.throws(() => app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'three' }, supersedes: other.id }, 'mobile'), /not a loss-photo record/);
  // a retry of an already applied replacement is a no-op, not a stale-chain error
  const current = app.claims.get(claim.id);
  const retry = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'two' }, supersedes: v1.id }, 'mobile');
  assert.equal(retry.version, current.version);
  assert.equal(retry.evidence.length, current.evidence.length);
});

test('current selection follows the highest version, not arrival or receipt order', () => {
  const app = buildApp();
  const ledger = new EvidenceLedger();
  const claim = report(app, 'order');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'first' }, receivedAt: '2026-08-01T10:00:00Z' }, 'mobile');
  const state = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: { image: 'second' }, receivedAt: '2026-08-01T09:30:00Z' }, 'agent');
  const active = ledger.active(state.evidence);
  assert.equal(active.length, 1);
  assert.equal(active[0].version, 2);
  assert.equal(active[0].source, 'agent');
});

test('duplicate reviews are idempotent no-ops', () => {
  const app = buildApp();
  const claim = report(app, 'review-dup');
  const evidence = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'a' } }, 'mobile').evidence[0];
  const reviewed = app.claims.reviewEvidence(claim.id, evidence.id, true, 'adjuster');
  const again = app.claims.reviewEvidence(claim.id, evidence.id, true, 'adjuster');
  assert.equal(again.version, reviewed.version);
  assert.equal(again.audit.length, reviewed.audit.length);
  const changed = app.claims.reviewEvidence(claim.id, evidence.id, false, 'adjuster');
  assert.equal(changed.evidence[0].accepted, false);
});

test('replaying history yields the same evidence set and review results as live processing', () => {
  const app = buildApp();
  const ledger = new EvidenceLedger();
  const claim = report(app, 'replay');
  const v1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'old' } }, 'mobile').evidence[0];
  app.claims.reviewEvidence(claim.id, v1.id, true, 'adjuster');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: { image: 'new' } }, 'agent');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: { image: 'new' } }, 'agent'); // retry
  const v2 = app.claims.get(claim.id).evidence.find((record) => record.id !== v1.id)!;
  app.claims.reviewEvidence(claim.id, v2.id, true, 'adjuster');
  app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'mobile', content: { items: ['lamp'] } }, 'mobile');
  const live = app.claims.get(claim.id);
  const replayed = app.replay.execute(claim.id).state;
  assert.deepEqual(replayed.evidence, live.evidence);
  assert.deepEqual(ledger.active(replayed.evidence), ledger.active(live.evidence));
  assert.equal(ledger.latestAccepted(replayed.evidence)?.id, ledger.latestAccepted(live.evidence)?.id);
  assert.equal(ledger.latestAccepted(replayed.evidence)?.id, v2.id);
  assert.equal(replayed.version, live.version);
});
