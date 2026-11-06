import type { LinkResearchTaskRecord, LinkResearchTaskStorage } from "./link-research-contracts.js";
import type { ResearchTaskRecord } from "./research-task-contracts.js";
import { parseLinkResearchTaskRecord } from "./link-research-schema.js";
import { parseResearchTaskRecord } from "./research-task-schema.js";
import { SnapshotTaskStore } from "./research-task-store.js";

export class LinkResearchTaskStore extends SnapshotTaskStore<LinkResearchTaskRecord> implements LinkResearchTaskStorage {
  constructor(directory?: string) { super(directory, parseLinkResearchTaskRecord); }
}

export type AnyResearchTaskRecord = ResearchTaskRecord | LinkResearchTaskRecord;
export function parseAnyResearchTaskRecord(input: unknown, id?: string): AnyResearchTaskRecord {
  return input && typeof input === "object" && "schema_version" in input && input.schema_version === "2"
    ? parseLinkResearchTaskRecord(input, id) : parseResearchTaskRecord(input, id);
}

/** Both task generations share capacity, private snapshots and process locks. */
export class AnyResearchTaskStore extends SnapshotTaskStore<AnyResearchTaskRecord> {
  constructor(directory?: string) { super(directory, parseAnyResearchTaskRecord); }
}
