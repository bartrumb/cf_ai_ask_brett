/*
 * Data shapes shared by the Worker and the browser client. This file has one runtime export, so the
 * client can import from it without pulling in server code.
 */
/** Severities from lowest to highest. The order defines risk ranking. */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
/** One of `SEVERITIES`. */
export type Severity = (typeof SEVERITIES)[number];

/** One engineering standard from the catalog. */
export interface Standard {
  id: string;
  title: string;
  summary: string;
  guidance: string;
  severity: Severity;
  /** A team may record an exception only when this is true. */
  waivable: boolean;
}

/** A standard with its effective state for one repository. */
export interface StandardSetting extends Standard {
  enabled: boolean;
}

/** An accepted waiver for one standard on one exact path. */
export interface ExceptionRecord {
  id: string;
  standardId: string;
  path: string;
  reason: string;
  reviewId: string;
  createdAt: number;
  /** Verified Access email of the person who accepted it, when available. */
  createdBy?: string | null;
}

/** One standard matched on one path. `id` is unique only within its review. */
export interface Finding {
  id: string;
  standardId: string;
  standardTitle: string;
  severity: Severity;
  path: string;
  line: number | null;
  /** Redacted, truncated text from the submitted change. Untrusted. */
  evidence: string;
  /** Number of matches grouped into this finding. */
  occurrences: number;
  waivable: boolean;
  status: "open" | "excepted";
  exceptionId: string | null;
}

/** Complete rule-engine output for a change. It is final and never edited by the model. */
export interface RuleResult {
  kind: "diff" | "summary";
  /** Highest severity among open findings. Set only by the rule engine. */
  risk: Severity;
  /** Highest severity before accepted exceptions are applied. */
  riskBeforeExceptions: Severity;
  applicableStandards: string[];
  findings: Finding[];
  stats: { files: number; additions: number; deletions: number };
  notes: string[];
}

/** Review stages shown in the UI. */
export type StepName = "intake" | "rules" | "commentary" | "save";
/** State of one review stage. */
export type StepStatus = "pending" | "running" | "complete" | "error";

/** State synced to every client. Stored records are fetched separately through `getSnapshot`. */
export interface GuardState {
  /** Increments whenever stored data changes, so clients know to refetch. */
  revision: number;
  /** Progress of the running review, or null when none is running. */
  active: { reviewId: string; steps: Record<StepName, StepStatus> } | null;
  /** The durable question currently waiting for or receiving an answer. */
  activeQuestion: { submissionId: string } | null;
}

/** Origin of AI-related text. `unavailable` means the model call failed. */
export type CommentarySource = "workers-ai" | "offline" | "unavailable";

/** A stored review. `result` stays null until the rules step has saved it. */
export interface ReviewRecord {
  id: string;
  createdAt: number;
  status: "running" | "complete" | "failed";
  title: string;
  result: RuleResult | null;
  commentary: string;
  commentarySource: CommentarySource | null;
  commentaryModel: string | null;
  commentaryWarnings: string[];
  error: string | null;
}

/** One visible chat entry. `kind: "review"` entries anchor a review card in the timeline. */
export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  kind: "text" | "review";
  text: string;
  reviewId: string | null;
  source: CommentarySource | null;
  model: string | null;
  createdAt: number;
}

/** Model routing details displayed in the sidebar. */
export interface AiRouting {
  offline: boolean;
  gatewayId: string;
  models: { label: string; primary: string; secondary: string }[];
}

/** All stored data the UI needs for one repository. */
export interface Snapshot {
  repository: string;
  routing: AiRouting;
  standards: StandardSetting[];
  exceptions: ExceptionRecord[];
  reviews: ReviewRecord[];
  messages: ChatMessage[];
}

/** Result of a browser action. Expected failures are returned, not thrown. */
export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Messages broadcast to connected clients while commentary is generated. */
export type LiveMessage =
  | { type: "commentary-delta"; reviewId: string; delta: string }
  | { type: "commentary-reset"; reviewId: string }
  | { type: "answer-delta"; delta: string }
  | { type: "answer-reset" };
