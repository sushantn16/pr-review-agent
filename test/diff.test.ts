import { test } from "node:test";
import assert from "node:assert/strict";
import { canComment, commentableLines, excluder, globToRegex, parsePatch, selectFiles } from "../src/diff.ts";

const patch = ["@@ -1,3 +1,4 @@", " import x from 'x';", "-const a = 1;", "+const a = 2;", "+const b = 3;", " export { a };", "@@ -20,2 +21,2 @@ function f() {", "-  return 1;", "+  return 2;", " }", "\\ No newline at end of file"].join("\n");

test("patch lines are numbered as in the new file; removed lines get no number", () => {
  const { hunks, numbered } = parsePatch(patch);
  assert.deepEqual(hunks.map((h) => h.lines), [[1, 2, 3, 4], [21, 22]]);
  assert.equal(numbered.split("\n")[1], "    1   import x from 'x';");
  assert.equal(numbered.split("\n")[2], "      - const a = 1;");
  assert.equal(numbered.split("\n")[3], "    2 + const a = 2;");
  assert.ok(!numbered.includes("No newline"));
});

test("globs: ** crosses directories, a pattern without a slash matches at any depth", () => {
  assert.ok(globToRegex("**/dist/**").test("packages/web/dist/app.js"));
  assert.ok(globToRegex("**/dist/**").test("dist/app.js"));
  assert.ok(globToRegex("*.snap").test("src/__snapshots__/a.test.ts.snap"));
  assert.ok(!globToRegex("src/*.ts").test("src/deep/a.ts"));
  assert.ok(globToRegex("src/**/*.ts").test("src/deep/a.ts"));
  const skip = excluder("docs/**, *.svg");
  assert.ok(skip("pnpm-lock.yaml") && skip("web/package-lock.json") && skip("docs/a.md") && skip("img/logo.svg"));
  assert.ok(!skip("src/index.ts"));
});

test("selection skips excluded, binary and over-budget files, smallest first, PR order kept", () => {
  const file = (filename: string, lines: number) => ({ filename, status: "modified", additions: lines, deletions: 0, patch: `@@ -1,0 +1,${lines} @@\n${"+x\n".repeat(lines).trimEnd()}` });
  const s = selectFiles([file("big.ts", 400), { filename: "logo.png", status: "added", additions: 0, deletions: 0 }, file("small.ts", 3), file("yarn.lock", 5), { ...file("gone.ts", 2), status: "removed" }, file("mid.ts", 20)], excluder(""), 1000);
  assert.deepEqual(s.files.map((f) => f.path), ["small.ts", "mid.ts"]);
  assert.deepEqual(s.skipped, [
    { path: "logo.png", reason: "no text diff (binary or too large)" },
    { path: "yarn.lock", reason: "excluded" },
    { path: "big.ts", reason: "over the diff size limit" },
  ]);
});

test("a comment range must sit inside one hunk of the diff", () => {
  const map = commentableLines([{ filename: "a.ts", status: "modified", additions: 3, deletions: 2, patch }]);
  assert.ok(canComment(map, "a.ts", 2, 3));
  assert.ok(!canComment(map, "a.ts", 3, 21), "spans two hunks");
  assert.ok(!canComment(map, "a.ts", 10, 10), "not in the diff");
  assert.ok(!canComment(map, "b.ts", 1, 1));
});
