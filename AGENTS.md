## Agent skills

### Issue tracker

Issues and PRDs live as GitHub Issues in this repo's GitHub repository. See `docs/agents/issue-tracker.md`.

**CRITICAL — never inline `gh issue comment` bodies in shell commands.** Multi-line markdown breaks in PowerShell. Always write the body to a temp `.md` file first, then pass it via `--body-file`:

```bash
# WRONG: gh issue comment 42 --body "## text..."
# RIGHT:
# 1. Write body to docs/temp/issue-comment.md
# 2. gh issue comment 42 --repo timvangestel-coder/pushtotalkv1 --body-file docs/temp/issue-comment.md
```

### Triage labels

Five default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: one `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.