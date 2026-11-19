export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Standard {
  id: string;
  title: string;
  summary: string;
  guidance: string;
  severity: Severity;
  /** A team may record an exception only when this is true. */
  waivable: boolean;
}

export interface StandardSetting extends Standard {
  enabled: boolean;
}

export interface ExceptionRecord {
  id: string;
  standardId: string;
  path: string;
  reason: string;
  reviewId: string;
  createdAt: number;
}

export interface Finding {
  id: string;
  standardId: string;
  standardTitle: string;
  severity: Severity;
  path: string;
  line: number | null;
  /** Redacted, truncated text from the submitted change. Untrusted. */
  evidence: string;
  occurrences: number;
  waivable: boolean;
  status: "open" | "excepted";
  exceptionId: string | null;
}

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

export type StepName = "intake" | "rules" | "commentary" | "save";
export type StepStatus = "pending" | "running" | "complete" | "error";

export interface GuardState {
  /** Increments whenever stored data changes, so clients know to refetch. */
  revision: number;
  active: { reviewId: string; steps: Record<StepName, StepStatus> } | null;
  /** The durable question currently waiting for or receiving an answer. */
  activeQuestion: { submissionId: string } | null;
}

export type CommentarySource = "workers-ai" | "offline" | "unavailable";

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

export interface AiRouting {
  offline: boolean;
  gatewayId: string;
  models: { label: string; primary: string; secondary: string }[];
}

export interface Snapshot {
  repository: string;
  routing: AiRouting;
  standards: StandardSetting[];
  exceptions: ExceptionRecord[];
  reviews: ReviewRecord[];
  messages: ChatMessage[];
}

export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Messages broadcast to connected clients while commentary is generated. */
export type LiveMessage =
  | { type: "commentary-delta"; reviewId: string; delta: string }
  | { type: "commentary-reset"; reviewId: string }
  | { type: "answer-delta"; delta: string }
  | { type: "answer-reset" };
