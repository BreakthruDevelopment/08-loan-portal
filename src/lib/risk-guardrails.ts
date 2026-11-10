/**
 * Code-level guardrails on the model's answer. Pure functions, tested in risk-guardrails.test.ts.
 * The model explains the rule flags; it never decides, never brings in protected characteristics,
 * never invents a flag, and never states a number the rules didn't compute.
 */
import { FLAG_METRICS, type FlagCode, type MetricName, type RiskAssessment, type RuleFlag, THRESHOLDS } from "@/lib/risk-rules";
import type { RiskModelOutput, RiskSummaryData } from "@/lib/risk-schema";

export type GuardrailCode =
  | "decision_language"
  | "protected_characteristic"
  | "number_mismatch"
  | "unknown_token"
  | "unknown_flag"
  | "duplicate_flag"
  | "evidence_corrected"
  | "strength_contradicts_flag"
  | "strength_unsupported";

/** Words that make or hint at a credit decision or a prediction. Matched case-insensitively, after NFKC. */
export const DECISION_PATTERNS: readonly RegExp[] = [
  /\bapprov\w*/i,
  /\bden(y|ies|ied|ying|ial)\b/i,
  /\bdeclin\w*/i,
  /\breject\w*/i,
  /\brecommend\w*/i,
  /\badvis\w*/i,
  /\bsuggest\w*/i,
  /\baccept\w*/i,
  /\brefus\w*/i,
  /\bextend\w*\s+(?:the\s+|this\s+|that\s+|a\s+|any\s+)?(?:loan|credit)\b/i,
  /\bshould (be )?(funded|approved|granted|declined|rejected|denied|lent)\b/i,
  // "funds" alone is a normal word ("source of funds"); only funding the loan is a decision.
  /\bfund(?:s|ed|ing)?\s+(?:the\s+|this\s+|that\s+|a\s+|an\s+)?(?:loan|credit|application|request|file)\b/i,
  /\b(?:be|been|get|gets|being)\s+funded\b/i,
  /\b(grant|grants|granted|granting)\b/i,
  /\bturn\w* (\w+ )?(down|away)\b/i,
  /\bdisqualif\w*|\bqualif\w*|\beligib\w*|\bcreditworth\w*/i,
  /\b(?:will|would|may|might|could|likely to|unlikely to|going to|probably|at risk of|risk of|likelihood of|chance of)\s+(?:\w+\s+)?(?:default|repay)\w*/i,
  /\bdefault\b/i,
  /\b(good|poor|bad|strong|weak) (candidate|risk)\b/i,
  /\b(?:high|low|acceptable|minimal)[- ]risk\b/i,
  /\bsafe bet\b|\bgreen light\b|\bgood to go\b|\bsign[- ]off\b|\bgo(?:es|ing)? ahead\b|\bmov(?:e|es|ed|ing) forward\b/i,
  /\bpass(?:es|ed|ing)? on\b|\b(?:good|bad|poor) fit\b|\bstand(?:s|ing)? in the way\b|\bprudent\b/i,
  /\blend(ing)? to\b|\bproceed\b|\bunderwrite this\b|\bverdict\b/i,
  // Accusations are not something the rules computed.
  /\bfraud\w*|\bsuspici\w*|\bsuspect(?:s|ed)?\b|\bdishonest\w*/i,
];

/**
 * Protected characteristics and close proxies (ECOA/Fair Housing classes: age, race, color, religion, national
 * origin, sex, marital and familial status, disability, public assistance) plus location. Word-boundary matches,
 * so "percentage" and "threshold" don't trip the short words.
 */
