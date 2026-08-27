import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AtmError,
  ERROR_POLICIES,
  isAtmErrorCode,
  type AtmErrorCode,
  type ErrorDetailsByCode,
} from "../src/index.js";

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function unregisteredAtmErrorCodes(source: string): string[] {
  return Array.from(source.matchAll(/new\s+AtmError\s*\(\s*["']([A-Z][A-Z0-9_]*)["']/gu))
    .map((match) => match[1]!)
    .filter((code) => !isAtmErrorCode(code));
}

describe("AtmError registry", () => {
  it("rejects unknown runtime codes instead of silently mapping them to 500", () => {
    expect(isAtmErrorCode("VERSION_CONFLICT")).toBe(true);
    expect(isAtmErrorCode("VERSION_CONFLCIT")).toBe(false);
    expect(() => new AtmError("VERSION_CONFLCIT" as AtmErrorCode)).toThrow(
      "Unknown ATM error code",
    );
  });

  it("keeps the registry and public union bound together", () => {
    expect(ERROR_POLICIES.INTERNAL_ERROR).toEqual({ httpStatus: 500, retryable: true });
    expect(ERROR_POLICIES.CANDIDATE_HASH_MISMATCH).toEqual({
      httpStatus: 422,
      retryable: false,
    });
    expect(ERROR_POLICIES.COMPLETION_GATE_FAILED).toEqual({
      httpStatus: 409,
      retryable: false,
    });
    expectTypeOf<keyof typeof ERROR_POLICIES>().toEqualTypeOf<AtmErrorCode>();
    expectTypeOf<ConstructorParameters<typeof AtmError>[0]>().toEqualTypeOf<AtmErrorCode>();
    expectTypeOf<ErrorDetailsByCode["INVALID_TRANSITION"]>().toMatchTypeOf<{
      current_status: string;
      requested_status: string;
    }>();
  });

  it("detects an unregistered production code in its positive control", () => {
    expect(unregisteredAtmErrorCodes('throw new AtmError("VERSION_CONFLCIT")')).toEqual([
      "VERSION_CONFLCIT",
    ]);
  });

  it("keeps every production AtmError literal in the runtime registry", () => {
    const roots = [
      "apps/daemon/src",
      "packages/application/src",
      "packages/client/src",
      "packages/domain/src",
      "packages/mcp/src",
      "packages/protocol/src",
      "packages/storage-sqlite/src",
    ].map((root) => resolve(process.cwd(), root));
    const findings = roots.flatMap((root) =>
      sourceFiles(root).flatMap((file) =>
        unregisteredAtmErrorCodes(readFileSync(file, "utf8")).map((code) => `${file}: ${code}`),
      ),
    );

    expect(findings).toEqual([]);
  });
});
