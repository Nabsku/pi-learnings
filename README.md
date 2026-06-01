# pi-learnings

Approval-gated learning capture for Pi.

`/learn` turns a concrete Pi mistake into a proposed durable rule. It drafts first, shows the target and proposed text, and only writes after explicit approval.

## Commands

```text
/learn
/learn note <what went wrong>
```

`/learn` is the primary workflow. It opens a TUI menu for capturing from a recent turn, reviewing pending drafts, browsing learnings, or writing a quick note. IDs and direct approve/reject commands are fallback details, not the normal path.

`/learn note <what went wrong>` is the quick-capture path. It classifies and drafts immediately. In UI mode it offers `Review now` or `Keep pending`; in non-UI mode it prints the captured ID and sends you back to `/learn`. It creates a pending learning and proposed rule only; no repo rule is applied until TUI review approval or `/learn approve <id> --confirm`.

Advanced fallback commands remain available for scripts or broken/non-interactive UI:

```text
/learn review
/learn pending
/learn show <id>
/learn draft <id>
/learn approve <id> --confirm
/learn reject <id> [reason]
```

## Config

Config is created automatically when the plugin loads. The only supported config path is `.pi/learnings.json`:

```json
{
  "version": 1,
  "learningsDir": ".pi/learnings",
  "repoAgentsPath": "AGENTS.md",
  "globalAgentsPath": "~/.pi/agent/AGENTS.md",
  "globalSystemPath": "~/.pi/agent/APPEND_SYSTEM.md",
  "maxExcerptChars": 4000,
  "modelOverrides": {
    "draftRule": {
      "model": "provider/model-id",
      "thinkingLevel": "minimal"
    },
    "classifyIssue": {
      "model": "provider/model-id",
      "thinkingLevel": "minimal"
    }
  }
}
```

Schema:

- `version`: must be `1`.
- `learningsDir`: repo-relative directory for pending/applied/rejected learning records. Default: `.pi/learnings`.
- `repoAgentsPath`: repo-relative file that approved repo-local rules are written to. Default: `AGENTS.md`.
- `globalAgentsPath`: exact global Pi `AGENTS.md` path allowed for explicit global-rule approval. Default: `~/.pi/agent/AGENTS.md`.
- `globalSystemPath`: exact global Pi `APPEND_SYSTEM.md` path allowed for explicit global-system approval. Default: `~/.pi/agent/APPEND_SYSTEM.md`.
- `maxExcerptChars`: maximum stored source excerpt length. Default: `4000`.
- `modelOverrides`: optional per-operation model preferences for model-backed learning steps. Use `{}` to use the user's normal Pi/default model path.
- `modelOverrides.draftRule`: optional model settings for `/learn draft`, `/learn pick`, and `learning_draft_rule`.
- `modelOverrides.classifyIssue`: optional model settings for `/learn note`, `/learn pick`, and `learning_mark_issue`.
- `modelOverrides.*.model`: optional model reference in the format Pi's model registry accepts, for example `openai-codex/gpt-5.5`.
- `modelOverrides.*.thinkingLevel`: optional reasoning level. Allowed values: `minimal`, `low`, `medium`, `high`, `xhigh`.

If a configured model cannot be resolved/authenticated or returns invalid JSON, the plugin falls back to deterministic local heuristics. Unsafe repo paths that escape the repo are ignored and fall back to defaults. Global Pi paths are only accepted when they resolve to the configured `~/.pi/agent/...` files.

Examples:

Example: default config using the current Pi model

```json
{
  "version": 1,
  "learningsDir": ".pi/learnings",
  "repoAgentsPath": "AGENTS.md",
  "globalAgentsPath": "~/.pi/agent/AGENTS.md",
  "globalSystemPath": "~/.pi/agent/APPEND_SYSTEM.md",
  "maxExcerptChars": 4000,
  "modelOverrides": {}
}
```

Example: repo-local rules file

```json
{
  "version": 1,
  "learningsDir": ".pi/learnings",
  "repoAgentsPath": "docs/AGENTS.md",
  "globalAgentsPath": "~/.pi/agent/AGENTS.md",
  "globalSystemPath": "~/.pi/agent/APPEND_SYSTEM.md",
  "maxExcerptChars": 4000,
  "modelOverrides": {}
}
```

Example: explicit model overrides

```json
{
  "version": 1,
  "learningsDir": ".pi/learnings",
  "repoAgentsPath": "AGENTS.md",
  "globalAgentsPath": "~/.pi/agent/AGENTS.md",
  "globalSystemPath": "~/.pi/agent/APPEND_SYSTEM.md",
  "maxExcerptChars": 4000,
  "modelOverrides": {
    "draftRule": {
      "model": "openai-codex/gpt-5.5",
      "thinkingLevel": "high"
    },
    "classifyIssue": {
      "model": "openai-codex/gpt-5.4-mini",
      "thinkingLevel": "minimal"
    }
  }
}
```

## Files touched

- Creates `.pi/learnings.json` during plugin resource discovery if no config exists.
- Creates learning records under `.pi/learnings/` by default.
- Writes approved repo-local rules to the configured repo agents file, default `AGENTS.md`.
- Writes global Pi files only through explicit global approval.

## Tool surface

Registered tools are capture/draft/list only:

```text
learning_mark_issue
learning_draft_rule
learning_list
```

There is intentionally no apply/write tool. Applying a rule requires the TUI review flow or slash-command confirmation.

## Safety model

- No silent writes to the configured repo agents file; direct CLI approval requires `--confirm`.
- Global Pi writes target only configured `~/.pi/agent/AGENTS.md` / `APPEND_SYSTEM.md` paths and require explicit TUI confirmation or CLI `--confirm-global`.
- Repo-local learning artifacts live under `.pi/learnings/` by default.
- Approved repo rules are inserted under `## Agent Learnings` in the configured repo agents file.
- Global Pi files require explicit global approval and are never written by normal repo approval.
- Raw transcript excerpts should stay bounded and should not be copied into durable rules.
