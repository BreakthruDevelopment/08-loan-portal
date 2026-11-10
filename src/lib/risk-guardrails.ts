/**
 * Code-level guardrails on the model's answer. Pure functions, tested in risk-guardrails.test.ts.
 * The model explains the rule flags; it never decides, never brings in protected characteristics,
 * never invents a flag, and never states a number the rules didn't compute.
 */
import { FLAG_METRICS, type FlagCode, type MetricName, type RiskAssessment, type RuleFlag } from "@/lib/risk-rules";
import type { RiskModelOutput, RiskSummaryData } from "@/lib/risk-schema";

export type GuardrailCode =
  | "decision_language"
  | "protected_characteristic"
  | "number_mismatch"
  | "unknown_flag"
  | "duplicate_flag"
  | "evidence_corrected"
  | "strength_contradicts_flag";

/** Words that make or hint at a credit decision. Matched case-insensitively. */
export const DECISION_PATTERNS: readonly RegExp[] = [
  /\bapprov\w*/i,
  /\bden(y|ies|ied|ying|ial)\b/i,
  /\bdeclin\w*/i,
  /\breject\w*/i,
  /\brecommend\w*/i,
  /\bshould (be )?(funded|approved|granted|declined|rejected|denied|lent)\b/i,
  /\b(fund|funds|funded|funding|grant|grants|granted|granting)\b/i,
  /\bturn\w* (\w+ )?(down|away)\b/i,
  /\bdisqualif\w*|\bqualif\w*|\beligib\w*|\bcreditworth\w*/i,
  /\b(will|likely to|going to|probably) (default|repay)\b/i,
  /\b(good|poor|bad|strong|weak) (candidate|risk)\b/i,
  /\blend(ing)? to\b|\bproceed\b|\bunderwrite this\b|\bverdict\b/i,
];

/**
 * Protected characteristics and close proxies (ECOA/Fair Housing classes: age, race, color, religion, national
 * origin, sex, marital and familial status, disability, public assistance) plus location. Word-boundary matches,
 * so "percentage" and "threshold" don't trip the short words.
 */
export const PROTECTED_PATTERNS: readonly RegExp[] = [
  /\b(age|aged|ages|aging|ageing|old|older|oldest|young|younger|youngest|elderly|teen\w*|middle-aged)\b/i,
  /\b(married|marital|divorc\w*|widow\w*|spouse|spouses|wife|husband|single (mother|father|parent))\b/i,
  /\b(race|races|racial\w*|racist|ethnic\w*|colou?r(ed)?|hispanic|latino|latina|african|asian|caucasian)\b/i,
  /\breligio\w*|\b(church|mosque|temple|christian|muslim|jewish|hindu|buddhist|atheis\w*)\b/i,
  /\bnation(al|ality|alities)\b|\borigin\b|\bimmigra\w*|\bcitizen\w*|\bforeign\w*/i,
  /\b(gender|sex|sexual\w*|male|female|man|men|woman|women|boy|girl|lgbt\w*|transgender|pregnan\w*|maternity|mother|father|famil\w+|child|children|kids?)\b/i,
  /\bdisab\w*|\bhandicap\w*|\bimpair\w*|\bchronic\b/i,
  /\b(public assistance|welfare|food stamps?|medicaid|medicare|disability income)\b/i,
  /\b(zip|zipcode|postal|neighbou?rhood\w*|location|located|address|city|county|rural|urban|region)\b/i,
];

const NUMBER_WORDS =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|half|double|triple)\b/i;

const NUMBER_TOKEN = /(?<![\w.])\$?\d[\d,]*(?:\.\d+)?%?/g;

function parseToken(token: string): number {
  return Number(token.replace(/[$,%]/g, ""));
}

function numbersIn(text: string): number[] {
  return (text.match(NUMBER_TOKEN) ?? []).map(parseToken).filter((n) => Number.isFinite(n));
}

/** Every number the rules produced: metrics, plus each number printed in a rule or reason (limits, counts). */
export function allowedNumbers(assessment: RiskAssessment): number[] {
  const { metrics, flags } = assessment;
  const allowed: number[] = [
    metrics.monthlyIncomeCents / 100,
    metrics.newPaymentCents / 100,
    metrics.assumedAprPct,
    metrics.monthsEmployed,
    ...Object.values(metrics.documents),
  ];
  if (metrics.dtiPct !== null) allowed.push(metrics.dtiPct);
  if (metrics.ltiPct !== null) allowed.push(metrics.ltiPct);
  for (const flag of flags) allowed.push(...numbersIn(flag.reason), ...numbersIn(flag.rule));
  return allowed;
}

/** Tolerance: half a unit, so "48%" matches 47.9% and "$415" matches $415.38. */
const TOLERANCE = 0.5;

/** Spelled-out numbers count as claims too, except in questions ("your two latest pay stubs" asserts nothing). */
export function hasUnverifiedNumber(text: string, allowed: readonly number[], opts: { words?: boolean } = {}): boolean {
  if (opts.words !== false && NUMBER_WORDS.test(text)) return true;
  return numbersIn(text).some((n) => !allowed.some((a) => Math.abs(a - n) <= TOLERANCE));
}

