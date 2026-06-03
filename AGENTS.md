## Agent skills

### Subagent usage
Prevent that subagent output gets cut off by imposing strict output limits:

1. **Max output length**: Tell subagents to limit their response to 2000 characters max. Subagents produce large outputs, main thread cannot read them all. Use caveman skill for concise reporting — no filler, no verbose summaries, just raw findings in fragments.
2. **Targeted prompts**: Only ask subagents about the specific files/modules relevant to the current task. Do NOT launch 5 broad subagents scanning everything at once — use targeted queries per file or pattern group.
3. **One subagent at a time for deep dives**: When needing detailed understanding of one component, use ONE focused subagent instead of many overlapping ones.
4. **Direct file reads first**: Before launching any subagent, read the files directly when possible. Subagents add overhead and risk truncation. Only use subagents for parallel exploration of multiple unrelated areas.

Example prompt template:
```
Explore [specific file/module]. Return findings in caveman style (no filler). Max 5000 chars — just raw facts: what exists, how it works, key patterns. No summaries, no conclusions, no "in conclusion" paragraphs.
```

### Issue tracker
Issues and PRDs live as GitHub Issues in this repo's GitHub repository. See `docs/agents/issue-tracker.md`.
Use MCP to interact with github issues as much as possible.

### Triage labels
Five default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs
Single-context repo: one `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.

### Repository github info
The master branch is called: main