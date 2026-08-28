/**
 * The checked-in release checklist is a contract, not a release report.
 *
 * Candidate-specific facts belong in the reports emitted by the release
 * pipeline.  Keeping this guard independent lets version bumping, report
 * assembly, and tests apply exactly the same rule without teaching each
 * caller a slightly different regular expression.
 */

export const RELEASE_CHECKLIST_VIOLATION_CODES = [
  "MANUAL_CHECKMARK",
  "MANUAL_TEST_COUNT",
  "MANUAL_PERFORMANCE_NUMBER",
  "MANUAL_CANDIDATE_HASH",
  "VERSIONED_ACCEPTANCE_HEADING",
  "PENDING_ACCEPTANCE_RESULT",
] as const;

export type ReleaseChecklistViolationCode = (typeof RELEASE_CHECKLIST_VIOLATION_CODES)[number];

const MANUAL_CHECKMARK = /^\s*(?:[-*+]\s+|\d+[.)]\s+)\[[xX]\](?:\s|$)/mu;

// A number only counts as a forbidden release count when it is tied to a
// verification category.  This keeps ordinary prose such as "四层" and
// section numbering harmless while catching both Chinese and English forms:
// "单元/集成：999 项通过", "packaged smoke：33 项通过", and "999 tests passed".
const VERIFICATION_CATEGORY =
  /(?:单元(?:测试)?|集成(?:测试)?|单元\s*[\\/／+]\s*集成|测试|用例|烟测|smoke|e2e|test(?:s|ing)?|unit|integration|packaged|portable|installed|distribution|benchmark)/iu;
const COUNT_EXPRESSION =
  /(?:\b\d[\d,]*\s*(?:项|个|条|条目|用例)|\b\d[\d,]*\s*(?:tests?|cases?|checks?|items?)\b|\b\d[\d,]*\s*passed\b|(?:通过|passed)\s*[:：]?\s*\d[\d,]*)/iu;

// Performance figures need a unit or an explicit comparison.  A bare year,
// version, or list number must not turn a rule-only checklist into a false
// positive.  The benchmark keyword is included because benchmark output is a
// performance fact even when the prose does not say “性能”.
const PERFORMANCE_NUMBER =
  /(?:性能|performance|benchmark|p(?:50|75|90|95|99)|rss|内存|耗时|延迟|吞吐|启动(?:时间|耗时)?|响应(?:时间|耗时)?|帧率|memory|latency|throughput|startup|response)[^\n|]{0,80}?(?:(?:<=|>=|<|>|≤|≥|=)\s*)?\b\d+(?:\.\d+)?\s*(?:ms|毫秒|s|秒|m|min|分钟|kb|kib|mb|mib|gb|gib|fps|帧|%|req\s*\/\s*s)(?![a-z0-9_])/iu;

const PERFORMANCE_COMPARISON =
  /(?:性能|performance|p(?:50|75|90|95|99)|rss|内存|耗时|延迟|吞吐|memory|latency|throughput|startup|response|benchmark)[^\n|]{0,80}(?:<=|>=|<|>|≤|≥)\s*\d+(?:\.\d+)?/iu;

// Release hashes are only forbidden when a candidate/hash identity label is
// followed by a hex digest.  The label-free SHA-256 algorithm name and normal
// documentation links therefore remain valid.
const CANDIDATE_HASH =
  /(?:候选(?:\s*(?:fingerprint|hash|哈希))?|candidate(?:\s*(?:fingerprint|hash))?|fingerprint|哈希|hash|git\s+head|head|source(?:\s+hash)?|lockfile(?:\s+hash)?|setup(?:\s+(?:hash|sha-?256))?|sha-?256)[^\n|:：]{0,48}[:：]?\s*[a-f0-9]{7,}/iu;

const VERSION = String.raw`(?:v)?\d+\.\d+\.\d+`;
const ACCEPTANCE = String.raw`(?:验收(?:结果|清单)?|发布验收|acceptance(?:\s+results?)?|release\s+verification)`;
const VERSIONED_ACCEPTANCE_HEADING = new RegExp(
  String.raw`^#{1,6}\s+(?:(?:${VERSION})[^\n]{0,40}${ACCEPTANCE}|${ACCEPTANCE}[^\n]{0,40}(?:${VERSION}))\s*[：:：-]?\s*$`,
  "imu",
);

const PENDING_ACCEPTANCE_RESULT =
  /(?:本轮|本次|当前|此次)?(?:尚未完成|未完成)[^\n]{0,48}(?:结果|验收|发布)?[^\n]{0,16}(?:待填|未填|pending|tbd)|(?:验收|发布|测试)?(?:结果|状态)[^\n]{0,16}(?:待填|未填|pending|tbd)|(?:^|\n)\s*(?:待填|pending|tbd)\s*(?:$|\n|[。.！!])/imu;

function hasVerificationCount(line: string): boolean {
  return VERIFICATION_CATEGORY.test(line) && COUNT_EXPRESSION.test(line);
}

/**
 * Return stable machine-readable violations in source order.  A category is
 * reported at most once even if a malformed line contains several examples.
 */
export function releaseChecklistViolations(checklist: string): ReleaseChecklistViolationCode[] {
  const violations: ReleaseChecklistViolationCode[] = [];
  const add = (code: ReleaseChecklistViolationCode, present: boolean) => {
    if (present && !violations.includes(code)) violations.push(code);
  };

  add("MANUAL_CHECKMARK", MANUAL_CHECKMARK.test(checklist));
  add(
    "MANUAL_TEST_COUNT",
    checklist.split(/\r?\n/u).some((line) => hasVerificationCount(line)),
  );
  add(
    "MANUAL_PERFORMANCE_NUMBER",
    PERFORMANCE_NUMBER.test(checklist) || PERFORMANCE_COMPARISON.test(checklist),
  );
  add("MANUAL_CANDIDATE_HASH", CANDIDATE_HASH.test(checklist));
  add("VERSIONED_ACCEPTANCE_HEADING", VERSIONED_ACCEPTANCE_HEADING.test(checklist));
  add("PENDING_ACCEPTANCE_RESULT", PENDING_ACCEPTANCE_RESULT.test(checklist));

  return violations;
}

/**
 * Assert that a checked-in checklist contains only stable rules and evidence
 * entry points.  The caller should pass the file contents, not a filesystem
 * path; this makes the same contract usable by release assembly and tests.
 */
export function assertReleaseChecklistIsDynamic(checklist: string): void {
  const violations = releaseChecklistViolations(checklist);
  if (violations.length > 0) {
    throw new Error(`RELEASE_CHECKLIST_STATIC_EVIDENCE_NOT_ALLOWED: ${violations.join(",")}`);
  }
}
