import { EvidenceRecord } from './types';
import { newId, stableHash, iso } from './ids';

/**
 * Selects the single current (valid) version per evidence kind.
 * A record is current when no other record supersedes it and it carries the
 * highest registered version of its kind. This is a pure function of the
 * record list, so real-time reads and historical replays always agree.
 */
export function selectCurrentByKind(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
  const superseded = new Set(records.map((record) => record.supersedes).filter((id): id is string => Boolean(id)));
  const current = new Map<string, EvidenceRecord>();
  for (const record of records) {
    if (superseded.has(record.id)) continue;
    const existing = current.get(record.kind);
    if (!existing || record.version > existing.version) current.set(record.kind, { ...record });
  }
  return current;
}

export function selectCurrentEvidence(records: EvidenceRecord[]): EvidenceRecord[] {
  return [...selectCurrentByKind(records).values()];
}

export class EvidenceLedger {
  add(input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, current: EvidenceRecord[]): EvidenceRecord {
    const hash = stableHash(input.content);
    const siblings = current.filter((record) => record.kind === input.kind);
    // Idempotent re-submission: identical content for the same kind never
    // registers a new version, no matter which channel or retry delivers it.
    const duplicate = siblings.find((record) => record.hash === hash);
    if (duplicate) return { ...duplicate };

    const currentOfKind = selectCurrentByKind(current).get(input.kind);
    let supersedes = input.supersedes;
    if (supersedes) {
      const prior = current.find((record) => record.id === supersedes);
      if (!prior) throw new Error(`cannot supersede unknown evidence ${supersedes}`);
      if (prior.kind !== input.kind) throw new Error(`evidence ${supersedes} is not a ${input.kind} record`);
      if (prior.id !== currentOfKind?.id) throw new Error(`evidence ${supersedes} is already superseded`);
    } else {
      // A new version of a kind automatically replaces the current one, so
      // each kind keeps exactly one valid version and the chain stays linear.
      supersedes = currentOfKind?.id;
    }
    const version = Math.max(0, ...siblings.map((record) => record.version)) + 1;
    return { id: newId('evidence'), kind: input.kind, source: input.source, hash, version, receivedAt: iso(input.receivedAt), reviewed: false, supersedes };
  }

  review(id: string, accepted: boolean, current: EvidenceRecord[]): EvidenceRecord {
    const record = current.find((item) => item.id === id);
    if (!record) throw new Error(`unknown evidence ${id}`);
    // Reviews of superseded versions are still recorded for audit, but the
    // selection functions only read current versions, so a stale conclusion
    // can no longer override the replacement.
    return { ...record, reviewed: true, accepted };
  }

  currentByKind(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
    return selectCurrentByKind(records);
  }

  active(records: EvidenceRecord[]): EvidenceRecord[] {
    return selectCurrentEvidence(records)
      .filter((record) => record.accepted !== false)
      .sort((left, right) => left.kind.localeCompare(right.kind));
  }

  latestAccepted(records: EvidenceRecord[]): EvidenceRecord | undefined {
    return this.active(records)
      .filter((record) => record.reviewed && record.accepted)
      .sort((left, right) => left.version - right.version)
      .at(-1);
  }

  versionsForKind(records: EvidenceRecord[], kind: string): EvidenceRecord[] {
    return records
      .filter((record) => record.kind === kind)
      .sort((left, right) => left.version - right.version)
      .map((record) => ({ ...record }));
  }
}
