# Canvas chosen direction: show that the chosen artboard is being built and the rest are discarded

Objective: once an artboard is handed off, the whole canvas says which direction is being implemented and that the others are discarded, not only the chosen artboard's own header.
Branch: `feat/canvas-chosen-direction` (from local `main`). Work-unit commits only; push/PR are the user's decision.

## Specs

- **S1 Top-bar status.** User (verbatim, L2): "Una banda de estado en la barra superior … `● Implementando «01 Cabina con respuesta» · En curso desde 09:48 · "Explorando el código actual…" · [Ver]` … Al pulsar «Ver» el canvas se centraría en la propuesta elegida. Cuando termine, la banda pasaría a «Implementado ✓ · [Comparar con la app]»." In the bar, after the breadcrumb, shown only while the open design has a chosen artboard: state (Queued / Implementing… / In progress / Implemented ✓, as the handoff badge), the chosen title, the time (since sent/started, or when implemented), the agent's last note (truncated, full text in `title`), and a Show button that opens the chosen artboard in focus mode. Implemented reuses the existing "Compare with app" bar button. Live with handoffs.json; hidden again when nothing is chosen.
- **S2 Discarded alternatives.** User (verbatim, L2): "Les bajaría la opacidad y la saturación (≈45 % y escala de grises parcial). Al pasar el ratón o con el foco del teclado recuperarían el color … Cambiaría «Alternativa» por «Descartada» … Quitaría el botón «Implementar esto» de las alternativas. Pondría en su lugar una acción secundaria «Cambiar a esta…» con confirmación, porque esa acción mueve el handoff." Label decided by the user (L3): "Descartada" (EN "Discarded"). Applies on the canvas, the navigator tag and the minimap; the artboard menu item says the same as the header button; the confirm step says the handoff moves. Nothing changes before an artboard is chosen.
- **S3 Chosen shows active work.** User (verbatim, L2): "Un punto que late en «En curso». Se desactivaría con `prefers-reduced-motion`. Sobre el marco del artboard, un mini stepper (Elegido → Enviado → En curso → Implementado) con la última nota del agente en una línea legible, sin cursiva cortada." The stepper's state is also in words for assistive technology.
- **S4 Navigator.** User (verbatim, L2): "Pondría «En implementación» arriba con la elegida, y debajo «Descartadas (2)» plegable y atenuada." Constraint (L4): the list never moves its items (moving a thumbnail iframe reloads it; existing S6 contract), so the chosen item is marked with an accent, discarded items are dimmed, and a "Hide discarded (N)" toggle collapses them.
- **S5 Docs, i18n, a11y, tests.** Every new string in both catalogs (EN/ES, neutral Spanish); `docs/gentle-shell.md` describes it; tokens only from the existing canvas variables; visible focus; reduced motion respected; tests through the fake DOM.

## Tasks

- [ ] T1 S1-S2, S5 — top-bar status, discarded alternatives (canvas, navigator tag, minimap, Switch to this…), docs, tests. Route: inline. Commit:
- [ ] T2 S3-S5 — chosen stepper, pulsing state, readable note, navigator accent/dim/hide toggle, docs, tests, visual check. Route: inline. Commit:

## Log

- L1 (user, verbatim): "mira, esto es una prueba real implementando una de las propuestas … pero me falta algo que vea que ya se esta trabajando en la propuesta seleccionada y el resto quedan descartadas, que me propones para verlo mejor visualmente?"
- L2: Proposal accepted by the user ("Implementar directamente": 4 changes in two commits, 1+2 then 3+4); quoted in S1-S4.
- L3 (user, verbatim): "Descartada"
- L4: Reordering the navigator would reload thumbnails (S6 test "thumbnails keep their iframes…"), so S4 keeps DOM order and uses accent/dim/collapse instead of moving the chosen item first.
