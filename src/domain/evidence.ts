import { EvidenceRecord } from './types';
import { newId, stableHash, iso } from './ids';

export interface EvidenceInput {
  kind: string;
  source: string;
  content: unknown;
  receivedAt?: string;
  supersedes?: string;
}

const clone = (record: EvidenceRecord): EvidenceRecord => ({ ...record });

/** Same kind + same content hash means the same material, regardless of channel or idempotency key. */
export function findIdenticalEvidence(records: EvidenceRecord[], kind: string, content: unknown): EvidenceRecord | undefined {
  const hash = stableHash(content);
  return records.find((record) => record.kind === kind && record.hash === hash);
}

/** Transitive closure: every id reachable through any record's `supersedes` link is obsolete. */
export function supersededIds(records: EvidenceRecord[]): Set<string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const superseded = new Set<string>();
  for (const record of records) {
    const seen = new Set<string>();
    let nextId = record.supersedes;
    while (nextId && !seen.has(nextId)) {
      seen.add(nextId);
      const target = byId.get(nextId);
      if (!target) break;
      superseded.add(nextId);
      nextId = target.supersedes;
    }
  }
  return superseded;
}

const isNewerCurrent = (candidate: EvidenceRecord, existing: EvidenceRecord): boolean => {
  if (candidate.version !== existing.version) return candidate.version > existing.version;
  if (candidate.receivedAt !== existing.receivedAt) return candidate.receivedAt > existing.receivedAt;
  return candidate.id > existing.id;
};

/** Exactly one current record per kind: the highest-version record not on any supersession chain. */
export function currentByKind(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
  const superseded = supersededIds(records);
  const map = new Map<string, EvidenceRecord>();
  for (const record of records) {
    if (superseded.has(record.id)) continue;
    const existing = map.get(record.kind);
    if (!existing || isNewerCurrent(record, existing)) map.set(record.kind, clone(record));
  }
  return map;
}

export function currentRecords(records: EvidenceRecord[]): EvidenceRecord[] {
  return [...currentByKind(records).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .map(clone);
}

/** Effective material that may drive adjustment: current versions only, rejected heads excluded. */
export function activeRecords(records: EvidenceRecord[]): EvidenceRecord[] {
  return currentRecords(records).filter((record) => record.accepted !== false);
}

export class EvidenceLedger {
  /**
   * Registers an incoming submission.
   * - Identical (kind, content) resubmissions from any channel are idempotent and return the existing record.
   * - A new distinct version implicitly supersedes the current head when `supersedes` is omitted.
   * - Explicit supersession must target an existing, still-current record of the same kind.
   */
  add(input: EvidenceInput, current: EvidenceRecord[]): EvidenceRecord {
    const duplicate = findIdenticalEvidence(current, input.kind, input.content);
    if (duplicate) return clone(duplicate);

    const siblings = current.filter((record) => record.kind === input.kind);
    let supersedes = input.supersedes;
    if (supersedes) {
      const target = current.find((record) => record.id === supersedes);
      if (!target) throw new Error(`cannot supersede unknown evidence ${supersedes}`);
      if (target.kind !== input.kind) throw new Error(`cannot supersede ${target.kind} evidence with ${input.kind}`);
      const headIds = new Set([...currentByKind(current).values()].map((record) => record.id));
      if (!headIds.has(target.id)) throw new Error(`evidence ${supersedes} has already been superseded; supersede the current version instead`);
    } else {
      supersedes = currentByKind(siblings).get(input.kind)?.id;
    }

    const nextVersion = siblings.reduce((max, record) => Math.max(max, record.version), 0) + 1;
    return {
      id: newId('evidence'),
      kind: input.kind,
      source: input.source,
      hash: stableHash(input.content),
      version: nextVersion,
      receivedAt: iso(input.receivedAt),
      reviewed: false,
      supersedes,
    };
  }

  review(id: string, accepted: boolean, current: EvidenceRecord[]): EvidenceRecord {
    const record = current.find((item) => item.id === id);
    if (!record) throw new Error(`unknown evidence ${id}`);
    const headIds = new Set([...currentByKind(current).values()].map((item) => item.id));
    if (!headIds.has(id)) {
      throw new Error(`evidence ${id} has been superseded; its prior conclusion remains audited but cannot drive the claim`);
    }
    return { ...record, reviewed: true, accepted };
  }

  currentByKind(records: EvidenceRecord[]): Map<string, EvidenceRecord> { return currentByKind(records); }

  current(records: EvidenceRecord[]): EvidenceRecord[] { return currentRecords(records); }

  active(records: EvidenceRecord[]): EvidenceRecord[] { return activeRecords(records); }

  latestAccepted(records: EvidenceRecord[]): EvidenceRecord | undefined {
    return activeRecords(records)
      .filter((record) => record.reviewed && record.accepted)
      .sort((left, right) => {
        if (right.version !== left.version) return right.version - left.version;
        const byTime = right.receivedAt.localeCompare(left.receivedAt);
        return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
      })[0];
  }

  /** Full version history for audit; superseded records stay readable forever. */
  versionsForKind(records: EvidenceRecord[], kind: string): EvidenceRecord[] {
    return records
      .filter((record) => record.kind === kind)
      .sort((left, right) => left.version - right.version)
      .map((record) => ({ ...record }));
  }
}
