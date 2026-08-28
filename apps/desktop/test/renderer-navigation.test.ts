import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_RENDERER_ORIGIN,
  rendererEntryUrl,
  rendererNavigationAllowed,
} from "../src/renderer-security.js";

describe("desktop renderer origin boundary", () => {
  const rendererFile = "R:\\app\\renderer\\index.html";

  it("ignores an injected renderer URL in packaged mode", () => {
    const entry = rendererEntryUrl({
      packaged: true,
      rendererUrl: "https://evil.test/steal",
      rendererFile,
    });
    expect(entry).toMatch(/^file:/u);
    expect(entry).not.toContain("evil.test");
  });

  it("allows only the exact existing 127.0.0.1:9999 development origin", () => {
    expect(
      rendererEntryUrl({
        packaged: false,
        rendererUrl: DEVELOPMENT_RENDERER_ORIGIN,
        rendererFile,
      }),
    ).toBe(`${DEVELOPMENT_RENDERER_ORIGIN}/`);
    for (const rendererUrl of [
      "http://localhost:9999",
      "http://127.0.0.1:9998",
      "http://127.0.0.1:9999/other",
      "https://127.0.0.1:9999",
      "https://evil.test",
    ]) {
      expect(() => rendererEntryUrl({ packaged: false, rendererUrl, rendererFile })).toThrow(
        "ATM_RENDERER_URL_INVALID",
      );
    }
  });

  it("denies cross-origin navigation while retaining same-entry routes", () => {
    const fileEntry = rendererEntryUrl({ packaged: true, rendererFile });
    expect(rendererNavigationAllowed(fileEntry, `${fileEntry}#project/ATM`)).toBe(true);
    expect(rendererNavigationAllowed(fileEntry, "https://evil.test")).toBe(false);
    expect(
      rendererNavigationAllowed(
        `${DEVELOPMENT_RENDERER_ORIGIN}/`,
        `${DEVELOPMENT_RENDERER_ORIGIN}/@vite/client`,
      ),
    ).toBe(true);
    expect(
      rendererNavigationAllowed(`${DEVELOPMENT_RENDERER_ORIGIN}/`, "http://127.0.0.1:9998/"),
    ).toBe(false);
  });
});
