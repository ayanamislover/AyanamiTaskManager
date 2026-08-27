import { describe, expect, it } from "vitest";
import { recordDraftToUserInput } from "../src/record-input.js";

describe("UI Record request construction", () => {
  it("retains trimmed topic/subjectKey in the typed user input", () => {
    expect(
      recordDraftToUserInput({
        opId: "ui-record-input",
        kind: "FACT",
        importance: "HIGH",
        title: "UI record",
        summary: "UI must write the same metadata it displays.",
        detail: "detail",
        topic: "  release/1.0.16  ",
        subjectKey: "  candidate:ui-input  ",
      }),
    ).toEqual({
      opId: "ui-record-input",
      kind: "FACT",
      importance: "HIGH",
      title: "UI record",
      summary: "UI must write the same metadata it displays.",
      detail: "detail",
      topic: "release/1.0.16",
      subjectKey: "candidate:ui-input",
      scope: "PROJECT",
    });
  });

  it("omits optional topic metadata when both fields are blank", () => {
    expect(
      recordDraftToUserInput({
        opId: "ui-record-input-blank",
        kind: "FACT",
        importance: "NORMAL",
        title: "UI record",
        summary: "No optional metadata.",
        detail: "",
        topic: "  ",
        subjectKey: "",
      }),
    ).not.toHaveProperty("topic");
  });
});
