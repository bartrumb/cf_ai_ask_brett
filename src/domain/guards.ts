/*
 * Deterministic topic guards. A matching question gets a fixed answer and never reaches a model, so
 * these boundaries do not depend on model behavior. Patterns describe broad categories on purpose:
 * they say what a visitor may be asking, and nothing about what the profile does or does not contain.
 */
import { normalizeText } from "./redaction";

/** Topics answered with fixed text. */
export type GuardCategory = "instructions" | "compensation" | "financials" | "contact" | "personal" | "job-search" | "government";

/** Public contact details used in fixed answers. */
export interface GuardProfile {
  name: string;
  links: { email: string; site: string };
}

/** A person reference in questions, such as "he" or "the candidate". */
const PERSON = String.raw`(?:he|him|his|she|her|they|brett|bartrum|avery|the candidate)`;

/** Checked in order. Instruction attacks come first, so they cannot pose as another topic. */
const GUARD_PATTERNS: readonly (readonly [GuardCategory, readonly RegExp[]])[] = [
  [
    "instructions",
    [
      /\b(?:ignore|disregard|forget|override|bypass|skip)\b.{0,50}\b(?:instructions?|rules?|prompts?|guidelines?|polic(?:y|ies)|directions?|guardrails?|restrictions?)\b/,
      /\b(?:system|initial|hidden|developer|original|secret|pre-?)\s?(?:prompt|message|instructions?)\b/,
      /\byour\s+(?:\w+\s+)?(?:prompt|instructions?|rules?|guidelines?|knowledge base|configuration|restrictions?)\b/,
      /\b(?:what|which)\s+(?:were|are|was)\s+you\s+(?:told|instructed|given|forbidden|not allowed)\b/,
      /\b(?:not allowed|forbidden|refuse|banned)\b.{0,30}\b(?:topics?|subjects?|to (?:say|discuss|talk))\b/,
      /\byou\s+are\s+now\b|\bjailbreak\w*\b|\b(?:developer|god|dan)\s+mode\b|\bdo anything now\b|\bnew instructions\b/,
      /^\W*(?:please\s+)?(?:act as|pretend|roleplay|role-play)\b|\byou\s+(?:must|should|will|can)\s+(?:now\s+)?(?:act|pretend|behave)\b/,
      /<\/?\s*(?:untrusted|system|instructions?)/,
      /\b(?:repeat|print|output|dump|reveal|show|quote|copy|recite)\b.{0,40}\b(?:verbatim|word for word|everything (?:above|before)|(?:all )?(?:the )?text (?:above|before)|profile facts|system context|your context)\b/,
    ],
  ],
  [
    "compensation",
    [
      /\bsalar(?:y|ies)\b|\bcompensation\b|\btotal comp\b|\bcomp (?:range|expectations?|target|package)\b/,
      /\b(?:pay|wage|rate) (?:range|target|history|expectations?|band|requirements?)\b|\b(?:base|desired|current|expected) (?:pay|wage)\b/,
      /\btake[- ]?home\b|\b(?:yearly|annual|monthly) (?:pay|income|earnings)\b/,
      /\bhourly rate\b|\bw-?2 rate\b|\bpaycheck\b|\b(?:signing|sign-on|annual) bonus\b|\bstock options\b|\brsus?\b/,
      new RegExp(String.raw`\bhow much\b.{0,30}\b${PERSON}\b.{0,30}\b(?:make|makes|earn|earns|paid|charge|charges|want|wants|expect|expects|cost|costs)\b`),
      new RegExp(String.raw`\b(?:what|how much)\b.{0,20}\b(?:does|did|would|will|is)\s+${PERSON}\s+(?:earn|make|get paid|being paid)\b`),
    ],
  ],
  [
    "financials",
    [
      /\brevenue\b|\bannual recurring\b|\barr\b|\bprofit\b|\bvaluation\b/,
      /\b(?:ai|claude|cloud|azure|model|vendor|company|employer)\s+(?:spend|spending|budget|bill|costs?)\b/,
      /\bhow much\b.{0,50}\b(?:spend|spends|spent|saved|save|saves|recovered?|overbill\w*|budget)\b/,
      /\bvendor pric\w+\b|\bdealer cost\b|\bwholesale\b/,
    ],
  ],
  [
    "contact",
    [
      /\b(?:phone|cell|mobile|telephone)\s*(?:number|no\b|#)/,
      new RegExp(String.raw`\b${PERSON}(?:'s)?\s+(?:phone|cell|mobile|whatsapp|home address|street address|address)\b`),
      new RegExp(String.raw`\b(?:call|text|sms)\s+${PERSON}\b`),
      /\bhome address\b|\bstreet address\b|\bwhatsapp\b|\b(?:personal|private)\s+(?:e-?mail|contact|number|address)\b/,
    ],
  ],
  [
    "personal",
    [
      /\bmental health\b|\bmedical\b|\billness(?:es)?\b|\bdisabilit(?:y|ies)\b|\bmedications?\b|\bsurgery\b|\bpregnan\w+\b|\btherap(?:y|ist)\b|\bdiagnosed with\b/,
      /\b(?:sick|personal|family|parental|maternity|paternity)\s+leave\b/,
      new RegExp(String.raw`\b${PERSON}(?:'s)?\s+(?:health|age|religion|politics|birthday|marriage)\b`),
      new RegExp(String.raw`\bis\s+${PERSON}\s+(?:sick|healthy|ill|married|divorced|single)\b`),
      /\b(?:wife|husband|spouse|girlfriend|boyfriend|kids?|children|daughters?|sons?|mother|father|mom|dad|parents|siblings?)\b/,
      new RegExp(String.raw`\b${PERSON}(?:'s)?\s+famil(?:y|ies)\b|\bfamily (?:life|members?|situation|status)\b`),
      /\bhow old\b|\bdate of birth\b|\breligio(?:n|us)\b|\bpolitical (?:views?|party)\b/,
    ],
  ],
  [
    "job-search",
    [
      /\b(?:who|which|what)\b.{0,40}\b(?:compan(?:y|ies)|employers?|firms?|recruiters?|teams?)\b.{0,40}\b(?:talking|speaking|interview\w*|appl(?:y|ied|ying)|offers?|considering|in talks|pursuing)\b/,
      /\b(?:other|competing|pending|current)\s+(?:offers?|interviews?)\b|\bany\s+(?:\w+\s+)?(?:offers?|interviews?)\b/,
      new RegExp(String.raw`\b(?:is|has|was)\s+${PERSON}\s+(?:been\s+)?(?:interviewing|applied|applying|talking to|speaking (?:to|with)|in talks|received|got)\b`),
      new RegExp(String.raw`\bwhere\s+(?:is|has|did)\s+${PERSON}\s+(?:been\s+)?(?:appl\w+|interview\w*)\b`),
      new RegExp(String.raw`\bwhy\b.{0,20}\b${PERSON}\b.{0,20}\b(?:leav\w+|quit\w*|looking)\b`),
      /\b(?:unhappy|dislikes?|hates?|frustrated|fired|laid off)\b.{0,30}\b(?:at|with|about|from|job|employer|company|manager|boss)\b/,
      /\b(?:bad|negative|worst|complain\w*)\b.{0,30}\b(?:employer|manager|boss|company)\b/,
    ],
  ],
  [
    "government",
    [
      /\bmilitary\b|\barmed (?:forces|services)\b|\b(?:air|space)\s+force\b|\bthe army\b|\bu\.?s\.? army\b|\bnavy\b|\bmarine corps\b|\bcoast guard\b|\bnational guard\b/,
      /\bpentagon\b|\bd[o0]d\b|\bdepartment of (?:defen[cs]e|war)\b|\bveterans?\b/,
      /\bdefen[cs]e\s+(?:work|contract\w*|industry|sector|clients?|customers?|projects?|department)\b/,
      /\bgovernment\b|\bfederal\b|\bpublic sector\b/,
      /\b(?:security )?clearances?\b|\bclassified (?:work|projects?|programs?|information|systems?)\b|\btop secret\b|\bts\/sci\b|\bcia\b|\bnsa\b/,
    ],
  ],
];

/** Character swaps folded before matching: digits and symbols, and Cyrillic letters that look Latin. */
const LOOKALIKES: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", $: "s", "@": "a", "5": "s",
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ѕ: "s", ј: "j", ӏ: "l", к: "k", м: "m", т: "t", н: "h", в: "b",
};

