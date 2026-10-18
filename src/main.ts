// One review run: decide whether to review, pick the diff (only new commits when an earlier review exists), ask the
// model, and post what it found.
import { readFileSync } from "node:fs";
import { input, log, setOutput, summary } from "./actions.ts";
import { commentableLines, excluder, selectFiles } from "./diff.ts";
import { GitHub, GitHubError, type PrFile } from "./github.ts";
import { chat, type Message } from "./llm.ts";
import { buildMessages, parseReview, placeFindings, type ReviewResult } from "./review.ts";
import { formatStatus, readState, type State } from "./state.ts";

interface PullRequestEvent {
  action: string;
  label?: { name: string };
  pull_request: {
    number: number;
    state: string;
    draft: boolean;
    title: string;
    body: string | null;
    user: { login: string; type: string };
    labels: { name: string }[];
    head: { sha: string };
    base: { sha: string };
  };
}

export interface Outcome {
  skipped?: string;
  findings?: number;
  sha?: string;
}

/** Why this event shouldn't be reviewed, or null to go ahead. */
export function skipReason(eventName: string, event: PullRequestEvent, opts: { triggerLabel: string; reviewBots: boolean }): string | null {
  if (eventName !== "pull_request" && eventName !== "pull_request_target") return `not a pull request event (${eventName})`;
  const pr = event.pull_request;
  if (pr.state !== "open") return "the pull request is closed";
  if (pr.draft) return "the pull request is a draft";
  if (!opts.reviewBots && (pr.user.type === "Bot" || pr.user.login.endsWith("[bot]"))) return `opened by a bot (${pr.user.login})`;
  if (event.action === "labeled") {
    // A label event reviews only when it's the trigger label being added; any other label is noise.
    if (!opts.triggerLabel || event.label?.name !== opts.triggerLabel) return "a label other than the trigger label was added";
  } else if (opts.triggerLabel && !pr.labels.some((l) => l.name === opts.triggerLabel)) return `no "${opts.triggerLabel}" label`;
  return null;
}

