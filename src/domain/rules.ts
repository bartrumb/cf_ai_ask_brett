import { normalizeText, PREAMBLE_PATH, SUMMARY_PATH, type ChangeLine, type ParsedChange } from "./input";
import {
  SEVERITIES,
  type ExceptionRecord,
  type Finding,
  type RuleResult,
  type Severity,
  type StandardSetting,
} from "./types";

export const CHANGE_PATH = "(whole change)";
export const MAX_CHANGED_LINES = 400;
const MAX_REPORTED_FINDINGS = 50;
const MAX_EVIDENCE_CHARS = 160;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b[\w-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[\w-]*["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^\n]{0,40}\b(?:instructions?|rules?|prompts?|findings?|policy|policies|standards?)\b/i,
  /\bsystem prompt\b/i,
  /\b(?:ai|llm|automated|bot)[ -]reviewers?\b/i,
  /\b(?:mark|report|classify|treat|rate|score)\b[^\n]{0,40}\b(?:as|is)\s+(?:safe|approved|low[ -]risk|clean|harmless)\b/i,
  /\b(?:set|change|lower|report|override)\b[^\n]{0,20}\brisk(?: level)?\b[^\n]{0,20}\b(?:to|as|is)\b/i,
  /\bapprove\s+(?:this|the)\s+(?:change|diff|pr|pull request|review)\b/i,
  /\b(?:do not|don't|never)\s+(?:report|flag|mention)\b/i,
  /<\/?\s*(?:system|assistant|instructions?)\s*>/i,
];

const INFRA_FILE = /(\.tf|\.tfvars|\.ya?ml|\.json|\.toml|\.hcl)$/i;
const DEPLOY_FILE = /(^|\/)Dockerfile[^/]*$|\.ya?ml$|\.tf$/i;
const PIPELINE_FILE = /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci|(^|\/)ci\/|(^|\/)Makefile$|(^|\/)package\.json$|\.sh$/i;
const MIGRATION_FILE = /\.sql$|(^|\/)migrations?\//i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb)$/i;

const isSource = (path: string) => SOURCE_FILE.test(path) && !TEST_FILE.test(path);
const anyFile = () => true;

interface LineRule {
  standardId: string;
  appliesTo: (path: string) => boolean;
  patterns: readonly RegExp[];
  summaryPatterns: readonly RegExp[];
  /** Also scan unchanged context lines and any text before the first file. */
  scanContext?: boolean;
}

const LINE_RULES: readonly LineRule[] = [
  {
    standardId: "STD-SEC-01",
    appliesTo: anyFile,
    patterns: SECRET_PATTERNS,
    summaryPatterns: [
      ...SECRET_PATTERNS,
      /\bhard-?cod(?:e|es|ed|ing)\b[^\n]{0,30}\b(?:password|secret|token|api key|credential)/i,
    ],
  },
  {
    standardId: "STD-SEC-02",
    appliesTo: (path) => INFRA_FILE.test(path),
    patterns: [/\b0\.0\.0\.0\/0\b/, /(^|[\s"'[])::\/0\b/],
    summaryPatterns: [
      /\b0\.0\.0\.0\/0\b/,
      /\bopen(?:s|ing)?\b[^\n]{0,40}\bto the (?:internet|world)\b/i,
      /\bpublic(?:ly)? (?:ingress|accessible)\b/i,
    ],
  },
  {
    standardId: "STD-SEC-03",
    appliesTo: (path) => INFRA_FILE.test(path),
    patterns: [
      /["']?\b(?:actions?|resources?)\b["']?\s*[:=]\s*\[?\s*["']\*["']/i,
      /\bAdministratorAccess\b/,
    ],
    summaryPatterns: [/\bwildcard\b[^\n]{0,20}\b(?:iam|permissions?|polic(?:y|ies)|roles?)\b/i, /\badmin(?:istrator)? access\b/i],
  },
  {
    standardId: "STD-DB-01",
    appliesTo: (path) => MIGRATION_FILE.test(path),
    patterns: [/\bdrop\s+(?:table|column|database|schema)\b/i, /\btruncate\s+(?:table\s+)?\w+/i, /\balter\s+table\s+\S+\s+drop\b/i],
    summaryPatterns: [
      /\bdrop\s+(?:table|column|database|schema)\b/i,
      /\bdrop(?:s|ping)?\s+(?:[\w-]+\s+){0,4}(?:table|column|database)\b/i,
      /\btruncat(?:e|es|ing)\b[^\n]{0,20}\btable\b/i,
    ],
  },
  {
    standardId: "STD-REL-01",
    appliesTo: (path) => PIPELINE_FILE.test(path),
    patterns: [/\bcontinue-on-error:\s*true\b/i, /--no-verify\b/, /\bif:\s*false\b/, /--skip-tests?\b/, /-DskipTests\b/, /\|\|\s*true\b/],
    summaryPatterns: [/\bskip(?:s|ping)?\s+(?:[\w-]+\s+){0,3}(?:tests?|ci|checks?)\b/i, /\b(?:bypass|disabl)(?:e|es|ing)?\s+(?:[\w-]+\s+){0,3}(?:ci|checks?|gates?|review)\b/i],
  },
  {
    standardId: "STD-REL-02",
    appliesTo: (path) => DEPLOY_FILE.test(path),
    patterns: [/\bimage:\s*["']?\S+:latest\b/i, /^\s*FROM\s+\S+:latest\b/i, /\buses:\s*["']?\S+@(?:main|master|latest)\b/i],
    summaryPatterns: [/:latest\b/, /\bunpinned\b/i],
  },
  {
    standardId: "STD-OBS-01",
    appliesTo: isSource,
    patterns: [/\bconsole\.(?:log|debug)\(/, /^\s*debugger;?\s*$/, /^\s*print\(/, /\bfmt\.Println\(/],
    summaryPatterns: [/\bdebug (?:print|output|logging) (?:statements?|left)\b/i],
  },
  {
    standardId: "STD-AGT-01",
    appliesTo: anyFile,
    patterns: INJECTION_PATTERNS,
    summaryPatterns: INJECTION_PATTERNS,
    scanContext: true,
  },
];

export function containsInjectionLanguage(text: string): boolean {
  const normalized = normalizeText(text);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function redactSecrets(text: string): string {
  return text
    .replace(
      /(\b[\w-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[\w-]*["']?\s*[:=]\s*)(["'])[^"'\n]*\2/gi,
      "$1$2[REDACTED]$2",
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g, "Bearer [REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]");
}

function toEvidence(text: string): string {
  return redactSecrets(normalizeText(text)).trim().slice(0, MAX_EVIDENCE_CHARS);
}

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

function highestSeverity(findings: readonly Finding[]): Severity {
  return findings.reduce<Severity>(
    (highest, finding) => (severityRank(finding.severity) > severityRank(highest) ? finding.severity : highest),
    "low",
  );
}

export interface RuleContext {
  standards: readonly StandardSetting[];
  exceptions: readonly ExceptionRecord[];
}

type Draft = Omit<Finding, "id" | "status" | "exceptionId">;

/**
 * The only place a risk level is decided. It is pure and takes no model output,
 * so the same change, standards and exceptions always give the same result.
 */
export function evaluateChange(change: ParsedChange, context: RuleContext): RuleResult {
  const enabled = new Map(context.standards.filter((s) => s.enabled).map((s) => [s.id, s]));
  const isSummary = change.kind === "summary";
  const realFiles = change.files.filter((file) => file.path !== PREAMBLE_PATH);
  const drafts = new Map<string, Draft>();
  const applicable = new Set<string>();

  const record = (standardId: string, path: string, line: number | null, evidence: string) => {
    const standard = enabled.get(standardId);
    if (!standard) return;
    const key = `${standardId}|${path}`;
    const existing = drafts.get(key);
    if (existing) {
      existing.occurrences += 1;
      return;
    }
    drafts.set(key, {
      standardId,
      standardTitle: standard.title,
      severity: standard.severity,
      path,
      line,
      evidence: toEvidence(evidence),
      occurrences: 1,
      waivable: standard.waivable,
    });
  };

  for (const rule of LINE_RULES) {
    if (!enabled.has(rule.standardId)) continue;
    const patterns = isSummary ? rule.summaryPatterns : rule.patterns;
    for (const file of change.files) {
      const inScope = isSummary || file.path === PREAMBLE_PATH ? true : rule.appliesTo(file.path);
      if (!inScope) continue;
      if (file.path !== PREAMBLE_PATH) applicable.add(rule.standardId);
      const lines: ChangeLine[] = rule.scanContext ? [...file.additions, ...file.context] : file.additions;
      for (const { line, text } of lines) {
        const normalized = normalizeText(text);
        if (patterns.some((pattern) => pattern.test(normalized))) {
          record(rule.standardId, file.path, line, text);
        }
      }
    }
  }

  const additions = realFiles.reduce((sum, file) => sum + file.additions.length, 0);
  const deletions = realFiles.reduce((sum, file) => sum + file.deletions, 0);

  if (!isSummary) {
    if (enabled.has("STD-SIZ-01")) {
      applicable.add("STD-SIZ-01");
      const changed = additions + deletions;
      if (changed > MAX_CHANGED_LINES) {
        record("STD-SIZ-01", CHANGE_PATH, null, `${changed} changed lines`);
      }
    }
    const sourceFiles = realFiles.filter((file) => isSource(file.path) && file.additions.length > 0);
    if (enabled.has("STD-TST-01") && sourceFiles.length > 0) {
      applicable.add("STD-TST-01");
      if (!realFiles.some((file) => TEST_FILE.test(file.path))) {
        const names = sourceFiles.map((file) => file.path).slice(0, 3).join(", ");
        record("STD-TST-01", CHANGE_PATH, null, `Source changed without a test: ${names}`);
      }
    }
  }

  const exceptionFor = (draft: Draft) =>
    draft.waivable
      ? context.exceptions.find((e) => e.standardId === draft.standardId && e.path === draft.path)
      : undefined;

  const ordered = [...drafts.values()].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.standardId.localeCompare(b.standardId) ||
      a.path.localeCompare(b.path),
  );
  const findings: Finding[] = ordered.map((draft, index) => {
    const exception = exceptionFor(draft);
    return {
      ...draft,
      id: `F${index + 1}`,
      status: exception ? "excepted" : "open",
      exceptionId: exception?.id ?? null,
    };
  });

  const notes: string[] = [];
  if (isSummary) notes.push("Summary only: rules can check the wording, not the code. Paste a diff for a stronger check.");
  if (findings.length > MAX_REPORTED_FINDINGS) {
    notes.push(`Showing ${MAX_REPORTED_FINDINGS} of ${findings.length} findings. Risk counts all of them.`);
  }

  return {
    kind: change.kind,
    risk: highestSeverity(findings.filter((finding) => finding.status === "open")),
    riskBeforeExceptions: highestSeverity(findings),
    applicableStandards: [...applicable].sort(),
    findings: findings.slice(0, MAX_REPORTED_FINDINGS),
    stats: { files: isSummary ? 0 : realFiles.length, additions: isSummary ? 0 : additions, deletions },
    notes,
  };
}

export function describeChange(change: ParsedChange, text: string): string {
  if (change.kind === "summary") {
    const first = text.split("\n").find((line) => line.trim()) ?? "Change summary";
    return redactSecrets(normalizeText(first)).trim().slice(0, 90);
  }
  const paths = change.files.filter((file) => file.path !== PREAMBLE_PATH && file.path !== SUMMARY_PATH).map((file) => file.path);
  const shown = paths.slice(0, 2).join(", ");
  return paths.length > 2 ? `${shown} and ${paths.length - 2} more` : shown;
}

/** A bounded, redacted view of added lines that gives the model code context. */
export function buildExcerpt(change: ParsedChange, maxChars = 5_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const file of change.files) {
    for (const { line, text } of file.additions) {
      const entry = `${file.path}:${line}: ${redactSecrets(normalizeText(text)).slice(0, 200)}`;
      if (used + entry.length > maxChars) return parts.join("\n");
      parts.push(entry);
      used += entry.length + 1;
    }
  }
  return parts.join("\n");
}
