import { describe, expect, it } from "vitest";
import { RecordPageSchema, RecordViewSchema } from "../src/index.js";

const record = {
  id: "record-1",
  key: "REC-R-001",
  kind: "FACT",
  title: "Record",
  summary: "Canonical camelCase",
  detail: "",
  importance: "NORMAL",
  scope: "PROJECT",
  workItemKey: "REC-T-0001",
  supersedes: null,
  status: "ACTIVE",
  topic: "pagination",
  subjectKey: "record:1",
  relatedRecords: [],
  opId: "record-op",
  sourceType: "AGENT",
  sourceActorId: "agent-a",
  sourceSessionId: "session-a",
  sourceRef: null,
  createdAt: "2026-08-27T20:00:00.000Z",
  updatedAt: "2026-08-27T20:00:00.000Z",
};

describe("Record canonical view", () => {
  it("accepts only the complete camelCase view and page envelope", () => {
    expect(RecordViewSchema.parse(record)).toEqual(record);
    expect(RecordPageSchema.parse({ items: [record], nextCursor: null, hasMore: false })).toEqual({
      items: [record],
      nextCursor: null,
      hasMore: false,
    });
    expect(() => RecordViewSchema.parse({ ...record, source_type: "AGENT" })).toThrow();
    expect(() => RecordViewSchema.parse({ ...record, sourceType: undefined })).toThrow();
  });
});