export async function run(env: NodeJS.ProcessEnv = process.env, doFetch: typeof fetch = fetch): Promise<Outcome> {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8")) as PullRequestEvent;
  const triggerLabel = input("trigger-label", env);
  const skip = skipReason(env.GITHUB_EVENT_NAME ?? "", event, { triggerLabel, reviewBots: input("review-bots", env) === "true" });
  if (skip) return done({ skipped: skip }, env);

  const apiKey = input("api-key", env);
  const baseUrl = input("base-url", env) || "https://models.github.ai/inference";
  const model = input("model", env) || "openai/gpt-4.1-mini";
  if (!apiKey) throw new Error("api-key is empty: set it, or give the job `permissions: models: read` to use GitHub Models with the workflow token");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("base-url must use https (plain http is allowed only for localhost)");
  log.secret(apiKey);
  const maxFindings = Math.max(1, Number(input("max-findings", env)) || 10);
  const maxChars = Number(input("max-diff-chars", env)) || (url.hostname === "models.github.ai" ? 20_000 : 150_000);
  const prices = [Number(input("price-input", env)), Number(input("price-output", env))] as const;

  const pr = event.pull_request;
  const head = pr.head.sha;
  const gh = new GitHub({ api: env.GITHUB_API_URL ?? "https://api.github.com", repo: env.GITHUB_REPOSITORY ?? "", token: input("github-token", env), fetch: doFetch });

  const previous = readState(await gh.issueComments(pr.number));
  if (previous?.state.reviewed === head) return done({ skipped: `${head.slice(0, 7)} was already reviewed`, sha: head }, env);
  const prFiles = await gh.pullFiles(pr.number);

  // Only the commits since the last review, when that commit is still in the branch's history. A force-push or rebase
  // makes it unreachable, and the whole pull request is reviewed again.
  let files: PrFile[] = prFiles;
  let from: string | undefined;
  if (previous) {
    const cmp = await gh.compare(previous.state.reviewed, head).catch((e: unknown) => {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    });
    if (cmp?.status === "ahead") {
      // Merging the base branch in brings in files the pull request doesn't change; those aren't the author's to review.
      const inPr = new Set(prFiles.map((f) => f.filename));
      files = cmp.files.filter((f) => inPr.has(f.filename));
      from = previous.state.reviewed;
    }
  }

  const selection = selectFiles(files, excluder(input("exclude", env)), maxChars);
  const rounds = previous?.state.rounds ?? [];
  const at = new Date().toISOString();
  const post = async (state: State, body: Omit<Parameters<typeof formatStatus>[0], "state">) => {
    const text = formatStatus({ state, ...body });
    if (previous) await gh.updateIssueComment(previous.id, text);
    else await gh.createIssueComment(pr.number, text);
  };

  if (!selection.files.length) {
    const note = from ? "no new reviewable changes" : "nothing reviewable";
    await post({ reviewed: head, rounds: [...rounds, { sha: head, ...(from ? { from } : {}), findings: 0, model, at, note }] }, {
      summary: `Nothing to review: ${from ? "the new commits don't change any reviewable file" : "every changed file is excluded, binary or too large"}.`,
      findings: [], inline: 0, unplaced: [], skipped: selection.skipped, usage: null,
    });
    return done({ skipped: note, findings: 0, sha: head }, env);
  }

  const rules = await gh.fileAt(input("rules-file", env) || ".github/review-rules.md", pr.base.sha);
  const messages = buildMessages({ title: pr.title, body: pr.body ?? "", files: selection.files, rules, incremental: from ? { from, to: head } : null, maxFindings });
  const { result, served, usage } = await ask({ baseUrl, apiKey, model, messages, doFetch });

  const placement = placeFindings(result.findings, selection.files, commentableLines(prFiles), maxFindings);
  let { comments, unplaced } = placement;
  if (comments.length) {
    try {
      await gh.createReview(pr.number, head, `**pr-review-agent**: ${comments.length} comment${comments.length === 1 ? "" : "s"} on ${head.slice(0, 7)}. The summary is in the status comment.`, comments);
    } catch (e) {
      // GitHub rejects the whole review if one comment's line isn't in its diff; list them in the status comment instead.
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
      log.warning(`inline comments were rejected (${e.message.slice(0, 200)}); listing them in the status comment`);
      unplaced = [...placement.placed, ...placement.unplaced];
      comments = [];
    }
  }
  const cost = usage && Number.isFinite(prices[0]) && Number.isFinite(prices[1]) && prices[0] + prices[1] > 0 ? (usage.input * prices[0] + usage.output * prices[1]) / 1e6 : undefined;
  const shown = placement.kept.length;
  await post({ reviewed: head, rounds: [...rounds, { sha: head, ...(from ? { from } : {}), findings: shown, model: served, at, ...(usage ? { tokens: usage.input + usage.output } : {}), ...(cost === undefined ? {} : { cost }) }] }, {
    summary: result.summary, findings: placement.kept, inline: comments.length, unplaced, skipped: selection.skipped, usage,
  });
  return done({ findings: shown, sha: head }, env);
}

/** Ask the model; one retry with the parse error when its answer isn't the JSON asked for. */
async function ask(args: { baseUrl: string; apiKey: string; model: string; messages: Message[]; doFetch: typeof fetch }): Promise<{ result: ReviewResult; served: string; usage: { input: number; output: number } | null }> {
  const call = (messages: Message[]) => chat({ baseUrl: args.baseUrl, apiKey: args.apiKey, model: args.model, messages, fetch: args.doFetch });
  const first = await call(args.messages);
  try {
    return { result: parseReview(first.content), served: first.model, usage: first.usage };
  } catch (e) {
    const retry = await call([...args.messages, { role: "assistant", content: first.content }, { role: "user", content: `That answer can't be used: ${(e as Error).message}. Reply with only the JSON object described.` }]);
    const usage = first.usage && retry.usage ? { input: first.usage.input + retry.usage.input, output: first.usage.output + retry.usage.output } : retry.usage;
    return { result: parseReview(retry.content), served: retry.model, usage };
  }
}

function done(outcome: Outcome, env: NodeJS.ProcessEnv): Outcome {
  if (outcome.skipped) log.notice(`pr-review-agent: skipped, ${outcome.skipped}`);
  setOutput("findings", outcome.findings ?? 0, env);
  setOutput("reviewed-sha", outcome.sha ?? "", env);
  setOutput("skipped", outcome.skipped ?? "", env);
  if (!outcome.skipped) summary(`**pr-review-agent** reviewed ${outcome.sha?.slice(0, 7)}: ${outcome.findings} finding(s).`, env);
  return outcome;
}
