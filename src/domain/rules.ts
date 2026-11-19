/*
 * The deterministic rule engine and secret redaction. Given a parsed change, the enabled standards
 * and recorded exceptions, it produces every finding and the risk level. It has no I/O and never
 * receives model output. Add a standard in `standards.ts` and its detection here.
 */
import { CHANGE_PATH, normalizeText, PREAMBLE_PATH, SUMMARY_PATH, type ChangeLine, type ParsedChange } from "./input";
import {
  SEVERITIES,
  type ExceptionRecord,
  type Finding,
  type RuleResult,
  type Severity,
  type StandardSetting,
} from "./types";

export { CHANGE_PATH };
/** STD-SIZ-01 fires at this many added plus removed lines. */
export const MAX_CHANGED_LINES = 400;
/** Findings kept in a result. Risk is calculated before this cap applies. */
const MAX_REPORTED_FINDINGS = 50;
/** Longest evidence snippet stored with a finding. */
const MAX_EVIDENCE_CHARS = 160;

/** A credential-like name followed by an assignment operator. Quantifiers are bounded. */
const SECRET_NAME = String.raw`\b[\w-]{0,40}(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[\w-]{0,40}["']?\s{0,5}(?::=|=>|[:=])\s{0,5}`;
/** A quoted value, excluding template placeholders. */
const QUOTED_SECRET = String.raw`(["'])(?!\$\{|\{\{|<)(?:(?!\2).){8,400}?\2`;
/** An unquoted value with a digit or symbol, which avoids matching ordinary identifiers. */
const UNQUOTED_SECRET = String.raw`(?=[^\s"',;]{0,200}[\d!@#%^&*+/=~-])[^\s"',;()$<>{}.[\]]{8,200}(?=$|[\s,;])`;
/** Named assignments. Group 1 is the name and operator, and group 2 is any opening quote. */
const SECRET_ASSIGNMENT = String.raw`(${SECRET_NAME})(?:${QUOTED_SECRET}|${UNQUOTED_SECRET})`;
/** Credentials recognizable by format alone. */
const SECRET_TOKENS = [
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{20,255}\b`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,255}\b`,
  String.raw`\bsk-[A-Za-z0-9_-]{16,255}\b`,
  String.raw`\bxox[abeoprs]-[A-Za-z0-9-]{10,255}\b`,
  String.raw`\beyJ[\w-]{8,1000}\.eyJ[\w-]{8,1000}\.[\w-]{8,1000}`,
];
/** An HTTP bearer credential. */
const BEARER_TOKEN = String.raw`\bBearer\s{1,5}[A-Za-z0-9._~+/-]{20,1000}`;
/** A password in a URL. Group 1 is the scheme and user, and group 2 precedes the host. */
const URL_CREDENTIAL = String.raw`(\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@]{1,100}:)[^\s/@]{1,200}(@)`;
/** First line of a private key block. */
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/;
/** Last line of a private key block. */
const PRIVATE_KEY_END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/;

/** Detection for STD-SEC-01. It shares its sources with `redactSecrets`. */
const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(SECRET_ASSIGNMENT, "i"),
  ...SECRET_TOKENS.map((source) => new RegExp(source)),
  new RegExp(BEARER_TOKEN),
  new RegExp(URL_CREDENTIAL, "i"),
  PRIVATE_KEY_BEGIN,
];

/** Language aimed at automated reviewers, for STD-AGT-01 and gateway metadata. */
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

/** Files that may define network or permission settings. */
const INFRA_FILE = /(\.tf|\.tfvars|\.ya?ml|\.json|\.toml|\.hcl)$/i;
/** Files that may reference deployable images or pipeline actions. */
const DEPLOY_FILE = /(^|\/)Dockerfile[^/]*$|\.ya?ml$|\.tf$/i;
/** Files that may control CI behavior. */
const PIPELINE_FILE = /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci|(^|\/)ci\/|(^|\/)Makefile$|(^|\/)package\.json$|\.sh$/i;
/** Database migration files. */
const MIGRATION_FILE = /\.sql$|(^|\/)migrations?\//i;
/** Test files, by directory or naming convention. */
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i;
/** Application source extensions. Test files are excluded by `isSource`. */
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb)$/i;

/** True for application source that is not a test. */
const isSource = (path: string) => SOURCE_FILE.test(path) && !TEST_FILE.test(path);
/** Scope for rules that apply to every file. */
const anyFile = () => true;

