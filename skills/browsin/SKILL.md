---
name: browsin
description: See and drive a web page from the terminal with browsin — screenshot, PDF, DOM, console, network, click, upload and download in a headless Chromium with a throwaway profile. Use whenever a task needs visual feedback (dev server, prototype, proposal, slide, landing page), DOM or console-error inspection, or driving an interface.
---

# browsin

A headless browser CLI for coding agents. Plain Node, **zero dependencies**: it starts a
`chrome-headless-shell` with a throwaway profile in `/tmp/browsin/<session>`. One session per agent:
inside pi this is automatic (`PI_SESSION_ID`), so two agents never share a tab. (A caller that already
passes a `BROWSIN_DIR`, such as the pi kit, owns that namespace and stays in the `default` session, in
the flat layout.)

If `browsin` is not on PATH, install it with `scripts/setup.sh` in a checkout of
[browsin](https://gitlab.com/super-company-git/game-tools/browsin). `browsin doctor` shows what is in use.

**It never uses the user's Chrome profile.** By default it runs the headless shell, which has no UI
layer: it does not appear on their screen, does not see their cookies, does not open a window. When
the Chrome for Testing builds are missing it falls back to an installed Google Chrome or Chromium,
still on its own profile, and `browsin doctor` warns about it. That isolation is why the tool exists.

## Start with text, not pixels

This is the rule that saves the most, day to day:

```bash
browsin check localhost:5173 --wait 'document.querySelector("#root")?.children.length > 0'
browsin snapshot        # the whole screen in ~250 tokens, with actionable selectors
```

`snapshot` answers "what is on the screen?" by listing every control with a selector that `click` and
`type` accept back. A screenshot costs ~1500 tokens and answers worse — **ask for pixels only when
the question is aesthetic** (spacing, colour, alignment, "does it look bad?").

`snap` defaults to **1x and the viewport** on purpose: `2560x1600` costs 8x the tokens of
`1280x800`. Use `--clip '<CSS selector>'` to crop to the component under discussion.

## Commands

```bash
# navigate and diagnose
browsin check <url|file>         # navigate + problems + network + screenshot, one call
browsin open <url|file> · browsin reload [--hard] · browsin back
browsin logs [--all]             # console, exceptions, rejections, 4xx/5xx, failed resources
browsin network [url]            # every request with its status, at protocol level

# understand
browsin snapshot [--onscreen] [--limit N]
browsin dom <selector> [--nth N] [--html N]
browsin text [selector] [--limit N] [--nth N]   # normalised innerText — read the page without pixels
browsin js '<expr>'

# capture
browsin snap [--clip SEL] [--pad px] [--full] [--jpeg] [--dpr N] [--name X]
browsin pdf [url] [--format a4|a3|letter] [--landscape] [--css-page-size] [--margin in]
browsin record start [--name X] [--fps N] [--quality N] [--max-seconds N]
browsin record status
browsin record stop [-o out.gif|out.mp4] [--width N] [--max-gap s] [--keep-frames]
browsin record cancel

# act
browsin click <sel> · hover <sel> · type <sel> <text> [--enter] [--append]
browsin key <Enter|Tab|Escape|ArrowDown|…> [--mod cmd,shift] [--on SEL]
browsin select <sel> <value|label> · upload <sel> <file…> · download <sel>
browsin drag <from> <to> | browsin drag <sel> --by dx,dy [--steps N]
browsin scroll <y|top|bottom|selector>
browsin tabs [list] · tabs use N · tabs close N · tabs auto   # tabs (popups, target=_blank)

# manage
browsin viewport [1280x800|iphone|ipad|desktop|wide] [--dpr N] [--mobile]
browsin login [url] [--note "why"]  # visible window, to sign in by hand once;
                                    # with --note, an interstitial explains why first
browsin status · browsin doctor · browsin gc · browsin down [--fresh|--all]
```

A selector is **CSS** or **`text=Sign in`** (what the user reads — better than guessing a soup of
Tailwind classes). Both pierce **shadow DOM** and **same-origin iframes**.

## Recipes

```bash
# React/Vite app: wait for the mount, or you shoot a blank page
browsin check localhost:5173 --wait 'document.querySelector("#root")?.children.length > 0'

# fill and submit a form (the selectors come from snapshot)
browsin type 'input[type="email"]' someone@example.com
browsin type 'input[type="password"]' secret
browsin key Enter --on 'input[type="password"]' --wait 'location.pathname !== "/"'

# an HTML document to PDF, honouring the document's own @page
browsin pdf ./out/document.html --css-page-size --margin 0 -o document.pdf

# broken on mobile?
browsin viewport iphone && browsin check localhost:5173

# a precise capture: position, the right tab, a clean screenshot
browsin viewport wide && browsin scroll 1650 && browsin click 'text=Features' && browsin snap --name hero

# check that a flow works end to end
browsin click 'text=Example' --wait 'document.querySelectorAll("svg rect").length > 3'
browsin download 'text=Download'

# read the page as text (cheap in tokens; shadow DOM and same-origin iframes work)
browsin text                          # the whole body, capped at 2000 chars
browsin text 'main article' --limit 400
browsin text '.card' --nth 1          # picks one when a selector matches several

# a single component
browsin snap --clip '[data-testid="card"]' --pad 16

# an animated demo without sending the model a series of screenshots
browsin record start --name flow --fps 12
browsin click 'text=Start'
browsin type 'input[name="message"]' 'Hello!'
browsin key Enter --on 'input[name="message"]' --wait 'document.querySelector(".reply")'
browsin record stop -o out/flow.gif --width 960
```

## Real login (a portal that needs an account)

The profile is throwaway, but it lives **on disk** — not in the window. That is what makes the flow
below work, and what agents tend to distrust for no reason:

1. The task lands on a login screen. **Do not type credentials with `type`** and do not ask for a
   password in the chat — tell the user, in one sentence, why you need the window ("I need you to
   sign in to dashboard X; I am opening the browsin window").
2. Open the **visible** window for the user to sign in:

   ```bash
   browsin login https://app.example.com --note "I need you to sign in to dashboard X so I can continue the task."
   ```

   With `--note`, the window first opens on a simple **interstitial** ("browsin login" + the reason +
   a "Continue to <url>" button); the user clicks it and lands on the login screen. Without a URL, the
   interstitial asks them to close the window when done. Use it when the agent runs without the user
   expecting a window to appear on their screen.

3. **Wait for the user's confirmation.** You do not see their window (it is headed, not headless);
   do not guess that they finished — ask. Closing the window does not sign anything out.
4. Carry on headless as usual. The next command relaunches the browser on the **same profile**, already
   signed in:

   ```bash
   browsin check https://app.example.com/dashboard
   ```

The login holds **only for your session** (its profile): other sessions do not see it, a plain `down`
keeps it, and `down --fresh`, the session idling past its TTL (`gc`) or the live-session cap erases it (above
`BROWSIN_MAX_SESSIONS`, default 8, the most idle session is closed with its profile). In Claude Code the
session is the conversation (`CLAUDE_CODE_SESSION_ID`), not the terminal tab. The window is brought to
the front on its own; when macOS does not allow it, the output warns (`warn`) — tell the user to look
for "Google Chrome for Testing" in the Dock. When `doctor` shows `login unavailable`, no windowed browser was
found (a `--shell-only` install and no Chrome on the machine) — run `scripts/install-browsers.sh` to
get the headed Chromium. When `login` shows an installed Chrome, it falls back to it, still on
browsin's profile.

## Recording and the context budget

`record` does not film wall-clock time: it captures one keyframe at the start and one at the end of
each visual command. The agent's pause between `click` and `type` does not become video; `--max-gap`
caps each interval at 1 second by default. The result is a file plus a JSON sidecar, never frames in
the output. Prefer it when the deliverable is an animated demo. Do not read each JPEG or the GIF back
into the conversation; check duration and frames with `ffprobe`, and ask for a specific frame's pixels
only when there is an aesthetic doubt. `record stop` needs `ffmpeg`; `record cancel` and `down` discard
an active recording.

## Traps

- **Waiting is the hard problem, not capturing.** `open`/`check` already wait, for a bounded time
  (up to 1.5 s), for the body to stop being empty — enough for many SPAs to escape the blank
  screenshot. When the app has its own marker, `--wait '<expr>'` is always better
  (`--wait 'document.querySelector("#root")?.children.length > 0'`); `--no-wait` turns the automatic
  wait off (a canvas-only app, a genuinely empty page). `check` warns when the page is still empty.
- **A selector did not match? The error teaches.** `no match` comes with a hint: zero matches suggests
  addressing by what the user reads (`click 'text=Sign in'`); several matches say how many and point
  to `--nth N` (0-based). Prefer `text=` to guessing a framework-generated class.
- **`text` normalises whitespace** (blank lines disappear) and truncates at 2000 chars by default
  (`--limit N` for more or less) — on purpose: reading a page costs tokens.
- **A logged-in portal has its own recipe.** See "Real login" above: `browsin login <url>` opens a
  **visible** window for the user to sign in by hand, once; the cookie stays in browsin's profile (on
  disk) and every later headless command inherits it. The first ordinary command after `login`
  **closes the window** and relaunches headless on the same profile — the page goes back to
  `about:blank`, so navigate again. Never ask for the user's credentials, never type them with `type`,
  never look for them in project files.
- **`viewport --dpr` ≠ `snap --dpr`.** The first is the `devicePixelRatio` the *page* sees (media
  queries, `srcset`); the second is the density of the output file.
- **A viewport `snap` does not reflow the page.** The default screenshot (the visible area) does not
  use `captureBeyondViewport`, so it triggers no resize — apps that redraw on resize (canvas, Blockly)
  stay intact. `--clip`/`--full` need it to render what is off screen, and then the page is laid out
  again once.
- **`logs` drains** — reading twice does not repeat. `click`/`key`/`type` also drain when they report.
- **`--clip 'text=…'` takes the smallest element with that text**, almost always smaller than the box
  you wanted. For a screenshot, use the container's CSS selector (or `--pad`).
- **`--nth` goes outside the selector**, but if you paste the whole snapshot line
  (`'text=Sign in --nth 1'`) browsin splits it itself — the same as `--nth 1`.
- **Tabs:** `target=_blank`/popups. By default the next command follows the newest tab; to stay on a
  specific tab use `browsin tabs` (list) and `browsin tabs use N` (pin); `browsin tabs close N` closes
  one and `browsin tabs auto` goes back to following the first. Without pinning, an unexpected popup
  (OAuth, an ad) changes the context without warning.
- **Shadow DOM: a descendant combinator does not cross the boundary.** Use the selector from inside
  the component (`#shadowbtn`), not `my-widget button`.
- **A cross-origin iframe is invisible**; same-origin works, with correct coordinate offsets.
- **`browsin down` when you are done** — otherwise Chromium stays up (~150 MB). If another AI works in
  parallel, `down` kills only *your* session; `down --all --fresh` cleans everything. A session idle
  for more than an hour is reaped on its own, and so is the most idle one above 8 live sessions
  (`BROWSIN_MAX_SESSIONS`); its profile, a login included, goes with it. `down` also cancels the active recording; run
  `record stop` before it to keep the GIF/MP4.
- **If the harness dies, the janitor covers it.** Each `launch` creates one detached process per base
  (`BROWSIN_DIR`) that repeats the gc on a timer (≤ 10 min) and exits when no session has a live
  browser — the safety net for a browser forgotten when the run or agent that launched it disappears.
  `BROWSIN_JANITOR=off` turns it off; nothing is installed on the machine, and it never touches another
  user's browser nor a session with a command running (the lock is re-checked at the point of killing;
  every `kill` requires the pid to prove in `ps` that it is the browser of that session's profile — a
  reused pid is never killed).
- **One session, one browser.** Inside pi each session and each subagent run gets its own
  (`PI_SESSION_ID`), so parallel agents never fight over the same tab. In Claude Code, each
  conversation (`CLAUDE_CODE_SESSION_ID`). Elsewhere — codex, a shell — the session comes from the
  terminal tab (`TERM_SESSION_ID`); to separate two flows in the same tab, `BROWSIN_SESSION=name`.
  `browsin status` shows yours and the other live ones; `browsin gc` shows and forces the collection.
- **Commands of the same session are serialised.** A per-session lock keeps two parallel `browsin`
  calls from starting two browsers or reading each other's page — do not count on parallelism
  *within* a session; the second command waits for the first to exit. Different sessions really run
  in parallel.
- **A missing binary means `scripts/install-browsers.sh`**, not `npm install`. `browsin doctor` shows
  which one is in use and shouts when it fell back to the system Chrome.
- **Chromium only.** A Safari/WebKit or Firefox bug does not show here.
- **Before changing browsin**, run `test/suite.sh`.
