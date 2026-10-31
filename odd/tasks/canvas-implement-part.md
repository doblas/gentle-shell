# Implement only this (one part of a direction)

Hand one element of an artboard (a side menu, a card) to the session to build in the real app, without choosing that
direction. Branch feat/canvas-implement-part (from feat/canvas-polish).

## Specs

- S1: "tengo 3 propuestas y todas por ejemplo tiene el mismo diseño del menu lateral que no esta implementando y mientra decido que diseño elijo implementar solo la parte del menu lateral ese" (L1). The comment popover gets **Implement only this** beside Send and Add to the mix; the field becomes an optional note. Disabled, with the reason, when no Pi session is behind the canvas.
- S2: It does not choose a direction and does not discard the others: `handoffs.json` and the chosen artboard stay as they are.
- S3: Each part is recorded as a partial implementation and listed in the review panel (**Partial implementations**): artboard, excerpt, state (Sent, Queued, In progress, Implemented), time, the agent's note, and **Show**, which marks the element's area. Live, like the handoff timeline.
- S4: `POST api/designs/<slug>/parts` takes `{ file, selector, excerpt, note }` with the mix pick rules (file of the manifest, selector 1-500, excerpt cut to 300, note at most 2000); the part is written to `design/<slug>/parts.json` before delivery and removed when the delivery fails; answers `202 { ok, id, queued }`. `GET` returns the document.
- S5: The session message asks to build only that element in the project's real stack, leave the rest of the artboard and the chosen direction alone, and report with `gentle_design` action `handoff`, `target <slug>/<file>`, `part <id>`.
- S6: The `gentle_design` tool's `handoff` action accepts an optional `part`; with it, it updates that part in `parts.json` (in_progress / implemented, note) and leaves `handoffs.json` untouched. `list` names each design's parts.
- S7: English and Spanish; docs, README row and skill describe it; existing Implement, Mix and handoff behavior stays as it is.

## Tasks

- T1 [S2, S4, S6] `lib/design-parts.ts`: the parts.json store (read, add, setStatus, markQueued, remove), same queue and safety as handoffs. Route: inline. Commit: pending.
- T2 [S4, S5, S6] Server route, session message and plan, canvas wiring, tool `part` and `list`. Route: inline. Commit: pending.
- T3 [S1, S3, S7] Canvas: popover button, Partial implementations list with live state and Show, i18n. Route: inline. Commit: pending.
- T4 [S7] Docs, README, skill; browser check; full gentle-design tests and typecheck. Route: inline. Commit: pending.

## Log

- L1 (user, 2026-10-31): "perfecto y una duda, actualmente se puede implementar unicamente solo un bloque de una propuesta?es decir tengo 3 propuestas y todas por ejemplo tiene el mismo diseño del menu lateral que no esta implementando y mientra decido que diseño elijo implementar solo la parte del menu lateral ese"
- L2 (assistant proposal): a button **Implementar solo esto** in the element popover beside Enviar and Añadir a la mezcla; it sends the artboard, selector and excerpt with the instruction to build only that part; it does not choose a direction or discard the others; it is recorded as a partial implementation in the panel.
- L3 (user, 2026-10-31): "si"
