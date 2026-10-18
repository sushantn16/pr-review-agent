// A small GitHub REST client over fetch: only the calls a review needs. The API URL comes from the runner, so GitHub
// Enterprise Server works too.

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff of the file; missing for binary files and very large diffs. */
  patch?: string;
}

export interface IssueComment {
  id: number;
  body?: string;
  user: { login: string; type: string } | null;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  readonly api: string;
  readonly repo: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(opts: { api: string; repo: string; token: string; fetch?: typeof fetch }) {
    this.api = opts.api.replace(/\/+$/, "");
    this.repo = opts.repo;
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
  }

  async #request<T>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<{ data: T; link: string | null }> {
    const res = await this.#fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "pr-review-agent",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = (accept.endsWith("raw") ? await res.text() : res.status === 204 ? null : await res.json()) as T;
    return { data, link: res.headers.get("link") };
  }

  async #paginate<T>(path: string, max = 3000): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next && out.length < max) {
      const page: { data: T[]; link: string | null } = await this.#request<T[]>("GET", next);
      out.push(...page.data);
      const url: string | undefined = page.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      next = url ? url.slice(this.api.length) : null;
    }
    return out;
  }

  pullFiles(pr: number): Promise<PrFile[]> {
    return this.#paginate<PrFile>(`/repos/${this.repo}/pulls/${pr}/files`);
  }

  /** Files changed between two commits, and whether `base` is an ancestor of `head` ("ahead") or not. */
  async compare(base: string, head: string): Promise<{ status: string; files: PrFile[] }> {
    const { data } = await this.#request<{ status: string; files?: PrFile[] }>("GET", `/repos/${this.repo}/compare/${base}...${head}`);
    return { status: data.status, files: data.files ?? [] };
  }

  /** A file's text at a commit, or null if it doesn't exist there. */
  async fileAt(path: string, ref: string): Promise<string | null> {
    try {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      return (await this.#request<string>("GET", `/repos/${this.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, undefined, "application/vnd.github.raw")).data;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  issueComments(pr: number): Promise<IssueComment[]> {
    return this.#paginate<IssueComment>(`/repos/${this.repo}/issues/${pr}/comments`);
  }

  async createIssueComment(pr: number, body: string): Promise<void> {
    await this.#request("POST", `/repos/${this.repo}/issues/${pr}/comments`, { body });
  }

  async updateIssueComment(id: number, body: string): Promise<void> {
    await this.#request("PATCH", `/repos/${this.repo}/issues/comments/${id}`, { body });
  }

  /** A review with inline comments. Always COMMENT: a bot never approves or blocks a pull request. */
  async createReview(pr: number, commitId: string, body: string, comments: ReviewComment[]): Promise<void> {
    await this.#request("POST", `/repos/${this.repo}/pulls/${pr}/reviews`, { commit_id: commitId, event: "COMMENT", body, comments });
  }
}
