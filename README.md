# pi-collapse-work

Folds everything the agent does between your prompt and its answer into one line, so the transcript reads as prompt, work summary, answer:

```
 first question please

 Working... 3 tool calls, 3.2s

 All done. The config now loads from ~/.pi/agent.
```

While the agent works, the line ticks live: `Working... 1 tool call, 2.5s`. Nothing the agent streams on the way, such as interim text, thinking or tool rows, is shown until it finishes. Then the line freezes and the final answer appears under it.

The time runs from when you sent the prompt to the end of the final answer. The count covers top-level tool calls, so a codemode or batch call counts once.

## Ctrl+O

Ctrl+O (or whatever `app.tools.expand` is bound to) cycles three views:

| Press | View |
| --- | --- |
| default | Folded: prompt, `Working...` line, answer |
| 1st | Pi's normal transcript with tool output collapsed |
| 2nd | Pi's normal transcript with tool output expanded |
| 3rd | Folded again |

The status line under the transcript names the view you switched to. In dialogs, selectors and `/tree`, Ctrl+O keeps its usual meaning.

## What stays visible when folded

- Your prompts, including skill blocks.
- The final answer, without its thinking blocks.
- Errors, aborts, warnings, status lines, compaction and branch summaries, custom messages and `!` command output.

An exchange that ended on a tool call (for example, interrupted before the agent answered) shows only its `Working...` line. Press Ctrl+O to see what ran.

## How it works

Pi has no API for hiding transcript entries, so the extension:

1. takes pi's TUI from a widget factory and finds the chat container in pi's document;
2. replaces that container's `render()` with a folded view of its children, leaving the children themselves untouched;
3. listens to raw terminal input for Ctrl+O while the main editor has focus, because extensions cannot register that shortcut, and switches pi's tool expansion with `ctx.ui.setToolsExpanded()`.

Times for past exchanges come from the session file, so they survive `/reload` and resuming a session. If pi changes its interactive layout and the chat container can't be found, the extension shows a warning once and leaves the transcript alone.

## Development

```bash
pi -e ./index.ts
```

Tests need `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` resolvable from this folder (symlink them into `node_modules/` or install them):

```bash
npm test
```
