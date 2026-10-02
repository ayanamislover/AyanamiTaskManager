// PUT 体解析：原文切片、紧凑化、类型校验。
import { describe, expect, it } from "vitest";
import { RelayError } from "../src/errors.js";
import { compactJson, parsePutBody } from "../src/request-body.js";

const parse = (text: string) => parsePutBody(Buffer.from(text, "utf8"));

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RelayError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "ok";
}

describe("parsePutBody", () => {
  it("切出 data 原文，保留数值字面量与字符串里的空白", () => {
    const body = parse(
      '{ "expected_revision" : 3 , "data" : { "n" : 1.50 , "s" : "a  b\\" }" } , "schema_version":2 }',
    );
    expect(body.expectedRevision).toBe(3);
    expect(body.schemaVersion).toBe(2);
    expect(body.dataRaw).toBe('{ "n" : 1.50 , "s" : "a  b\\" }" }');
    expect(compactJson(body.dataRaw!)).toBe('{"n":1.50,"s":"a  b\\" }"}');
  });

  it("data 可以是任何 JSON 值，包括 null；缺省时为 null", () => {
    expect(parse('{"expected_revision":0,"data":null}').dataRaw).toBe("null");
    expect(parse('{"expected_revision":0,"data":"x"}').dataRaw).toBe('"x"');
    expect(parse('{"expected_revision":0,"data":[1,[2,{"a":[]}]]}').dataRaw).toBe(
      '[1,[2,{"a":[]}]]',
    );
    expect(parse('{"expected_revision":0}').dataRaw).toBeNull();
    expect(parse("null").expectedRevision).toBeNull();
  });

  it("读不懂的体是 400 BAD_REQUEST", () => {
    expect(codeOf(() => parse(""))).toBe("400 BAD_REQUEST");
    expect(codeOf(() => parse("   "))).toBe("400 BAD_REQUEST");
    expect(codeOf(() => parse("{"))).toBe("400 BAD_REQUEST");
    expect(codeOf(() => parse("[]"))).toBe("400 BAD_REQUEST");
    expect(codeOf(() => parse('"str"'))).toBe("400 BAD_REQUEST");
    expect(codeOf(() => parse('{"expected_revision":1.0,"data":1}'))).toBe("400 BAD_REQUEST");
    expect(codeOf(() => parse('{"expected_revision":1e2,"data":1}'))).toBe("400 BAD_REQUEST");
    expect(codeOf(() => parse('{"expected_revision":99999999999999999999,"data":1}'))).toBe(
      "400 BAD_REQUEST",
    );
    expect(codeOf(() => parse('{"expected_revision":0,"data":1,"keep_candidate":"yes"}'))).toBe(
      "400 BAD_REQUEST",
    );
    expect(codeOf(() => parsePutBody(Buffer.from([0xff, 0xfe])))).toBe("400 BAD_REQUEST");
  });

  it("嵌套超过 10000 层拒绝，未超过的照收", () => {
    const deep = (n: number) => `{"expected_revision":0,"data":${"[".repeat(n)}${"]".repeat(n)}}`;
    expect(codeOf(() => parse(deep(10_001)))).toBe("400 BAD_REQUEST");
    expect(parse(deep(9_000)).dataRaw).toHaveLength(18_000);
  });
});

describe("compactJson", () => {
  it("去掉字符串之外的空白；已紧凑的原样返回同一个字符串", () => {
    expect(compactJson(' [ 1 ,\n\t2 , "x y" ] ')).toBe('[1,2,"x y"]');
    const already = '{"a":[1,2]}';
    expect(compactJson(already)).toBe(already);
    expect(compactJson('"\\\\" ')).toBe('"\\\\"');
  });
});
