import { EvidenceRecord } from './types';
import { newId, stableHash, iso } from './ids';

export class EvidenceLedger {
  add(input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, current: EvidenceRecord[]): EvidenceRecord {
    const prior = input.supersedes ? current.find((record) => record.id === input.supersedes) : undefined;
    if (input.supersedes && !prior) throw new Error(`cannot supersede unknown evidence ${input.supersedes}`);
    const siblings = current.filter((record) => record.kind === input.kind);
    return { id: newId('evidence'), kind: input.kind, source: input.source, hash: stableHash(input.content), version: (siblings.at(-1)?.version ?? 0) + 1, receivedAt: iso(input.receivedAt), reviewed: false, supersedes: input.supersedes };
  }

  review(id: string, accepted: boolean, current: EvidenceRecord[]): EvidenceRecord {
    const record = current.find((item) => item.id === id);
    if (!record) throw new Error(`unknown evidence ${id}`);
    return { ...record, reviewed: true, accepted };
  }

  currentByKind(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
    const map = new Map<string, EvidenceRecord>();
    const superseded = new Set(records.map((record) => record.supersedes).filter(Boolean) as string[]);
    const ordered = [...records].sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
    for (const record of ordered) {
      if (superseded.has(record.id)) continue;
      const existing = map.get(record.kind);
      if (!existing || record.version >= existing.version) {
        map.set(record.kind, { ...record, reviewed: Boolean(record.reviewed && record.accepted) });
      }
    }
    return map;
  }

  active(records: EvidenceRecord[]): EvidenceRecord[] {
    const visible = records
      .filter((record) => record.accepted !== false)
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
    const current = this.currentByKind(visible);
    return [...visible, ...current.values()]
      .filter((record, index, all) => all.findIndex((item) => item.id === record.id) === index)
      .sort((left, right) => left.kind.localeCompare(right.kind));
  }

  latestAccepted(records: EvidenceRecord[]): EvidenceRecord | undefined {
    const active = this.active(records);
    return active
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
