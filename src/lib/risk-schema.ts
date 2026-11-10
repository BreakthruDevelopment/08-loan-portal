import { z } from "zod";
import { METRIC_NAMES } from "@/lib/risk-rules";

const METRIC = z.enum(METRIC_NAMES);

/**
 * What the model must return. Every field is bounded. `flag` is read as a bounded string (not an enum) so one
 * invented flag is dropped by the guardrails and logged, instead of one bad enum value wiping every concern.
 * The `catch([])` on each list means a malformed item set becomes empty rather than failing the whole answer.
 */
export const riskSummarySchema = z.object({
  summary: z.string().min(1).max(700),
  strengths: z.array(z.object({ text: z.string().max(200), evidence: z.array(METRIC).min(1).max(3) })).max(3).catch([]),
  concerns: z
    .array(z.object({ flag: z.string().max(40), text: z.string().max(240), evidence: z.array(METRIC).min(1).max(3) }))
    .max(5)
    .catch([]),
  questionsForApplicant: z.array(z.string().max(200)).max(3).catch([]),
});

export type RiskModelOutput = z.infer<typeof riskSummarySchema>;

/** What is stored and shown after the guardrails ran. Each concern's flag is one of the computed rule flags. */
export type RiskSummaryData = {
  summary: string;
  strengths: { text: string; evidence: string[] }[];
  concerns: { flag: string; text: string; evidence: string[] }[];
  questionsForApplicant: string[];
};

export type RiskSummaryMode = "live" | "demo" | "fallback";
