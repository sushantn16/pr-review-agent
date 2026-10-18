import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chat } from "../src/llm.ts";
import { run, skipReason } from "../src/main.ts";
import { formatStatus, readState } from "../src/state.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake GitHub API and model API in one fetch. Records every request. */
function fakes(opts: { comments?: unknown[]; compare?: { status: string; files: unknown[] }; findings?: unknown[]; reviewStatus?: number }) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const prFiles = [
    { filename: "src/cache.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,3 +1,4 @@\n export const cache = new Map();\n-export const get = (k) => cache.get(k);\n+export const get = (k) => cache[k];\n+export const set = (k, v) => cache.set(k, v);\n export const size = () => cache.size;" },
    { filename: "pnpm-lock.yaml", status: "modified", additions: 40, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
  ];
  const fetchFake: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.startsWith("https://llm.test/v1/chat/completions")) {
      return json({ model: "test-model-1", usage: { prompt_tokens: 1000, completion_tokens: 200 }, choices: [{ message: { content: JSON.stringify({ summary: "Changes the cache accessors.", findings: opts.findings ?? [] }) } }] });
    }
    const path = url.replace("https://api.test", "");
    if (path.startsWith("/repos/o/r/issues/5/comments")) return method === "GET" ? json(opts.comments ?? []) : json({ id: 99 }, 201);
    if (path.startsWith("/repos/o/r/issues/comments/")) return json({ id: 1 });
    if (path.startsWith("/repos/o/r/pulls/5/files")) return json(prFiles);
    if (path.startsWith("/repos/o/r/compare/")) return opts.compare ? json(opts.compare) : json({ message: "Not Found" }, 404);
    if (path.startsWith("/repos/o/r/contents/.github/review-rules.md")) return new Response("Flag any Map misuse.", { status: 200 });
    if (path.startsWith("/repos/o/r/pulls/5/reviews")) return json({ id: 3 }, opts.reviewStatus ?? 200);
    return json({ message: `unexpected ${method} ${path}` }, 500);
  };
  return { calls, fetchFake };
}

function env(event: object, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-agent-"));
  writeFileSync(join(dir, "event.json"), JSON.stringify(event));
  writeFileSync(join(dir, "output"), "");
  return {
    GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_OUTPUT: join(dir, "output"), GITHUB_API_URL: "https://api.test",
    GITHUB_REPOSITORY: "o/r", "INPUT_API-KEY": "sk-test", "INPUT_BASE-URL": "https://llm.test/v1", INPUT_MODEL: "test-model", "INPUT_GITHUB-TOKEN": "ghs_test", ...extra,
  } as NodeJS.ProcessEnv;
}

const pr = (over: object = {}) => ({
  action: "opened",
  pull_request: { number: 5, state: "open", draft: false, title: "Cache accessors", body: "", user: { login: "dev", type: "User" }, labels: [], head: { sha: C }, base: { sha: A }, ...over },
});

test("gates: drafts, bots, closed PRs, and labels", () => {
  const o = { triggerLabel: "", reviewBots: false };
  assert.equal(skipReason("push", pr() as never, o), "not a pull request event (push)");
  assert.equal(skipReason("pull_request", pr({ draft: true }) as never, o), "the pull request is a draft");
  assert.equal(skipReason("pull_request", pr({ user: { login: "renovate[bot]", type: "Bot" } }) as never, o), "opened by a bot (renovate[bot])");
  assert.equal(skipReason("pull_request", { ...pr(), action: "labeled", label: { name: "bug" } } as never, o), "a label other than the trigger label was added");
  assert.equal(skipReason("pull_request", pr() as never, { ...o, triggerLabel: "ai-review" }), 'no "ai-review" label');
  assert.equal(skipReason("pull_request", { ...pr({ labels: [{ name: "ai-review" }] }), action: "labeled", label: { name: "ai-review" } } as never, { ...o, triggerLabel: "ai-review" }), null);
  assert.equal(skipReason("pull_request_target", pr() as never, o), null);
});

