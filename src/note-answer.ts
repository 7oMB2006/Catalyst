import type { NoteResearchResult } from "./note-contracts.js";
import { collectFindings } from "./research.js";

type NoteAnswerResult = Pick<NoteResearchResult, "request" | "evidence" | "findings" | "analysis" | "warnings">;

// collectFindings adds this notice to every accepted finding. The public findings
// retain it; the readable answer displays its meaning once in the chosen locale.
const SHARED_FINDING_NOTICE = "Model interpretation; citation IDs are validated structurally, not semantically.";

function usesChinese(result: NoteAnswerResult): boolean {
  const language = result.request.language?.trim();
  return language
    ? /^(?:zh(?:[-_]|$)|chinese\b)|中文|汉语|漢語/i.test(language)
    : /\p{Script=Han}/u.test(result.request.question);
}

/** Assemble the note's readable answer from accepted findings, never a second model answer. */
export function collectNoteAnswer(raw: string, result: NoteAnswerResult): boolean {
  const scratch = { evidence: result.evidence, findings: [] as NoteResearchResult["findings"], analysis: null as string | null, warnings: [] as string[] };
  const complete = collectFindings(raw, scratch, ["note_text", "image_text", "image_visual"]);
  result.findings = scratch.findings;
  result.analysis = null;

  const chinese = usesChinese(result);
  if (!result.findings.length) {
    result.warnings.push(chinese
      ? "未取得具有有效来源引用的答案要点，未生成主答案。"
      : "No answer findings with valid evidence references were accepted; no readable answer was generated.");
    return false;
  }
  if (!complete) result.warnings.push(chinese
    ? "部分答案要点未通过校验而被丢弃；主答案仅包含保留的要点。"
    : "Some answer findings failed validation and were discarded; the readable answer contains only accepted findings.");

  const evidence = new Map(result.evidence.map((item) => [item.id, item]));
  const items = result.findings.map((finding, index) => {
    const citations = finding.evidence_ids.map((id) => {
      const item = evidence.get(id)!;
      const location = item.kind === "note_text"
        ? chinese ? "笔记正文" : "note body"
        : item.page === null ? chinese ? "无页码" : "no page number"
          : chinese ? `第 ${item.page} 页` : `page ${item.page}`;
      return `${location} (${id})`;
    });
    const limitations = [...new Set(finding.limitations.map((item) => item.trim()).filter((item) => item && item !== SHARED_FINDING_NOTICE))];
    return [
      `${index + 1}. ${finding.statement}`,
      `   ${chinese ? "来源" : "Sources"}: ${citations.join(chinese ? "；" : "; ")}`,
      ...(limitations.length ? [`   ${chinese ? "限制" : "Limitations"}: ${limitations.join(chinese ? "；" : "; ")}`] : []),
    ].join("\n");
  });
  result.analysis = [...items, chinese
    ? "说明：要点为模型解释，未经独立核验；来源引用仅经过结构校验，不代表内容正确或问题已完整回答。"
    : "Note: Findings are unverified model interpretations. Evidence references are checked structurally; they do not establish factual accuracy or answer completeness."
  ].join("\n\n");
  return complete;
}
