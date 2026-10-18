// Turn GitHub's per-file patches into what the model reads (each line numbered as in the new file) and into the set of
// lines GitHub accepts inline comments on. Lockfiles, build output and generated files are left out.
import type { PrFile } from "./github.ts";

export interface Hunk {
  /** New-file line numbers of added and context lines, in order. */
  lines: number[];
}

export interface FileDiff {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  /** The patch with new-file line numbers, as the model sees it. */
  numbered: string;
}

/** Parse a unified diff patch. Removed lines get no number: comments can only go on lines of the new version. */
export function parsePatch(patch: string): { hunks: Hunk[]; numbered: string } {
  const hunks: Hunk[] = [];
  const out: string[] = [];
  let line = 0;
  let hunk: Hunk | null = null;
  for (const raw of patch.split("\n")) {
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      line = Number(header[1]);
      hunk = { lines: [] };
      hunks.push(hunk);
      out.push(raw);
      continue;
    }
    if (!hunk || raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "-") out.push(`${"".padStart(5)} - ${text}`);
    else {
      hunk.lines.push(line);
      out.push(`${String(line).padStart(5)} ${mark === "+" ? "+" : " "} ${text}`);
      line++;
    }
  }
  return { hunks, numbered: out.join("\n") };
}

const BUILT_IN_EXCLUDES = [
  "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/bun.lockb", "**/*.lock", "**/go.sum", "**/poetry.lock",
  "**/Cargo.lock", "**/composer.lock", "**/Gemfile.lock", "**/dist/**", "**/build/**", "**/vendor/**", "**/node_modules/**",
  "**/*.min.js", "**/*.min.css", "**/*.map", "**/*.snap", "**/*.generated.*", "**/*.pb.go", "**/__generated__/**",
];

/** A glob as a regex: `**` crosses directories, `*` and `?` don't. A pattern without a slash matches at any depth. */
export function globToRegex(glob: string): RegExp {
  const g = glob.includes("/") ? glob.replace(/^\/+/, "") : `**/${glob}`;
  let rx = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      rx += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") rx += "[^/]*";
    else if (c === "?") rx += "[^/]";
    else rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`);
}

export const excluder = (extra: string) => {
  const patterns = [...BUILT_IN_EXCLUDES, ...extra.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)].map(globToRegex);
  return (path: string) => patterns.some((rx) => rx.test(path));
};

export interface Selection {
  files: FileDiff[];
  /** Files left out, and why: excluded, no patch (binary or too large), or over the size budget. */
  skipped: { path: string; reason: string }[];
}

/**
 * Pick the files to review within `maxChars` of numbered diff. Smaller changes go first, so one huge file can't crowd
 * out the rest; the result keeps the pull request's own file order.
 */
export function selectFiles(files: PrFile[], isExcluded: (path: string) => boolean, maxChars: number): Selection {
  const skipped: Selection["skipped"] = [];
  const candidates: FileDiff[] = [];
  for (const f of files) {
    if (f.status === "removed") continue;
    if (isExcluded(f.filename)) skipped.push({ path: f.filename, reason: "excluded" });
    else if (!f.patch) skipped.push({ path: f.filename, reason: "no text diff (binary or too large)" });
    else {
      const { hunks, numbered } = parsePatch(f.patch);
      candidates.push({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, hunks, numbered });
    }
  }
  const chosen = new Set<FileDiff>();
  let used = 0;
  for (const f of [...candidates].sort((a, b) => a.numbered.length - b.numbered.length)) {
    if (used + f.numbered.length > maxChars) skipped.push({ path: f.path, reason: "over the diff size limit" });
    else (chosen.add(f), (used += f.numbered.length));
  }
  return { files: candidates.filter((f) => chosen.has(f)), skipped };
}

/** Lines GitHub accepts an inline comment on, per file: added and context lines of the pull request's diff. */
export function commentableLines(files: PrFile[]): Map<string, Hunk[]> {
  const map = new Map<string, Hunk[]>();
  for (const f of files) if (f.patch) map.set(f.filename, parsePatch(f.patch).hunks);
  return map;
}

/** Whether lines `start`..`end` of `path` can carry one comment: both ends in the same hunk of the diff. */
export function canComment(map: Map<string, Hunk[]>, path: string, start: number, end: number): boolean {
  return (map.get(path) ?? []).some((h) => h.lines.includes(start) && h.lines.includes(end));
}
