# Canvas language: implement design/canvas-features/06-language.html

Objective: the whole Gentle Design canvas UI in Spanish or English, starting from the browser's language, with a switch in the top bar. Visual spec: `design/canvas-features/06-language.html`; tokens: `design/system.md`.
Branch: `feat/canvas-language`, last in the canvas queue, so every label the other features add is translated once (same files; one writer at a time). Work-unit commits only; push/PR are the user's decision.

## Specs

- **S1 Switch.** User (artboard tradeoff): "the whole canvas in Spanish or English, starting from the browser's language". A top-bar button with a globe icon and the current code (`ES` / `EN`) opens a menu: Español, English, and "Igual que el navegador" / "Match the browser", the current choice checked (`menuitemradio`, `aria-checked`), full keyboard menu behavior. The choice is saved in the browser (`localStorage`) and applies at once without reloading artboards. Default: the browser's language (`es*` → Spanish, anything else → English).
- **S2 Coverage.** Every canvas-owned text switches: labels, buttons, tabs, counts' words, tooltips and `title`s, `aria-label`s, the mode chip, status line, empty states, alerts and S12 error sentences, toasts, the shortcuts dialog, dates ("Today"/"Hoy", month names via `Intl`), and the features already merged (sizes, inspector, checks, history, compare, minimap, menus, dialogs). `<html lang>` follows the choice. Neutral, professional Spanish (tú forms, no voseo), consistent terms (for example Comentar, Ver todo, Elegido, Alternativa, En curso, Implementado, Enviar todo, Acumular, Encargo).
- **S3 Not translated.** User content (comment text, artboard titles and tradeoffs, the brief) and design file names stay as written. Messages the canvas sends to the session stay in English (they are agent instructions); the menu says so in one line, as in the artboard.
- **S4 One catalog.** All strings live in one dictionary per language in the canvas assets; a missing Spanish key falls back to English and a test fails on any key missing in either language or any canvas string not taken from the catalog (a structural check over `canvas.js`/`index.html`).
- **S5 Docs, accessibility, tests.** `docs/gentle-shell.md` describes the switch and what is not translated. WCAG AA, visible focus, reduced motion; tokens only from `design/system.md`. Tests cover default detection, switching, persistence, `lang`, menu keyboard behavior, catalog completeness and a representative set of translated surfaces.

## Tasks

- [ ] T1 S1-S5 — catalog, switch, translate every surface, docs, tests. Route: gentle-ai-worker. Commit: —
- [ ] T2 S1-S5 — full suite, visual check in both languages, handoff implemented with a preview canvas URL. Route: inline. Commit: —

## Log

- L1 (user, verbatim): "Implement the design artboard design/canvas-features/06-language.html / Artboard: design/canvas-features/06-language.html / Title: Spanish or English / Tradeoff: Idea 11: the whole canvas in Spanish or English, starting from the browser's language; every new label must be written twice / Implement it in the project's real stack. Use the artboard as the visual spec: map its parts to the project's existing components and styles, and do not copy the artboard HTML verbatim. Take colors, typography, spacing, radius and shadows from design/system.md, the project's token source. Report progress with the gentle_design tool: action \"handoff\", target \"canvas-features/06-language.html\", status \"in_progress\" when you start; status \"implemented\" when it is done, with previewUrl set to the running app's loopback URL (localhost, 127.0.0.1 or [::1]) when one is running, so the canvas can compare it with the artboard. This design is not linked to an ODD feature document: size it under the project's ODD rules as usual. This handoff itself commits nothing."
- L2: Queue order: screen sizes → token inspector → version history → compare overlay → minimap/variants/export → language (last, so every other feature's labels are translated in one pass).
- L3 (user, verbatim): "por lenguaje y luego el punto 3" — after this feature, fix tests/agent-home.test.ts isolation (inherits GENTLE_SHELL_CONFIG_HOME).
- L4: Branched feat/canvas-language from feat/canvas-minimap-variants-export (75bcc3a5e). Context backstop fired in the parent; T1 goes to one gentle-ai-worker (single writer). Catalog preferably inside canvas.js (no new served asset); inspector.js runs inside artboards.
