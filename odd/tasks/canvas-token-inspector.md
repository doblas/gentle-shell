# Canvas token inspector and accessibility checks: implement design/canvas-features/03-token-inspector.html

Objective: in Comment mode, hovering an artboard element shows its real color, font, size, spacing, radius and contrast next to the project's tokens in `design/system.md`, flagging what is off the system; every artboard gets automatic accessibility checks shown in the artboard list and in a Checks tab. Visual spec: `design/canvas-features/03-token-inspector.html`; tokens: `design/system.md`.
Branch: `feat/canvas-token-inspector`, started from `feat/canvas-screen-sizes` once that feature is done (same files; sequential writers). Work-unit commits only; push/PR are the user's decision.

## Specs

Source: L1 (handoff) and the artboard. Wording outside quotes is the parent's reading; (default) marks parent decisions the user may change.

- **S1 Project tokens.** The canvas server reads `design/system.md` (read-only) and gives the canvas its tokens: every table row whose first cell is a backticked CSS custom property (`--name`) with a backticked value in the second cell, grouped by section (colors, typography, spacing, radius, shadows). No `design/system.md` means no token comparison; the inspector still shows values and contrast. A changed `design/system.md` reloads the tokens live.
- **S2 Inspector.** User (artboard tradeoff): "spot colors, fonts and spacing off the system". In Comment mode, the hovered element shows a panel next to the artboard with its selector and computed text color, background, font family and size, line height, margins/paddings, border radius, and the text/background contrast ratio. Each value shows the matching token name, or ⚠ "no token" plus the nearest token (colors by perceptual distance; sizes by numeric distance). Contrast below WCAG AA (4.5:1 normal text, 3:1 large text) is flagged. The inspector inside the iframe measures; the canvas compares and renders. The panel never covers the hovered element when there is room beside it.
- **S3 Ask the agent to fix.** The panel's **Ask the agent to fix** creates a comment on that element whose text lists the flagged values and their nearest tokens (editable before sending), following the current Send now / Collect mode. **Copy** copies the same text.
- **S4 Accessibility checks.** Each artboard is checked after it loads and after every reload: text contrast below AA, interactive elements smaller than 24×24 CSS px (WCAG 2.2 target size minimum; (default) 44 px recommended shown as advice), images without `alt`, form fields without an accessible label, heading levels that skip. Results show in a new **Checks** tab (count; each issue with **Show**, which highlights the element, and **Ask the agent to fix**) and as a tag on each artboard in the list (`A11y ✓` or `N checks`). Passed groups are listed once.
- **S5 Docs, accessibility, tests.** `docs/gentle-shell.md` and the skill describe the inspector, the token match, the checks and their limits (heuristics, not a full audit). WCAG AA, visible focus, reduced motion; tokens only from `design/system.md`. Tests cover token parsing, nearest-token and contrast math, each check's positive and negative case, the panel and the Checks tab.

## Tasks

- [ ] T1 S1 — parse `design/system.md` tokens on the server, deliver and live-reload them. Route: gentle-ai-worker. Commit: —
- [ ] T2 S2, S3 — inspector measurement, comparison, panel, ask-to-fix. Route: gentle-ai-worker. Commit: —
- [ ] T3 S4 — accessibility checks, Checks tab, list tags. Route: gentle-ai-worker. Commit: —
- [ ] T4 S5 — docs, skill, full suite, visual check, handoff implemented with a preview canvas URL. Route: inline. Commit: —

## Log

- L1 (user, verbatim): "Implement the design artboard design/canvas-features/03-token-inspector.html / Artboard: design/canvas-features/03-token-inspector.html / Title: Token inspector and accessibility checks / Tradeoff: Ideas 3 and 5: spot colors, fonts and spacing off the system and contrast or target-size problems; one more panel to read / Implement it in the project's real stack. Use the artboard as the visual spec: map its parts to the project's existing components and styles, and do not copy the artboard HTML verbatim. Take colors, typography, spacing, radius and shadows from design/system.md, the project's token source. Report progress with the gentle_design tool: action \"handoff\", target \"canvas-features/03-token-inspector.html\", status \"in_progress\" when you start; status \"implemented\" when it is done, with previewUrl set to the running app's loopback URL (localhost, 127.0.0.1 or [::1]) when one is running, so the canvas can compare it with the artboard. This design is not linked to an ODD feature document: size it under the project's ODD rules as usual. This handoff itself commits nothing."
- L2: Received while canvas-screen-sizes T1/T2 were running and canvas-version-history was queued. Parent order: screen sizes → token inspector → version history (inspector is lower risk; history writes and deletes stored files). Same files, so one writer at a time.