/** Line-by-line detection for one standard. */
interface LineRule {
  standardId: string;
  /** Limits the rule by file path. Ignored for summaries and preamble text. */
  appliesTo: (path: string) => boolean;
  /** Patterns for diff lines. They must not use the `g` flag, because `test` would keep state. */
  patterns: readonly RegExp[];
  /** Patterns for plain-language summaries, which describe a change instead of showing it. */
  summaryPatterns: readonly RegExp[];
  /** Also scan unchanged context lines and any text before the first file. */
  scanContext?: boolean;
  /** Also scan the submitted file path, which the author fully controls. */
  scanPath?: boolean;
}

/** Rules evaluated in `evaluateChange`. STD-SIZ-01 and STD-TST-01 are whole-change checks there. */
const LINE_RULES: readonly LineRule[] = [
  {
    standardId: "STD-SEC-01",
    appliesTo: anyFile,
    patterns: SECRET_PATTERNS,
    summaryPatterns: [
      ...SECRET_PATTERNS,
      /\bhard-?cod(?:e|es|ed|ing)\b[^\n]{0,30}\b(?:password|secret|token|api key|credential)/i,
    ],
    scanPath: true,
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
    scanPath: true,
  },
];

/** Tests normalized text for reviewer-directed language. Used to tag gateway requests. */
export function containsInjectionLanguage(text: string): boolean {
  const normalized = normalizeText(text);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Masks credential-like values before text is stored, displayed or sent to a model. It uses the
 * same pattern sources as detection. A private key is masked from its BEGIN marker through its END
 * marker when both are in the supplied text.
 */
export function redactSecrets(text: string): string {
  let redacted = text.replace(new RegExp(SECRET_ASSIGNMENT, "gi"), (_match, name: string, quote?: string) =>
    quote ? `${name}${quote}[REDACTED]${quote}` : `${name}[REDACTED]`,
  );
  for (const source of SECRET_TOKENS) redacted = redacted.replace(new RegExp(source, "g"), "[REDACTED]");
  return redacted
    .replace(new RegExp(BEARER_TOKEN, "g"), "Bearer [REDACTED]")
    .replace(new RegExp(URL_CREDENTIAL, "gi"), "$1[REDACTED]$2")
    .replace(/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]");
}

/** Characters held back so a secret split across stream chunks can still be masked. */
const STREAM_HOLDBACK_CHARS = 240;

/** Incrementally redacts model text before it is shown live. */
export interface StreamRedactor {
  /** Adds a chunk and returns text that is safe to release now. */
  push(delta: string): string;
  /** Returns the remaining text at the end of the stream. */
  finish(): string;
}

/** Creates a redactor that releases text only at whitespace behind the holdback window. */
export function createStreamRedactor(): StreamRedactor {
  let pending = "";
  return {
    push(delta) {
      pending += delta;
      const limit = pending.length - STREAM_HOLDBACK_CHARS;
      const boundary = limit > 0 ? pending.lastIndexOf(" ", limit) : -1;
      if (boundary < 0) return "";
      const ready = pending.slice(0, boundary + 1);
      pending = pending.slice(boundary + 1);
      return redactSecrets(ready);
    },
    finish() {
      const rest = redactSecrets(pending);
      pending = "";
      return rest;
    },
  };
}

/** Produces the redacted, bounded snippet stored on a finding. */
function toEvidence(text: string): string {
  return redactSecrets(normalizeText(text)).trim().slice(0, MAX_EVIDENCE_CHARS);
}

/** Returns a severity's position, where a larger number is more severe. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** Returns the highest severity present. With no findings the result is `low`. */
function highestSeverity(findings: readonly Finding[]): Severity {
  return findings.reduce<Severity>(
    (highest, finding) => (severityRank(finding.severity) > severityRank(highest) ? finding.severity : highest),
    "low",
  );
}

/** Repository settings that affect one evaluation. */
export interface RuleContext {
  standards: readonly StandardSetting[];
  exceptions: readonly ExceptionRecord[];
}

/** A finding before IDs and exception status are assigned. */
type Draft = Omit<Finding, "id" | "status" | "exceptionId">;

/**
 * The only place a risk level is decided. It is pure and takes no model output,
 * so the same change, standards and exceptions always give the same result.
 *
 * Matches are grouped into one finding per standard and path, the same scope as an exception.
 * Evidence and line number come from the first match.
 *
 * @param change - Output of `parseChange`.
 * @param context - Standards with their enabled state, plus recorded exceptions.
 */
export function evaluateChange(change: ParsedChange, context: RuleContext): RuleResult {
  const enabled = new Map(context.standards.filter((s) => s.enabled).map((s) => [s.id, s]));
  const isSummary = change.kind === "summary";
  const realFiles = change.files.filter((file) => file.path !== PREAMBLE_PATH);
  const drafts = new Map<string, Draft>();
  const applicable = new Set<string>();

  const record = (standardId: string, rawPath: string, line: number | null, evidence: string) => {
    const standard = enabled.get(standardId);
    if (!standard) return;
    const path = redactSecrets(rawPath);
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
      // Summaries and preambles have no meaningful path, so path scoping cannot apply to them.
      const inScope = isSummary || file.path === PREAMBLE_PATH ? true : rule.appliesTo(file.path);
      if (!inScope) continue;
      // A preamble alone does not make a standard count as checked.
      if (file.path !== PREAMBLE_PATH) applicable.add(rule.standardId);
      const lines: ChangeLine[] = rule.scanContext ? [...file.additions, ...file.context] : file.additions;
      for (const { line, text } of lines) {
        // Match the normalized form so invisible characters cannot split a keyword.
        const normalized = normalizeText(text);
        if (patterns.some((pattern) => pattern.test(normalized))) {
          record(rule.standardId, file.path, line, text);
        }
      }
      if (rule.scanPath && file.path !== PREAMBLE_PATH && file.path !== SUMMARY_PATH) {
        const path = normalizeText(file.path);
        if (rule.patterns.some((pattern) => pattern.test(path))) record(rule.standardId, file.path, null, file.path);
      }
    }
  }

  const additions = realFiles.reduce((sum, file) => sum + file.additions.length, 0);
  const deletions = realFiles.reduce((sum, file) => sum + file.deletions, 0);

  // Size and test coverage cannot be judged from a description.
  if (!isSummary) {
    if (enabled.has("STD-SIZ-01")) {
      applicable.add("STD-SIZ-01");
      const changed = additions + deletions;
      if (changed >= MAX_CHANGED_LINES) {
        record("STD-SIZ-01", CHANGE_PATH, null, `${changed} changed lines`);
      }
    }
    const sourceFiles = realFiles.filter((file) => isSource(file.path) && file.additions.length > 0);
    if (enabled.has("STD-TST-01") && sourceFiles.length > 0) {
      applicable.add("STD-TST-01");
      if (!realFiles.some((file) => TEST_FILE.test(file.path))) {
        const names = sourceFiles.map((file) => redactSecrets(file.path)).slice(0, 3).join(", ");
        record("STD-TST-01", CHANGE_PATH, null, `Source changed without a test: ${names}`);
      }
    }
  }

  // Stored exceptions are ignored for standards that cannot be waived.
  const exceptionFor = (draft: Draft) =>
    draft.waivable
      ? context.exceptions.find((e) => e.standardId === draft.standardId && e.path === draft.path)
      : undefined;

  // A total order keeps finding IDs stable for identical input.
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

/**
 * Builds the short review title: the first summary line, or up to two changed paths.
 * All submitted text is redacted.
 */
export function describeChange(change: ParsedChange, text: string): string {
  if (change.kind === "summary") {
    const first = text.split("\n").find((line) => line.trim()) ?? "Change summary";
    return redactSecrets(normalizeText(first)).trim().slice(0, 90);
  }
  const paths = change.files.filter((file) => file.path !== PREAMBLE_PATH && file.path !== SUMMARY_PATH).map((file) => redactSecrets(file.path));
  const shown = paths.slice(0, 2).join(", ");
  return paths.length > 2 ? `${shown} and ${paths.length - 2} more` : shown;
}

/**
 * A bounded view of added lines that gives the model code context. Paths and lines are redacted,
 * and everything from a private key's BEGIN marker through its END marker is replaced. Output stops
 * at the first entry that would exceed the limit.
 *
 * @param maxChars - Approximate limit on the returned text.
 */
export function buildExcerpt(change: ParsedChange, maxChars = 5_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const file of change.files) {
    const path = redactSecrets(file.path);
    let insidePrivateKey = false;
    for (const { line, text } of file.additions) {
      const normalized = normalizeText(text);
      if (insidePrivateKey) {
        insidePrivateKey = !PRIVATE_KEY_END.test(normalized);
        continue;
      }
      let content = redactSecrets(normalized).slice(0, 200);
      if (PRIVATE_KEY_BEGIN.test(normalized)) {
        insidePrivateKey = !PRIVATE_KEY_END.test(normalized);
        content = "[REDACTED PRIVATE KEY]";
      }
      const entry = `${path}:${line}: ${content}`;
      if (used + entry.length > maxChars) return parts.join("\n");
      parts.push(entry);
      used += entry.length + 1;
    }
  }
  return parts.join("\n");
}