export const PROTECTED_PATTERNS: readonly RegExp[] = [
  /\b(age|aged|ages|aging|ageing|old|older|oldest|young|younger|youngest|elderly|teen\w*|middle-aged)\b/i,
  // Age proxies: retirement income, benefits, students, veterans.
  /\bretire\w*|\bsocial security\b|\bpension\w*|\bssi\b|\bfixed income\b|\bstudent\w*|\bveteran\w*|\bmilitary\b/i,
  /\b(married|marital|divorc\w*|widow\w*|spouse|spouses|wife|husband|single (mother|father|parent))\b/i,
  /\b(race|races|racial\w*|racist|ethnic\w*|colou?r(ed)?|hispanic|latino|latina|african|asian|caucasian)\b/i,
  /\breligio\w*|\b(church|mosque|temple|christian|muslim|jewish|hindu|buddhist|atheis\w*)\b/i,
  /\bnation(al|ality|alities)\b|\borigin\b|\bimmigra\w*|\bcitizen\w*|\bforeign\w*/i,
  /\b(gender|sex|sexual\w*|male|female|man|men|woman|women|boy|girl|lgbt\w*|transgender|pregnan\w*|maternity|mother|father|famil(?:y|ies|ial)|child|children|kids?)\b/i,
  /\bdisab\w*|\bhandicap\w*|\bimpair\w*|\bchronic\b/i,
  /\b(public assistance|welfare|food stamps?|medicaid|medicare|disability income)\b/i,
  // "address" as a verb ("address the missing document") is fine; a place someone lives is not.
  /\b(zip|zipcode|postal|neighbou?rhood\w*|location|located|city|county|rural|urban|region)\b|\b(?:home|mailing|street|residential|billing|current|previous|prior|new|old) address(?:es)?\b|\bproof[- ]of[- ]address\b/i,
];

const NUMBER_WORDS =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|half|halves|double|triple|twice|thrice|third|thirds|quarter|quarters|fraction|fractions)\b/i;

/**
 * Numbers are checked by unit, not as one bag. NFKC first, so full-width digits and signs ("６１％") read as 61%.
 * - a percent sign or word, or any decimal, is a percent claim (a decimal below 1 is read as a fraction: 0.61 is 61%);
 *   it must match DTI, LTI, the assumed APR or a threshold percentage, and when a metric is named next to it
 *   ("DTI is X%", "APR", "X% of annual income") it must equal that metric;
 * - a $ amount must equal the monthly income or the new payment, to the cent or the whole dollar;
 * - a bare integer must be a month count, a document count or a threshold.
 */
const NUMBER_TOKEN = /(?<![\w.])(\$\s?)?(\d[\d,]*(?:\.\d+)?)(\s*(?:k\b|%|percent\b|per\s?cent\b|pct\b|percentage\s+points?\b|dollars?\b|usd\b|bucks\b))?/gi;

/** Invisible characters that could split a banned word. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const normalise = (text: string) => text.normalize("NFKC").replace(INVISIBLE, "");

type PercentMetric = "dti" | "lti" | "apr";

export type AllowedNumbers = {
  percent: Record<PercentMetric, number | null>;
  /** Threshold percentages: DTI limits and the LTI limit. */
  thresholds: number[];
  /** Dollar amounts: monthly income and the new payment. */
  money: number[];
  /** Month counts, document counts and the thresholds. */
  counts: number[];
  /** Flag codes the rules raised: the only ALL-CAPS codes the model may write. */
  flagCodes: ReadonlySet<string>;
};

/** Every number the rules produced, by unit. */
export function allowedNumbers(assessment: RiskAssessment): AllowedNumbers {
  const { metrics, flags } = assessment;
  const thresholds: number[] = [THRESHOLDS.dtiHighAbove, THRESHOLDS.dtiElevatedFrom, THRESHOLDS.ltiHighAbove];
  return {
    percent: { dti: metrics.dtiPct, lti: metrics.ltiPct, apr: metrics.assumedAprPct },
    thresholds,
    money: [metrics.monthlyIncomeCents / 100, metrics.newPaymentCents / 100],
    counts: [metrics.monthsEmployed, ...Object.values(metrics.documents), ...thresholds, THRESHOLDS.shortEmploymentMonths],
    flagCodes: new Set(flags.map((flag) => flag.code)),
  };
}

/** Tolerance: half a unit, so "48%" matches 47.9%. Thresholds are exact. */
const TOLERANCE = 0.5;
const near = (a: number, b: number, tolerance = TOLERANCE) => Math.abs(a - b) <= tolerance;

