import type { AgentLlm } from "./llm.js";
import type { Task } from "./task.js";

/**
 * Grading (spec §10): exact/contains are programmatic; judge grades the final
 * answer only — never the transcript (judge the answer, not the effort).
 */

export const JUDGE_PROMPT_VERSION = "judge-v2";

const JUDGE_SYSTEM = `You are a strict benchmark grader. You receive a task, a grading rubric, and an agent's final answer. Grade the ANSWER against the rubric only — ignore effort, verbosity, or style. Reject answers that are hedged to the point of not committing, and answers based on general knowledge where the rubric demands tool-derived evidence.
Today's date is ${new Date().toISOString().slice(0, 10)}. The agent had live tool access, so data dated near today — including dates after your training cutoff — is expected and must NOT be treated as fabricated on recency alone.
Respond in exactly this format:
VERDICT: pass|fail
REASON: <one sentence>`;

export interface GradeResult {
  pass: boolean;
  reason: string;
}

export async function gradeAnswer(
  task: Task,
  finalAnswer: string | null,
  judge: AgentLlm,
  judgeModel: string,
): Promise<GradeResult> {
  if (finalAnswer === null || finalAnswer.trim() === "") {
    return { pass: false, reason: "no final answer (timeout or hard error)" };
  }
  const grading = task.grading;
  switch (grading.type) {
    case "exact": {
      const pass = normalize(finalAnswer) === normalize(grading.expected);
      return { pass, reason: pass ? "exact match" : `expected exactly "${grading.expected}"` };
    }
    case "contains": {
      const needles = Array.isArray(grading.expected) ? grading.expected : [grading.expected];
      const haystack = finalAnswer.toLowerCase();
      const missing = needles.filter((n) => !haystack.includes(n.toLowerCase()));
      return missing.length === 0
        ? { pass: true, reason: "contains all expected strings" }
        : { pass: false, reason: `missing: ${missing.join(", ")}` };
    }
    case "judge": {
      const prompt =
        `## Task given to the agent\n${task.prompt}\n\n## Rubric\n${grading.rubric}\n` +
        (grading.reference
          ? `\n## Reference answer (context, not verbatim requirement)\n${grading.reference}\n`
          : "") +
        `\n## Agent's final answer\n${finalAnswer}`;
      const response = await judge.chat({
        model: judgeModel,
        system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens: 512,
      });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const verdict = /VERDICT:\s*(pass|fail)/i.exec(text);
      const reason = /REASON:\s*(.+)/i.exec(text)?.[1]?.trim() ?? text.slice(0, 200);
      if (!verdict) return { pass: false, reason: `unparseable judge output: ${reason}` };
      return { pass: verdict[1]!.toLowerCase() === "pass", reason };
    }
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
