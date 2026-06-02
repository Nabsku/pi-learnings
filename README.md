# pi-learnings

Teach Pi from the mistakes it actually made.

`/learn` turns a concrete bad agent turn into a proposed rule. It does not quietly mutate your repo, rewrite global prompts, or let a model bless its own homework. It drafts. You review. Then you approve or reject.

Good for stuff like:

```text
Claimed tests passed without running the test command
Used stale log output as evidence
Edited the wrong AGENTS.md
```

The point is simple: capture the lesson while the evidence is fresh, but keep durable instructions under human control.

## Install

Install the plugin in Pi:

```text
pi install git:github.com/Nabsku/pi-learnings
/reload
```

Then record a mistake:

```text
/learn note Claimed tests passed without running the test command
```

Review it:

```text
/learn
```

The TUI shows the proposed rule, the target file, and the evidence. Edit the draft if needed. Approve it only if it deserves to become instruction.

## What it writes

By default, the plugin creates these files in the current repo:

```text
.pi/learnings.json
.pi/learnings/pending/<id>.json
.pi/learnings/applied/<id>.json
.pi/learnings/rejected/<id>.json
```

Approved repo-local rules go into `AGENTS.md` under:

```text
## Agent Learnings
```

You can point repo-local rules somewhere else with `repoAgentsPath`.

## The workflow

### `/learn`

The main flow. Opens the TUI for:

- picking a recent suspicious turn
- reviewing pending drafts
- browsing past learnings
- writing a quick note

Use this most of the time.

### `/learn note <what went wrong>`

Fast capture. It classifies the issue and drafts a rule immediately.

In UI mode, it offers:

```text
Review now
Keep pending
```

In non-UI mode, it prints the captured ID and sends you back to `/learn`.

It does not apply the rule. It only creates a pending learning.

### Fallback commands

Useful for scripts, broken terminals, or non-interactive sessions:

```text
/learn review
/learn pending
/learn show <id>
/learn draft <id>
/learn approve <id> --confirm
/learn reject <id> [reason]
```

## Config

Config is created automatically when the plugin loads. The supported config file is:

```text
.pi/learnings.json
```

Default shape:

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

Fields:

- `version`: must be `1`.
- `learningsDir`: repo-relative directory for pending, applied, and rejected learning records. Default: `.pi/learnings`.
- `repoAgentsPath`: repo-relative file for approved repo-local rules. Default: `AGENTS.md`.
- `globalAgentsPath`: exact global Pi `AGENTS.md` path allowed for global rule approval. Default: `~/.pi/agent/AGENTS.md`.
- `globalSystemPath`: exact global Pi `APPEND_SYSTEM.md` path allowed for global system approval. Default: `~/.pi/agent/APPEND_SYSTEM.md`.
- `maxExcerptChars`: maximum stored source excerpt length. Default: `4000`.
- `modelOverrides`: optional per-operation model preferences. Use `{}` to use Pi's normal model path.
- `modelOverrides.draftRule`: optional model settings for `/learn draft`, `/learn pick`, and `learning_draft_rule`.
- `modelOverrides.classifyIssue`: optional model settings for `/learn note`, `/learn pick`, and `learning_mark_issue`.
- `modelOverrides.*.model`: model reference in the format Pi accepts, for example `openai-codex/gpt-5.5`.
- `modelOverrides.*.thinkingLevel`: optional reasoning level: `minimal`, `low`, `medium`, `high`, or `xhigh`.

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

If a configured model cannot be resolved, cannot authenticate, or returns invalid JSON, the plugin falls back to deterministic local heuristics. Repo paths that escape the repo are ignored and replaced with safe defaults. Global Pi paths are only accepted when they resolve to the configured `~/.pi/agent/...` files.

## Why the review gate exists

Agents are good at spotting patterns. They are also very good at writing confident nonsense.

So the plugin lets the model help with the boring parts: classification, summaries, and draft rules. It does not let the model apply those rules. That line matters.

The safety contract:

- Model output is draft-only.
- Registered tools can capture, draft, and list. They cannot apply.
- Repo-local writes need TUI approval or `/learn approve <id> --confirm`.
- Global Pi writes need an explicit global target plus `/learn approve <id> --confirm-global` or TUI confirmation.
- Global writes are constrained to the configured `~/.pi/agent/AGENTS.md` and `~/.pi/agent/APPEND_SYSTEM.md` paths.
- Repo paths must stay inside the repo.
- Raw transcript excerpts are bounded by `maxExcerptChars` and should not be copied into durable rules.

## Tool surface

The plugin registers three tools:

```text
learning_mark_issue
learning_draft_rule
learning_list
```

There is no apply/write tool. Applying a rule requires review plus explicit approval.

## Files touched

- Creates `.pi/learnings.json` during plugin resource discovery if no config exists.
- Creates learning records under `.pi/learnings/` by default.
- Writes approved repo-local rules to the configured repo agents file, default `AGENTS.md`.
- Writes global Pi files only after explicit global approval.

## Tiny philosophy

Durable memory is powerful. Bad durable memory is a footgun with a calendar invite.

`pi-learnings` tries to keep the useful part: "we just saw the agent mess this up, let's write down the lesson" while avoiding the awful part: agents silently filling your instruction files with vibes, duplicates, and overbroad rules.

Make the lesson specific. Keep the evidence close. Approve the final wording yourself.