/** "above the 43%", "between 36% and 43%": the number is a limit, not a measurement. */
const THRESHOLD_BEFORE = /\b(?:above|over|under|below|exceeds?|exceeding|beyond|past|between|and|than)\s+(?:the\s+|a\s+|an\s+)?$/i;
const THRESHOLD_AFTER = /^\s*(?:the\s+)?(?:limit|threshold|cutoff|cap|ceiling|maximum|guideline|mark)\b/i;

const METRIC_BEFORE: readonly [PercentMetric, RegExp][] = [
  ["dti", /\b(?:dti|debt[- ]to[- ]income)\b/gi],
  ["lti", /\b(?:lti|loan[- ]to[- ](?:annual[- ])?income)\b/gi],
  ["apr", /\b(?:apr|interest(?: rate)?|annual percentage rate|assumed rate)\b/gi],
];
const FILLER = "(?:the\\s+|their\\s+|stated\\s+|gross\\s+)*";
const METRIC_AFTER: readonly [PercentMetric[], RegExp][] = [
  [["dti"], /^\s*(?:dti|debt[- ]to[- ]income)\b/i],
  [["lti"], /^\s*(?:lti|loan[- ]to[- ](?:annual[- ])?income)\b/i],
  [["apr"], /^\s*(?:apr|interest|annual percentage rate)\b/i],
  [["lti"], new RegExp(`^\\s*of\\s+${FILLER}(?:annual|yearly)\\s+(?:gross\\s+)?income\\b`, "i")],
  [["dti"], new RegExp(`^\\s*of\\s+${FILLER}monthly\\s+(?:gross\\s+)?income\\b`, "i")],
  [["dti", "lti"], new RegExp(`^\\s*of\\s+${FILLER}income\\b`, "i")],
];

/** The metric a percent sits next to: right after it, else the nearest name earlier in the same clause. */
function metricsFor(before: string, after: string): PercentMetric[] | null {
  for (const [metrics, pattern] of METRIC_AFTER) if (pattern.test(after)) return metrics;
  const clause = before.slice(Math.max(0, ...[...before.matchAll(/[;:!?\n]|\.(?=\s|$)/g)].map((m) => m.index + 1)));
  let best: { index: number; metric: PercentMetric } | null = null;
  for (const [metric, pattern] of METRIC_BEFORE) {
    for (const m of clause.matchAll(pattern)) if (!best || m.index > best.index) best = { index: m.index, metric };
  }
  return best ? [best.metric] : null;
}

function percentOk(value: number, before: string, after: string, allowed: AllowedNumbers): boolean {
  if (THRESHOLD_BEFORE.test(before) || THRESHOLD_AFTER.test(after)) return allowed.thresholds.some((t) => near(t, value, 0.05));
  const tied = metricsFor(before, after);
  if (tied) return tied.some((metric) => allowed.percent[metric] !== null && near(allowed.percent[metric], value));
  return (
    Object.values(allowed.percent).some((p) => p !== null && near(p, value)) || allowed.thresholds.some((t) => near(t, value, 0.05))
  );
}

function moneyOk(value: number, allowed: AllowedNumbers): boolean {
  // To the cent, or the whole dollar (rounded or truncated) when the amount is written without cents.
  return allowed.money.some((m) => near(m, value, 0.005) || (Number.isInteger(value) && (value === Math.round(m) || value === Math.floor(m))));
}

/** Spelled-out numbers count as claims too, except in questions ("your two latest pay stubs" asserts nothing). */
export function hasUnverifiedNumber(rawText: string, allowed: AllowedNumbers, opts: { words?: boolean } = {}): boolean {
  const text = normalise(rawText);
  if (opts.words !== false && NUMBER_WORDS.test(text)) return true;
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const [token, dollar, digits, rawSuffix] = match;
    const suffix = (rawSuffix ?? "").trim().toLowerCase();
    let value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value)) return true;
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + token.length);
    if (suffix === "k") value *= 1000;
    let ok: boolean;
    if (/^(%|percent|per\s?cent|pct|percentage)/.test(suffix)) ok = percentOk(value, before, after, allowed);
    else if (dollar || /^(dollars?|usd|bucks)$/.test(suffix)) ok = moneyOk(value, allowed);
    else if (digits.includes(".")) ok = percentOk(value < 1 ? value * 100 : value, before, after, allowed);
    else ok = allowed.counts.some((c) => c === value);
    if (!ok) return true;
  }
  return false;
}