export function textViolations(text: string, allowed: readonly number[], opts: { words?: boolean } = {}): GuardrailCode[] {
  const codes: GuardrailCode[] = [];
  if (DECISION_PATTERNS.some((p) => p.test(text))) codes.push("decision_language");
  if (PROTECTED_PATTERNS.some((p) => p.test(text))) codes.push("protected_characteristic");
  if (hasUnverifiedNumber(text, allowed, opts)) codes.push("number_mismatch");
  return codes;
}

/** A metric a strength may not cite while a rule flags it. INCOME_UNVERIFIED is always on, so it doesn't count. */
function flaggedMetrics(flags: readonly RuleFlag[]): Set<MetricName> {
  const out = new Set<MetricName>();
  for (const flag of flags) {
    if (flag.code === "INCOME_UNVERIFIED") continue;
    for (const metric of FLAG_METRICS[flag.code]) out.add(metric);
  }
  return out;
}

/** Rule reasons only. Used when the model's answer is rejected, or the model is unavailable. */
export function fallbackData(assessment: RiskAssessment): RiskSummaryData {
  return {
    summary: fallbackSummary(assessment),
    strengths: [],
    concerns: assessment.flags.map((flag) => ({ flag: flag.code, text: flag.reason, evidence: [...flag.evidence] })),
    questionsForApplicant: [],
  };
}

export function fallbackSummary(assessment: RiskAssessment): string {
  const codes = assessment.flags.map((flag) => flag.code).join(", ");
  return `No AI wording is shown for this file. The rules flagged: ${codes}. The computed reasons are listed with each flag.`;
}

export type GuardedResult = { data: RiskSummaryData; fallback: boolean; codes: GuardrailCode[] };

/**
 * Apply every guardrail to the model's (already schema-valid) answer.
 * - A summary with decision language or a protected characteristic rejects the whole answer.
 * - Any other field with a violation is replaced by the rule's reason (concerns) or dropped (strengths, questions).
 * - Concerns need a computed flag, once each, citing only metrics that rule reads.
 */
export function applyGuardrails(output: RiskModelOutput, assessment: RiskAssessment): GuardedResult {
  const codes = new Set<GuardrailCode>();
  const allowed = allowedNumbers(assessment);
  const byCode = new Map<string, RuleFlag>(assessment.flags.map((flag) => [flag.code, flag]));

  const summaryCodes = textViolations(output.summary, allowed);
  if (summaryCodes.includes("decision_language") || summaryCodes.includes("protected_characteristic")) {
    for (const code of summaryCodes) codes.add(code);
    return { data: fallbackData(assessment), fallback: true, codes: [...codes] };
  }
  let summary = output.summary.trim();
  if (summaryCodes.length > 0) {
    for (const code of summaryCodes) codes.add(code);
    summary = fallbackSummary(assessment);
  }

  const concerns: RiskSummaryData["concerns"] = [];
  const seen = new Set<string>();
  for (const concern of output.concerns) {
    const flag = byCode.get(concern.flag);
    if (!flag) {
      codes.add("unknown_flag");
      continue;
    }
    if (seen.has(flag.code)) {
      codes.add("duplicate_flag");
      continue;
    }
    seen.add(flag.code);
    const violations = textViolations(concern.text, allowed);
    for (const code of violations) codes.add(code);
    const allowedEvidence = FLAG_METRICS[flag.code as FlagCode];
    let evidence = concern.evidence.filter((metric, i, all) => allowedEvidence.includes(metric) && all.indexOf(metric) === i);
    if (evidence.length === 0 || evidence.length !== new Set(concern.evidence).size) {
      codes.add("evidence_corrected");
      if (evidence.length === 0) evidence = [...flag.evidence];
    }
    concerns.push({ flag: flag.code, text: violations.length > 0 ? flag.reason : concern.text.trim(), evidence });
  }

  const flagged = flaggedMetrics(assessment.flags);
  const strengths: RiskSummaryData["strengths"] = [];
  for (const strength of output.strengths) {
    const violations = textViolations(strength.text, allowed);
    if (violations.length > 0) {
      for (const code of violations) codes.add(code);
      continue;
    }
    if (strength.evidence.some((metric) => flagged.has(metric))) {
      codes.add("strength_contradicts_flag");
      continue;
    }
    strengths.push({ text: strength.text.trim(), evidence: [...new Set(strength.evidence)] });
  }

  const questionsForApplicant: string[] = [];
  for (const question of output.questionsForApplicant) {
    const violations = textViolations(question, allowed, { words: false });
    if (violations.length > 0) {
      for (const code of violations) codes.add(code);
      continue;
    }
    questionsForApplicant.push(question.trim());
  }

  return { data: { summary, strengths, concerns, questionsForApplicant }, fallback: false, codes: [...codes] };
}
