/*
 * Data shapes shared by the Worker and the browser client. This file has no runtime exports, so the
 * client can import from it without pulling in server code.
 */
/** Where an answer came from. `guarded` is a fixed reply that used no model. */
export type AnswerSource = "workers-ai" | "offline" | "guarded" | "unavailable";

/** State synced to every client. Stored messages are fetched separately through `getSnapshot`. */
export interface ShowcaseState {
  /** Increments whenever stored data changes, so clients know to refetch. */
  revision: number;
  /** The durable question currently waiting for or receiving an answer. */
  activeQuestion: { submissionId: string } | null;
}

/** One visible conversation entry. */
export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  source: AnswerSource | null;
  createdAt: number;
}

/** Everything the page needs for one conversation. */
export interface Snapshot {
  offline: boolean;
  messages: ChatMessage[];
}

/** Result of a browser action. Expected failures are returned, not thrown. */
export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** One streamed part of a spoken answer, in playback order. The model is null in offline mode. */
export interface SpokenPart {
  index: number;
  audio: string;
  mimeType: string;
  source: "workers-ai" | "offline" | "deepgram" | "elevenlabs";
  model: string | null;
}

/** Messages broadcast to connected clients while an answer is generated. */
export type LiveMessage = { type: "answer-delta"; delta: string } | { type: "answer-reset" };
