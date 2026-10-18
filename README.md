# pr-review-agent

A GitHub Action that reviews pull requests with an AI model. It works with any OpenAI-compatible API: GitHub Models
(the default, which needs no API key), OpenAI, OpenRouter, Groq, Mistral, Gemini, Claude through Anthropic's
OpenAI-compatible endpoint, or a model you host yourself.

- **Finds what matters:** bugs, security problems, broken error handling, performance traps and risky untested logic.
  It skips style; linters do that.
- **Incremental:** after a push it reviews only the new commits, so it doesn't repeat itself and costs less.
- **Rules per repository:** `.github/review-rules.md` tells it what your team cares about.
- **Comments where they belong:** findings become inline comments on the exact lines, with one-click suggestions where
  the fix is clear. One status comment, edited in place, holds the summary.
- **Never approves or blocks:** every review is a plain comment. People decide.
- **The model gets no tools:** the action reads the diff through the API and posts what the model returns, so a pull
  request can't make the model do anything.

No runtime dependencies: Node 24 and `fetch`.

## Quick start

Add `.github/workflows/review.yml`:

```yaml
name: review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write
  models: read # GitHub Models, with the workflow's own token

concurrency:
  group: review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: sushantn16/pr-review-agent@v1
```

That's all. It uses GitHub Models with `openai/gpt-4.1-mini` and the workflow's token, so there's no key to create.

## Use another model

Point `base-url` at any OpenAI-compatible API, and pass its key as a secret:

```yaml
      - uses: sushantn16/pr-review-agent@v1
        with:
          base-url: https://api.openai.com/v1
          api-key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-4.1
          price-input: "2"    # optional, USD per million tokens, to show each review's cost
          price-output: "8"
```

| Provider | `base-url` |
|---|---|
| GitHub Models (default) | `https://models.github.ai/inference` |
| OpenAI | `https://api.openai.com/v1` |
| Anthropic (Claude) | `https://api.anthropic.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Ollama, vLLM, LM Studio | e.g. `http://localhost:11434/v1`, on a self-hosted runner |

Use the model name exactly as your provider lists it. With your own key, drop `models: read` from the permissions.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `api-key` | the workflow token | Key for the model API |
| `base-url` | `https://models.github.ai/inference` | OpenAI-compatible API, without `/chat/completions` |
| `model` | `openai/gpt-4.1-mini` | Model name |
| `github-token` | the workflow token | Reads the pull request and posts the review |
| `rules-file` | `.github/review-rules.md` | Your review rules, read from the base branch |
| `trigger-label` | empty | Review only pull requests with this label |
| `max-findings` | `10` | The most inline comments per review |
| `max-diff-chars` | `20000` on GitHub Models, else `150000` | How much diff the model sees; the smallest files go first |
| `exclude` | empty | More globs to skip, separated by commas or new lines. Lockfiles, `dist/`, `build/`, `vendor/`, minified and generated files are always skipped |
| `review-bots` | `false` | Also review Dependabot, Renovate and other bot pull requests |
| `price-input`, `price-output` | empty | USD per million tokens, to show the cost |

Outputs: `findings` (count), `reviewed-sha`, and `skipped` (the reason, when nothing was reviewed).

## Review rules

`.github/review-rules.md` is plain text the model reads before every review, for example:

```markdown
- We use the Result type for errors; flag thrown exceptions in src/domain.
- Every SQL query goes through src/db/query.ts; flag string-built SQL anywhere else.
- Public API changes need a CHANGELOG entry.
```

It's read from the pull request's **base** branch, so a pull request can't rewrite the rules it's reviewed by.

## Review only on request

To review only when someone asks, set a label and listen for it:

```yaml
on:
  pull_request:
    types: [opened, synchronize, labeled]
...
      - uses: sushantn16/pr-review-agent@v1
        with:
          trigger-label: ai-review
```

Adding the label starts a review. After that, every push to a labelled pull request is reviewed, and adding any other
label does nothing. Adding the label again later reviews whatever is new since the last review.

## How it works

1. **Should it review?** Drafts, closed pull requests and bot pull requests are skipped, and so is anything without
   the trigger label, if you set one.
2. **What's new?** The status comment records the last reviewed commit. If that commit is still in the branch's
   history, only the commits since then are reviewed; after a force-push or rebase, the whole pull request is.
3. **What to show the model?** Each file's diff, with every line numbered as in the new version. Excluded files and
   binaries are left out. When the diff is over the size limit, the smallest files go in first, and the status comment
   lists what was skipped.
4. **The review.** The model gets your rules, the title, the description and the diff, and must answer with JSON: a
   summary and findings with file, line, severity and explanation. An answer that isn't valid JSON gets one retry. If
   a provider doesn't support JSON mode, the action asks without it.
5. **Posting.** A finding becomes an inline comment only if its line is in the diff, both what the model was shown and
   what GitHub accepts. Anything else goes into the status comment, so nothing is lost. The status comment is then
   updated with the summary, the files not reviewed, the model and token use, and earlier rounds.

## Security

- **The model can't act.** It has no tools and never sees a token or key; the action decides what to post, and only
  as comments on this pull request. A pull request that tries to steer the review ("ignore your instructions") can at
  worst produce a misleading comment, and the prompt tells the model to ignore such text.
- **Nothing from the pull request runs.** The action reads diffs through the API and never checks out or executes
  code. So `pull_request_target`, which also runs for pull requests from forks, is safe with this action alone.
  Don't add a checkout of the pull request's code to that workflow.
- **Least privilege.** It needs `contents: read`, `pull-requests: write`, and `models: read` for GitHub Models.
- The API key is masked in logs. A `base-url` must use https, except for `localhost`.
- The status comment is trusted only when a bot wrote it, so pasting its marker into a comment changes nothing.

## Limits

- The GitHub Models free tier caps a request at about 8,000 tokens, hence the 20,000-character diff limit. Large pull
  requests are reviewed in part; a paid provider removes the limit.
- The model sees the diff with 3 lines of context, not whole files, so it can miss problems that need wider context.
- Reviews use a GitHub App or workflow token. A personal access token works for posting, but its status comment isn't
  recognized on the next run, so every run is then a full review.

## Development

```sh
pnpm install
pnpm test        # offline: GitHub and the model API are faked
pnpm typecheck
```

The action runs `src/index.ts` directly on the runner's Node 24, so there's no build step and no `dist/`.

## License

MIT, see [LICENSE](LICENSE).
