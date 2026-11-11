---
name: ui-mocks
description: Show a person what a screen will look like before it is built — mock one or several options of a new or reshaped interface as HTML with real data, open it for them to click, and capture it with browsin. Use whenever a screen is being designed or reshaped and its shape is still open (a spec, a brainstorm, a proposal, "como ficaria essa tela?", "mocka isso", "me mostra opções de layout"), before the real UI code is written.
---

# ui-mocks: see the interface before it is built

A screen approved as text gets built; the person sees it and asks for another shape: the table becomes a
kanban, the detail moves into a side panel. Each of those decisions is cheaper before the code. A mock
puts the screen in front of the person while the design is still open.

This is judgment, not a fixed step: decide per case whether a mock helps, how many options, and how
faithful it has to be.

## When

- A new screen, or a change to a screen's shape (layout, grouping, what is clickable, where the detail
  lives) while it is still being decided: a spec, a brainstorm, a proposal.
- Not for a copy change, a bug fix or a tweak inside the current shape: there the real page is the mock.

## What a good mock is

- **Only the screen in scope.** Copy the app's real chrome (header shape, colours, fonts) from its code or
  from a screenshot of the running app. Leave the global navigation out, or draw it as a neutral grey band
  without labels: everything visible in a mock reads as a proposal, and an invented menu looks like a
  change to the whole app.
- **Real data, read before.** Fill it with real rows from a query or a file you saved, never invented
  names or numbers. Fake data hides what breaks a layout (a long name, 40 rows, an empty column). The rows
  may be production data: keep the mock local; putting it anywhere else (an Artifact, Slack, an MR) is the
  person's call.
- **Open the fan when the shape is not obvious.** Two or three genuinely different shapes (a table, a
  kanban, cards grouped by owner), not colour variants of one. One mock when the shape is obvious.
- **The interaction the decision hangs on works.** If the question is "what happens on click", the click
  works (a fixed detail panel, a toggled class); the rest can stay static.
- **Fidelity follows the purpose.** Brainstorming options: plain self-contained HTML, cheap to throw away.
  The chosen shape, when the repo says how: the app's own components with fixed data. The repo's rules
  (`AGENTS.md`, `CLAUDE.md`, `agent/rules/`) win over this skill.

## Build it and show it

Keep the mock outside the app's code: in the task folder (an `/amp:dev` task:
`.dev-agent/tasks/<id>/mock/`) or a scratch folder, one HTML file per option, self-contained (inline CSS,
no build step). It is not committed to the app unless the repo says so.

```bash
browsin viewport desktop                   # or the width the app is used at
browsin check mock/kanban.html             # a file path works: problems + a screenshot
browsin text                               # does it say what it should? cheaper than pixels
browsin snap --name kanban                 # the picture: for you to check, and for the record
browsin viewport iphone && browsin snap --name kanban-narrow   # only if the screen is used narrow
open mock/kanban.html                      # macOS: the person clicks it in their own browser
browsin down
```

The person decides on the live mock, in their own browser, not on a description of it. The screenshot is
optional: it lets you check what you built, and it is the record (by path and sha256; never paste an image
with real data where others read it). With several options, say in one line what each one favours.

## After

- Iterate in the conversation: the mock is not a contract, and changing it costs minutes.
- When the person picks a shape, record the choice in their words where the decision lives (the spec, the
  issue), with the mock's path.
- When the real screen exists, compare it with the mock once, by eye. A difference is a question for the
  person, not a failure.