test("first review: whole PR, inline comment on the diff, status comment with the reviewed commit", async () => {
  const { calls, fetchFake } = fakes({ findings: [{ file: "src/cache.ts", line: 2, severity: "high", category: "bug", title: "Map read with brackets", explanation: "cache[k] reads a property, not a Map entry, so get always returns undefined.", suggestion: "export const get = (k) => cache.get(k);" }] });
  const e = env(pr());
  const out = await run(e, fetchFake);
  assert.deepEqual(out, { findings: 1, sha: C });
  const llm = calls.find((c) => c.url.includes("llm.test"))!;
  assert.equal(llm.body.model, "test-model");
  assert.deepEqual(llm.body.response_format, { type: "json_object" });
  assert.match(llm.body.messages[0].content, /Flag any Map misuse\./, "rules from the base branch");
  assert.ok(calls.some((c) => c.url.includes(`/contents/.github/review-rules.md?ref=${A}`)));
  assert.doesNotMatch(llm.body.messages[1].content, /pnpm-lock/, "lockfile left out");
  const review = calls.find((c) => c.url.endsWith("/pulls/5/reviews"))!;
  assert.equal(review.body.event, "COMMENT");
  assert.equal(review.body.commit_id, C);
  assert.deepEqual(review.body.comments.map((c: { path: string; line: number }) => [c.path, c.line]), [["src/cache.ts", 2]]);
  const status = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/5/comments"))!;
  assert.match(status.body.body, /reviewed `ccccccc` \(the whole pull request\): 1 finding, 1 high/);
  assert.match(status.body.body, /`pnpm-lock.yaml`: excluded/);
  assert.match(status.body.body, /test-model-1 · 1,000 tokens in, 200 out/);
  assert.equal(readState([{ id: 1, body: status.body.body, user: { login: "github-actions[bot]", type: "Bot" } }])?.state.reviewed, C);
  assert.match(readFileSync(e.GITHUB_OUTPUT!, "utf8"), /findings<<EOF_[\w-]+\n1\n/);
});

const statusFrom = (reviewed: string) => ({
  id: 42, user: { login: "github-actions[bot]", type: "Bot" },
  body: formatStatus({ state: { reviewed, rounds: [{ sha: reviewed, findings: 0, model: "m", at: "t" }] }, summary: "s", findings: [], inline: 0, unplaced: [], skipped: [], usage: null }),
});

test("after a push, only the new commits are reviewed and the status comment is edited", async () => {
  const { calls, fetchFake } = fakes({
    comments: [statusFrom(B)],
    compare: { status: "ahead", files: [{ filename: "src/cache.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -3,1 +3,2 @@\n export const get = (k) => cache[k];\n+export const set = (k, v) => cache.set(k, v);" }, { filename: "README.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" }] },
  });
  const out = await run(env(pr()), fetchFake);
  assert.deepEqual(out, { findings: 0, sha: C });
  const llm = calls.find((c) => c.url.includes("llm.test"))!;
  assert.match(llm.body.messages[1].content, /commits since the last review \(bbbbbbb\.\.ccccccc\)/);
  assert.doesNotMatch(llm.body.messages[1].content, /README/, "a file from merging the base branch isn't in the PR");
  assert.ok(!calls.some((c) => c.url.endsWith("/pulls/5/reviews")), "no findings, no review");
  const edit = calls.find((c) => c.method === "PATCH")!;
  assert.ok(edit.url.endsWith("/issues/comments/42"));
  assert.match(edit.body.body, /the commits since `bbbbbbb`\): no findings/);
});

test("an already reviewed commit is skipped; a force-push means a full review", async () => {
  const same = fakes({ comments: [statusFrom(C)] });
  assert.deepEqual(await run(env(pr()), same.fetchFake), { skipped: "ccccccc was already reviewed", sha: C });
  assert.ok(!same.calls.some((c) => c.url.includes("llm.test")));
  const forced = fakes({ comments: [statusFrom(B)], compare: { status: "diverged", files: [] } });
  await run(env(pr()), forced.fetchFake);
  assert.match(forced.calls.find((c) => c.url.includes("llm.test"))!.body.messages[1].content, /The whole pull request is shown/);
});

test("if GitHub rejects the inline comments, they move into the status comment", async () => {
  const { calls, fetchFake } = fakes({ reviewStatus: 422, findings: [{ file: "src/cache.ts", line: 2, severity: "high", title: "t", explanation: "Broken read." }] });
  await run(env(pr()), fetchFake);
  const status = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/5/comments"))!;
  assert.match(status.body.body, /Findings outside the diff[\s\S]*`src\/cache.ts:2` \*\*high\*\* t: Broken read\./);
});

test("model API: JSON mode is dropped if the provider rejects it; rate limits are retried", async () => {
  const bodies: any[] = [];
  let n = 0;
  const flaky: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    n++;
    if (n === 1) return json({ error: "response_format is not supported" }, 400);
    if (n === 2) return json({ error: "slow down" }, 429);
    return json({ choices: [{ message: { content: "{}" } }] });
  };
  const r = await chat({ baseUrl: "https://llm.test/v1/", apiKey: "sk-secret", model: "m", messages: [{ role: "user", content: "hi" }], fetch: flaky, backoff: [0, 0] });
  assert.equal(r.content, "{}");
  assert.equal(r.model, "m");
  assert.deepEqual(bodies.map((b) => "response_format" in b), [true, false, false]);
  const failing: typeof fetch = async () => json({ error: "bad key" }, 401);
  await assert.rejects(chat({ baseUrl: "https://llm.test/v1", apiKey: "sk-secret", model: "m", messages: [], fetch: failing, backoff: [] }), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes("sk-secret"));
});

test("plain http is refused except for localhost", async () => {
  const { fetchFake } = fakes({});
  await assert.rejects(run(env(pr(), { "INPUT_BASE-URL": "http://llm.example.com/v1" }), fetchFake), /must use https/);
});
