# Model Effort Band

A colored band directly above the Claude Code prompt shows the selected model and the effort observed on the latest main-conversation request.

```text
╭────────────────────────────────────────────────────────────╮
│ Haiku 4.5 │ effort ▰▱▱▱▱ low · 빠르게                Haiku │
╰────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────╮
│ Sonnet 4.6 │ effort ▰▰▱▱▱ medium · 보통             Sonnet │
╰────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────╮
│ Opus 4.6 │ effort ▰▰▰▱▱ high · 깊게                  Opus │
╰────────────────────────────────────────────────────────────╯
```

These are text illustrations of three themes; one band appears at a time. Haiku uses green, Sonnet blue, Opus purple. Displayed versions come from the model ID, so an alias such as `opus` displays `Opus` without inventing a version. Unknown/custom model names use a neutral theme.

## Install

```text
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install model-effort-band@my-claude-code-mods
```

Or load the directory for one session from this repository:

```sh
claude --plugin-dir ./model-effort-band
```

Mods load by default starting with Claude Code 2.1.287. This mod's event and render API combination is tested with **2.1.292**. Update an older CLI before loading it. Disable the mod through `/plugin` when you want to hide the band; there are no extra commands or settings.

## What the effort means

- `low`, `medium`, `high`, `xhigh`, `max` fill one through five gauge cells. The Korean captions describe effort, not measured speed or answer quality.
- The selected model is read on every render. Effort comes only from a main `turn.step` observed by this mod. No defaults are guessed from model family or settings.
- Before a request, after a new turn/session/reload, or after model/settings changes, effort displays `unknown` until observed again. Any successful configuration change clears observation; so does `/model`, `/effort`, or `/config`, including a cancelled picker.
- If the request's model differs from the selected model, effort stays `unknown`. This includes alias/resolved-ID mismatches and request fallbacks. This band shows the **selected model**, not a history of actual request models.
- Subagent requests cannot replace main-conversation effort. Missing effort clears the old value. Numeric effort is shown literally without a gauge; future effort strings are shown safely without interpretation.
- The observed request is the value at this mod's hook position. A later mod can still rewrite the request; the band does not verify that later rewrite.

## Layout and surfaces

The band has a rounded border, model label on the left, effort beside it, and a family badge at the right. At fewer than 60 columns it omits the gauge, caption, and badge. Below 30 columns or with fewer than three available rows it uses one unbordered line. Text truncates rather than wrapping. A survey takes precedence and hides the band. Other mods' `AbovePrompt` content is preserved before this band; the engine manages scrolling of combined content.

Terminal and Desktop support the render site. VS Code chat and headless mode have no visual band. There are no model requests, prompt changes, file writes, network calls, polling timers, or persistent state in this mod.

## Development and verification

From the repository root:

```sh
npm test
CLAUDE_BIN=/path/to/claude-2.1.292 npm run test:adapters
npm run typecheck
/path/to/claude-2.1.292 plugin validate model-effort-band
```

Typecheck requires the local engine-generated `.claude-plugin/types` declarations, as with the other mods. If using this repository's existing 2.1.292 declarations, copy them from `agent-profiler/.claude-plugin/types` to this mod's `.claude-plugin/types`; declarations remain ignored by Git.

Tests cover normalization, state lifetime, stream chunks and final return values, settings denial, model-lookup and invalidation failures, surveys, model themes, and compact layouts. Terminal and Desktop **render trees** are tested; live terminal pixels and the Desktop app have not been visually verified. A live terminal check stopped at the engine's workspace trust prompt without changing trust settings.
