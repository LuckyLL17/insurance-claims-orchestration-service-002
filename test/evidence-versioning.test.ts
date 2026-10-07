import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { EvidenceLedger, currentByKind, activeRecords } from '../src/domain/evidence';

const payload = () => ({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'vehicle' as const, id: 'car-9' }], loss: { currency: 'CNY', gross: 18000 } });

test('identical submissions from mobile, agent and retries stay idempotent', () => {
  const app = buildApp();
  const claim = app.claims.create(payload(), 'call-center');
  const mobile = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'v1' } }, 'mobile', 'upload-1');
  const retried = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'v1' } }, 'mobile'); // retry without key
  const fromAgent = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: { image: 'v1' } }, 'agent', 'agent-upload-1'); // different channel + key

  assert.equal(retried.evidence.length, 1);
  assert.equal(fromAgent.evidence.length, 1);
  assert.equal(fromAgent.evidence[0].id, mobile.evidence[0].id);
  assert.equal(fromAgent.currentEvidence.length, 1);
  assert.equal(fromAgent.currentEvidence[0].source, 'mobile'); // first registration wins
});

test('supersession chain leaves exactly one current version per kind and old versions stay auditable', () => {
  const app = buildApp();
  const claim = app.claims.create(payload(), 'call-center');
  const v1 = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'mobile', content: { amount: 1000 } }, 'mobile').evidence[0];
  app.claims.reviewEvidence(claim.id, v1.id, true, 'adjuster-1');
  const v2 = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'agent', content: { amount: 1200 } }, 'agent').evidence[1];
  const v3 = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'mobile', content: { amount: 1150 } }, 'mobile').evidence[2];

  assert.equal(v1.version, 1); assert.equal(v2.version, 2); assert.equal(v3.version, 3);
  assert.equal(v2.supersedes, v1.id); assert.equal(v3.supersedes, v2.id);

  const head = app.claims.get(claim.id);
  assert.deepEqual(head.currentEvidence.map((e) => e.id), [v3.id]);
  assert.equal(app.claims.get(claim.id).evidence.length, 3, 'superseded versions remain on record for audit');

  // The human conclusion on the old version cannot keep driving the claim.
  assert.throws(() => app.claims.reviewEvidence(claim.id, v1.id, true, 'adjuster-2'), /has been superseded/);
  assert.throws(() => app.claims.reviewEvidence(claim.id, v2.id, true, 'adjuster-2'), /has been superseded/);

  // An accepted old version must not count while the new one is pending or rejected.
  const ledger = new EvidenceLedger();
  assert.equal(ledger.latestAccepted(head.evidence)?.id, undefined);
  app.claims.reviewEvidence(claim.id, v3.id, false, 'adjuster-2'); // new version rejected
  const rejected = app.claims.get(claim.id);
  assert.deepEqual(activeRecords(rejected.evidence).map((e) => e.id), []);
  assert.equal(ledger.latestAccepted(rejected.evidence), undefined);

  // ... and once the new version is accepted, it (never the old one) drives adjustment.
  const v4 = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'agent', content: { amount: 1100 } }, 'agent').evidence[3];
  app.claims.reviewEvidence(claim.id, v4.id, true, 'adjuster-3');
  const final = app.claims.get(claim.id);
  assert.deepEqual(final.currentEvidence.map((e) => e.id), [v4.id]);
  assert.equal(new EvidenceLedger().latestAccepted(final.evidence)?.id, v4.id);
  const history = ledger.versionsForKind(final.evidence, 'repair-estimate').map((e) => e.version);
  assert.deepEqual(history, [1, 2, 3, 4]);
});

test('cannot explicitly supersede an already-superseded record or a different kind', () => {
  const app = buildApp();
  const claim = app.claims.create(payload(), 'call-center');
  const v1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: 'a' }, 'mobile').evidence[0];
  const v2 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: 'b' }, 'mobile').evidence[1];
  assert.throws(
    () => app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: 'c', supersedes: v1.id }, 'mobile'),
    /already been superseded/,
  );
  assert.throws(
    () => app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'mobile', content: 'c', supersedes: v2.id }, 'mobile'),
    /cannot supersede loss-photo evidence with repair-estimate/,
  );
});

test('rule gate only honors accepted current evidence', () => {
  const app = buildApp();
  const claim = app.claims.create(payload(), 'call-center');
  const photo1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: 'p1' }, 'mobile').evidence[0];
  app.claims.reviewEvidence(claim.id, photo1.id, true, 'adjuster-1');
  const photo2 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'p2' }, 'agent').evidence[1];

  const pending = app.claims.get(claim.id);
  const reasons = app.rules.evaluate(pending, pending.ruleSnapshot!).reasons;
  assert.ok(reasons.some((r) => r.startsWith('missing-evidence:')), 'old accepted version must not satisfy the gate');

  app.claims.reviewEvidence(claim.id, photo2.id, true, 'adjuster-2');
  const ready = app.claims.get(claim.id);
  assert.deepEqual(app.rules.evaluate(ready, ready.ruleSnapshot!).reasons, []);
});

test('historical replay yields the same evidence set and review outcome as live processing', () => {
  const app = buildApp();
  const claim = app.claims.create(payload(), 'call-center');
  const photo1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: 'p1' }, 'mobile', 'ev-1').evidence[0];
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: 'p1' }, 'mobile', 'ev-1'); // retried key
  const repair = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'agent', content: 'r1' }, 'agent', 'ev-2').evidence.find((e) => e.kind === 'repair-estimate')!;
  app.claims.reviewEvidence(claim.id, photo1.id, true, 'adjuster-1');
  const photo2 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'p2' }, 'agent', 'ev-3').evidence.find((e) => e.kind === 'loss-photo' && e.version === 2)!;
  app.claims.reviewEvidence(claim.id, photo2.id, true, 'adjuster-2');
  assert.notEqual(repair.id, photo2.id);

  const live = app.claims.get(claim.id);
  const replayed = app.replay.execute(claim.id).state;

  assert.deepEqual(replayed.evidence.map((e) => e.id), live.evidence.map((e) => e.id));
  assert.deepEqual(replayed.currentEvidence.map((e) => e.id), live.currentEvidence.map((e) => e.id));
  assert.deepEqual(replayed.currentEvidence.map((e) => [e.kind, e.version, e.accepted]), [['loss-photo', 2, true], ['repair-estimate', 1, undefined]]);
  assert.equal(replayed.version, live.version);

  // Replaying the same event stream twice is deterministic.
  const again = app.replay.execute(claim.id).state;
  assert.deepEqual(again.currentEvidence.map((e) => e.id), live.currentEvidence.map((e) => e.id));
});

test('transitive replacement collapses a v1->v2->v3 chain to a single head', () => {
  const ledger = new EvidenceLedger();
  const v1 = ledger.add({ kind: 'k', source: 'mobile', content: 'a' }, []);
  const v2 = ledger.add({ kind: 'k', source: 'mobile', content: 'b' }, [v1]);
  const v3 = ledger.add({ kind: 'k', source: 'mobile', content: 'c' }, [v1, v2]);
  const heads = currentByKind([v1, v2, v3]);
  assert.deepEqual([...heads.keys()], ['k']);
  assert.equal(heads.get('k')!.id, v3.id);
});