/** ALL-CAPS words that aren't a flag code the rules raised, e.g. an invented FRAUD_SUSPECTED. DTI, LTI and APR are fine. */
const CAPS_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g;
const CAPS_OK = new Set(["DTI", "LTI", "APR", "USD", "PDF"]);
function hasUnknownCaps(text: string, allowed: AllowedNumbers): boolean {
  return (text.match(CAPS_TOKEN) ?? []).some((token) => token.length >= 3 && !CAPS_OK.has(token) && !allowed.flagCodes.has(token));
}

export function textViolations(rawText: string, allowed: AllowedNumbers, opts: { words?: boolean } = {}): GuardrailCode[] {
  const text = normalise(rawText);
  const codes: GuardrailCode[] = [];
  if (DECISION_PATTERNS.some((p) => p.test(text))) codes.push("decision_language");
  if (PROTECTED_PATTERNS.some((p) => p.test(text))) codes.push("protected_characteristic");
  if (hasUnverifiedNumber(text, allowed, opts)) codes.push("number_mismatch");
  if (hasUnknownCaps(text, allowed)) codes.push("unknown_token");
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

/**
 * Which metrics a strength talks about, read from its words. Ratios are consumed first, so "debt-to-income" is the
 * DTI and not also "income". Each hit is a group: the strength is about any one of its metrics.
 */
const TOPICS: readonly (readonly [RegExp, readonly MetricName[]])[] = [
  [/\bloan[- ]to[- ](?:annual[- ])?income\b|\blti\b/gi, ["lti"]],
  [/\bdebt[- ]to[- ]income\b|\bdti\b|\bdebts?\b|\bpayments?\b|\bobligations?\b|\bliabilit\w*/gi, ["dti", "new_payment"]],
  [/\bincome\b|\bsalary\b|\bearnings?\b|\bwages?\b/gi, ["monthly_income"]],
  [/\bemploy\w*|\bjob\b|\btenure\b/gi, ["months_employed"]],
  [/\bdocument\w*|\bpay stubs?\b|\bbank statements?\b|\btax returns?\b/gi, ["documents"]],
  [/\bcredit\b/gi, ["credit_band"]],
];

export function metricsMentioned(rawText: string): MetricName[][] {
  let text = normalise(rawText);
  const groups: MetricName[][] = [];
  for (const [pattern, metrics] of TOPICS) {
    if (pattern.test(text)) groups.push([...metrics]);
    pattern.lastIndex = 0;
    text = text.replace(pattern, " ");
  }
  return groups;
}

/** "Required documents are present" is only true with an ID on file too. */
const DOCUMENTS_COMPLETE = /\b(?:required|all|complete|full)\b[^.]*\bdocument|\bdocuments?\b[^.]*\b(?:present|complete|on file|in place|provided|received)\b/i;

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
 * - A strength is dropped if it cites or names a flagged metric, or names one it doesn't cite.
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
    const mentioned = metricsMentioned(strength.text);
    if (strength.evidence.some((metric) => flagged.has(metric)) || mentioned.some((group) => group.some((metric) => flagged.has(metric)))) {
      codes.add("strength_contradicts_flag");
      continue;
    }
    if (assessment.metrics.documents.id === 0 && DOCUMENTS_COMPLETE.test(normalise(strength.text))) {
      codes.add("strength_contradicts_flag");
      continue;
    }
    // A strength may only talk about what it cites.
    if (mentioned.some((group) => !group.some((metric) => strength.evidence.includes(metric)))) {
      codes.add("strength_unsupported");
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
