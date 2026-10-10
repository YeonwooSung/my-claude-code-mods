# My Claude Code Mods

[Claude Code Mods Overview](https://code.claude.com/docs/ko/plugins/mods/overview)

[Create Claude Code Mods](https://code.claude.com/docs/ko/plugins/mods/create)

## Mods

- [agent-profiler](agent-profiler/README.md): shows where a session's time goes (model wait, tools, subagents, re-reads) and exports OTLP traces for Jaeger/Tempo.
- [context-inspector](context-inspector/README.md): analyzes context waste in Claude sessions, including what fills the window, re-reads, near-duplicate outputs, and what compaction kept, providing advice.
- [time-machine](time-machine/README.md): records every tool call on a branching timeline with shadow-git snapshots, so you can see the files as they were at any step, explain which edit broke a test, restore, branch, compare runs and re-run steps.