/** Folds common character swaps, so "s4lary"-style and look-alike spellings reach the same patterns. */
function unmask(text: string): string {
  return text.replace(/[0134$@5а-яіѕјӏ]/g, (character) => LOOKALIKES[character] ?? character);
}

/** Joins letters spaced one apart, so "s a l a r y" reads as "salary". */
function joinSpacedLetters(text: string): string {
  return text.replace(/\b([a-z]) (?=[a-z]\b)/g, "$1");
}

/**
 * Finds the guarded topic of a question.
 *
 * @returns The first matching category, or null for an ordinary question.
 */
export function classifyQuestion(question: string): GuardCategory | null {
  const plain = normalizeText(question).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const folded = unmask(plain);
  const forms = [plain, folded, joinSpacedLetters(folded)];
  for (const [category, patterns] of GUARD_PATTERNS) {
    if (patterns.some((pattern) => forms.some((form) => pattern.test(form)))) return category;
  }
  return null;
}

/** Returns the fixed reply for a guarded topic. */
export function guardedAnswer(category: GuardCategory, profile: GuardProfile): string {
  const first = profile.name.split(" ")[0] ?? profile.name;
  const { email, site } = profile.links;
  const answers: Record<GuardCategory, string> = {
    instructions: `I can't share or change how I work, but I'm glad to talk about ${first}'s projects, results and experience. What would you like to know?`,
    compensation: `${first} is happy to discuss compensation directly. You can reach out at ${email}.`,
    financials: `I don't share company financials or pricing details. I can explain what ${first} built and how the results were measured, or you can ask directly at ${email}.`,
    contact: `The best way to reach ${first} is ${email}. More public contact options are at ${site}.`,
    personal: `I keep to ${first}'s professional work here. I'm happy to talk about projects, skills or how ${first} approaches engineering.`,
    "job-search": `I can tell you the kinds of roles ${first} is seeking, but not details of any search. For anything more, please write to ${email}.`,
    government: `I don't discuss that area here. I'm happy to cover the work on this site, and you can ask ${first} directly at ${email}.`,
  };
  return answers[category];
}
