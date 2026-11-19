/*
 * The catalog of engineering standards. Detection for each ID lives in `rules.ts`, and repository
 * settings are merged over this list by `CodexGuardAgent`.
 */
import type { Standard } from "./types";

/**
 * Invented sample standards for a fictional engineering team.
 *
 * Standards with `waivable: false` are mandatory: they cannot be disabled or given exceptions.
 */
export const SAMPLE_STANDARDS: readonly Standard[] = [
  {
    id: "STD-SEC-01",
    title: "No credentials in source",
    summary: "Passwords, tokens, API keys and private keys never enter the repository.",
    guidance: "Remove the value, rotate it, and read it from a managed secret at runtime.",
    severity: "critical",
    waivable: false,
  },
  {
    id: "STD-SEC-02",
    title: "No open network ingress",
    summary: "Infrastructure must not allow inbound traffic from the whole internet.",
    guidance: "Restrict the source range to a known network or place the service behind a gateway.",
    severity: "high",
    waivable: true,
  },
  {
    id: "STD-SEC-03",
    title: "Least-privilege permissions",
    summary: "Access policies name specific actions and resources, never wildcards.",
    guidance: "List only the actions and resource identifiers this workload needs.",
    severity: "high",
    waivable: true,
  },
  {
    id: "STD-DB-01",
    title: "Reversible schema changes",
    summary: "Destructive migrations need an expand-and-contract plan.",
    guidance: "Stop reads and writes first, back up the data, and drop in a later release.",
    severity: "high",
    waivable: true,
  },
  {
    id: "STD-REL-01",
    title: "CI gates stay on",
    summary: "Pipelines may not skip, disable or ignore required checks.",
    guidance: "Fix or quarantine the failing check with an owner, and keep the gate blocking.",
    severity: "high",
    waivable: true,
  },
  {
    id: "STD-REL-02",
    title: "Pinned deploy inputs",
    summary: "Images and pipeline actions use immutable versions.",
    guidance: "Pin to a digest or a full commit SHA, and let automation propose upgrades.",
    severity: "medium",
    waivable: true,
  },
  {
    id: "STD-TST-01",
    title: "Source changes include tests",
    summary: "A change to application code also changes a test.",
    guidance: "Add a test that fails without this change and passes with it.",
    severity: "medium",
    waivable: true,
  },
  {
    id: "STD-AGT-01",
    title: "No instructions to automated reviewers",
    summary: "Change content must not try to steer review tooling.",
    guidance: "Remove the text. Explain any real context in the pull request for human reviewers.",
    severity: "medium",
    waivable: false,
  },
  {
    id: "STD-OBS-01",
    title: "No stray debug output",
    summary: "Use the structured logger, not temporary print statements.",
    guidance: "Delete the statement or replace it with a leveled structured log.",
    severity: "low",
    waivable: true,
  },
  {
    id: "STD-SIZ-01",
    title: "Reviewable change size",
    summary: "Keep a single change under 400 modified lines.",
    guidance: "Split the work into smaller changes that can ship independently.",
    severity: "low",
    waivable: true,
  },
];

/** Looks up a standard by ID. Returns undefined for an unknown ID. */
export function findStandard(id: string): Standard | undefined {
  return SAMPLE_STANDARDS.find((standard) => standard.id === id);
}
