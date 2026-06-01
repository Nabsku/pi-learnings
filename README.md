# pi-learning-loop

Approval-gated learning loop for Pi.

`/learn` turns a concrete Pi mistake into a proposed durable rule. It drafts first, shows the target and proposed text, and only writes after explicit approval.

## Commands

```text
/learn pick
/learn review
/learn note <what went wrong>
/learn draft <id>
/learn show <id>
/learn pending
/learn approve <id>
/learn reject <id> [reason]
```

`/learn pick` is the preferred interactive path. It opens only when invoked, lets you select a recent turn with longer evidence previews, asks for a short issue description plus optional future behavior, then creates a pending draft. It never writes `AGENTS.md`; approval still happens via `/learn approve <id>` or the `/learn review` draft picker.

`/learn note <what went wrong>` is the quick-capture path. It classifies and drafts immediately, then sends you to `/learn review` for approval.

`/learn review` opens pending drafts, shows a compact picker, then opens the full draft/source context in a scrollable editor before asking to approve, reject, or cancel.

## Config

Config is created automatically when the plugin loads. It writes `.pi/learning-loop.json`:

```json
{
  "version": 1,
  "learningsDir": ".pi/learnings",
  "repoAgentsPath": "AGENTS.md",
  "maxExcerptChars": 4000,
  "modelOverrides": {
    "draftRule": {
      "model": "openai-codex/gpt-5.5",
      "thinkingLevel": "medium"
    },
    "classifyIssue": {
      "model": "openai-codex/gpt-5.4-mini",
      "thinkingLevel": "minimal"
    }
  }
}
```

Fields:

- `learningsDir`: repo-relative directory for pending/applied/rejected learning records.
- `repoAgentsPath`: repo-relative file that approved repo-local rules are written to.
- `maxExcerptChars`: maximum stored source excerpt length.
- `modelOverrides`: per-operation model preferences for model-backed learning steps. `classifyIssue` is used when creating records from `/learn note`, `/learn pick`, or `learning_mark_issue`; `draftRule` is used by `/learn draft`, `/learn pick`, and `learning_draft_rule`. If the configured model cannot be resolved/authenticated or returns invalid JSON, the plugin falls back to deterministic local heuristics.

Unsafe paths that escape the repo are ignored and fall back to defaults.

## Safety model

- No silent writes to `AGENTS.md`.
- Repo-local learning artifacts live under `.pi/learnings/` by default.
- Approved repo rules are inserted under `## Agent Learnings` in the configured repo agents file.
- Global Pi files are intentionally not implemented yet.
- Raw transcript excerpts should stay bounded and should not be copied into durable rules.
