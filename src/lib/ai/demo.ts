/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  "summarize-items": {
    summary:
      "You have a few open items. The most recent ones focus on setup work; nothing looks overdue.",
    highlights: ["Setup tasks are the largest group", "No items are flagged urgent"],
  },
  // Loan risk summary. Deliberately has no digits. The guardrails in src/lib/risk-guardrails.ts drop any concern
  // whose flag the rules didn't raise for the application (DTI_HIGH here), so this stays true per application.
  "loan-risk-summary": {
    summary:
      "Demo summary (recorded, not from a live model): the application's main risks are listed below with the computed reasons; review the documents to confirm income.",
    strengths: [{ text: "Required documents are present.", evidence: ["documents"] }],
    concerns: [
      {
        flag: "DTI_HIGH",
        text: "Monthly debt payments including the new loan are high relative to income.",
        evidence: ["dti"],
      },
      {
        flag: "INCOME_UNVERIFIED",
        text: "Stated income hasn't been checked against the documents.",
        evidence: ["monthly_income", "documents"],
      },
    ],
    questionsForApplicant: ["Can you provide your two most recent pay stubs?"],
  },
};

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
