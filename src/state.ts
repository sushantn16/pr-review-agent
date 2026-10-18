// The agent's status comment: one comment on the pull request, edited in place. It shows the latest review and records
// the last reviewed commit, so the next run reviews only what's new.
import type { IssueComment } from "./github.ts";
import type { Finding } from "./review.ts";

export const MARKER = "<!-- pr-review-agent -->";
const STATE = /<!-- pr-review-agent:state ([A-Za-z0-9+/=]+) -->/;

export interface Round {
  sha: string;
  /** Set when only the commits since this one were reviewed. */
  from?: string;
  findings: number;
  model: string;
  tokens?: number;
  cost?: number;
  at: string;
  note?: string;
}

export interface State {
  reviewed: string;
  rounds: Round[];
}

/** The latest status comment and its state. Only bot comments count: anyone can paste the marker into a comment. */
export function readState(comments: IssueComment[]): { id: number; state: State } | null {
  for (const c of [...comments].reverse()) {
    if (c.user?.type !== "Bot" || !c.body?.includes(MARKER)) continue;
    const m = c.body.match(STATE);
    if (!m) continue;
    try {
      const s = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as State;
      if (typeof s.reviewed === "string" && Array.isArray(s.rounds)) return { id: c.id, state: s };
    } catch {
      // A damaged state comment means a full review, nothing worse.
    }
  }
  return null;
}

const short = (sha: string) => `\`${sha.slice(0, 7)}\``;
const count = (findings: Finding[], s: Finding["severity"]) => findings.filter((f) => f.severity === s).length;
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

export function formatStatus(args: {
  state: State;
  summary: string;
  findings: Finding[];
  inline: number;
  unplaced: Finding[];
  skipped: { path: string; reason: string }[];
  usage: { input: number; output: number } | null;
}): string {
  const { state, findings } = args;
  const round = state.rounds.at(-1)!;
  const scope = round.from ? `the commits since ${short(round.from)}` : "the whole pull request";
  const lines = [
    MARKER,
    `**pr-review-agent** reviewed ${short(round.sha)} (${scope}): ${findings.length ? `${findings.length} finding${findings.length === 1 ? "" : "s"}, ${count(findings, "high")} high, ${count(findings, "medium")} medium, ${count(findings, "low")} low` : "no findings"}${args.inline ? `, ${args.inline} as inline comments` : ""}.`,
    "",
    args.summary,
  ];
  if (args.unplaced.length) {
    lines.push("", "**Findings outside the diff** (listed here because they can't be inline comments):");
    for (const f of args.unplaced) lines.push(`- \`${f.file}:${f.line}\` **${f.severity}** ${f.title}: ${f.explanation}`);
  }
  if (args.skipped.length) {
    lines.push("", `<details><summary>Files not reviewed (${args.skipped.length})</summary>`, "");
    for (const s of args.skipped.slice(0, 50)) lines.push(`- \`${s.path}\`: ${s.reason}`);
    if (args.skipped.length > 50) lines.push(`- and ${args.skipped.length - 50} more`);
    lines.push("", "</details>");
  }
  const earlier = state.rounds.slice(0, -1);
  if (earlier.length) {
    lines.push("", `<details><summary>Earlier reviews (${earlier.length})</summary>`, "", "| Commit | Findings | Model | Cost |", "|---|---|---|---|");
    for (const r of earlier.slice(-20).reverse()) lines.push(`| ${short(r.sha)}${r.note ? ` ${r.note}` : ""} | ${r.findings} | ${r.model} | ${r.cost === undefined ? "–" : usd(r.cost)} |`);
    lines.push("", "</details>");
  }
  const tokens = args.usage ? ` · ${args.usage.input.toLocaleString("en")} tokens in, ${args.usage.output.toLocaleString("en")} out` : "";
  lines.push("", `<sub>${round.model}${tokens}${round.cost === undefined ? "" : ` · ${usd(round.cost)}`}</sub>`);
  // Keep the history short enough that the comment never grows without bound.
  const kept: State = { reviewed: state.reviewed, rounds: state.rounds.slice(-30) };
  lines.push(`<!-- pr-review-agent:state ${Buffer.from(JSON.stringify(kept)).toString("base64")} -->`);
  return lines.join("\n");
}
