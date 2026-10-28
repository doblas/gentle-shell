# Gentle Shell design system

Captured from the project's CSS sources. Two token sets exist today and are recorded separately:

- **Canvas** — `assets/design-canvas/canvas.css` (the Gentle Design canvas UI, neutral graphite + blue accent).
- **Brand** — `assets/install-wizard/wizard.css` (installation wizard, gentlemanprogramming.com tokens, plum + pink accent).

Both are dark only (`color-scheme: dark`) and use local font stacks only (no web fonts, no external resources).

## Colors — Canvas (`assets/design-canvas/canvas.css`)

| Token | Value | Usage |
| --- | --- | --- |
| `--gd-bg` | `#111214` | Page background |
| `--gd-stage` | `#1a1b1e` | Canvas viewport, control backgrounds, comment cards |
| `--gd-panel` | `#222327` | Toolbar, side panel, popover, toast |
| `--gd-border` | `#3a3b40` | Control and panel borders |
| `--gd-text` | `#ececee` | Primary text |
| `--gd-muted` | `#a9abb2` | Secondary text, hover borders |
| `--gd-accent` | `#8ab4ff` | Pressed toggles, primary buttons, chosen artboard frame |
| `--gd-accent-text` | `#0b1220` | Text on accent |
| `--gd-danger` | `#ff9b9b` | Errors, detached comments |
| `--gd-focus` | `#ffd479` | Focus outline, active pin, queued handoff |
| `--gd-pin` | `#8ab4ff` | Comment pin |
| `--gd-pin-resolved` | `#7d8a7f` | Resolved pin |
| `--gd-success` | `#9be0a8` | Sent comment, implemented handoff |

## Colors — Brand (`assets/install-wizard/wizard.css`)

| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#1a1218` | Page background |
| `--bg-deep` | `#000000` | Deepest background |
| `--surface` | `#20161e` | Surface |
| `--surface-1` | `#241822` | Raised surface |
| `--surface-2` | `#342230` | Higher surface, scrollbar |
| `--border` | `#342230` | Borders |
| `--border-soft` | `#ffffff17` | Soft borders, ghost buttons |
| `--text` | `#f6eff3` | Primary text |
| `--text-muted` | `#a78e9b` | Secondary text |
| `--text-faint` | `#76616b` | Tertiary text (decorative only, below AA for body) |
| `--accent` | `#f095c8` | Primary buttons, links, focus outline |
| `--accent-strong` | `#ff76c3` | Pressed primary |
| `--accent-soft` | `#ffb1dd` | Inline code, hover text |
| `--success` | `#b4e7c7` | Success state |
| `--warning` | `#e0c27a` | Warning state |
| `--error` | `#ff718f` | Error state |
| `--info` | `#a9c7ee` | Info state |

## Typography

| Source | Family stack | Notes |
| --- | --- | --- |
| `assets/design-canvas/canvas.css` | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | 14px base; titles 15–16px/600; meta 12px |
| `assets/design-canvas/canvas.css` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | Feature document path chip |
| `assets/install-wizard/wizard.css` | `--font-sans`: `Inter, "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | 16px/1.6 base; buttons 600 15px |
| `assets/install-wizard/wizard.css` | `--font-mono`: `"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace` | Code, commands |

## Spacing

No spacing tokens in either source. Values used in `canvas.css`: 2, 4, 6, 8, 10, 12, 16, 24 px (gaps and paddings). Values used in `wizard.css` include 12, 16, 24, 28 px.

## Radius

| Token / value | Source |
| --- | --- |
| `6px` (controls, cards), `8px` (popover, toast), `4px` (badges, thumbnails), `999px` (chips) | `assets/design-canvas/canvas.css` |
| `--radius-sm` 8px, `--radius-md` 12px, `--radius-lg` 16px, `--radius-pill` 999px | `assets/install-wizard/wizard.css` |

## Shadows and motion

| Token / value | Source |
| --- | --- |
| `0 2px 16px rgba(0,0,0,.5)` artboard frame; `0 8px 32px rgba(0,0,0,.6)` popover/toast | `assets/design-canvas/canvas.css` |
| `--glow` `0 10px 30px #f095c84d`, `--glow-hover` `0 14px 36px #f095c86b`, `--shadow-panel` `0 24px 60px #00000073, 0 0 40px #f095c81a` | `assets/install-wizard/wizard.css` |
| Transitions 120–160ms `ease`, only under `prefers-reduced-motion: no-preference` | `assets/design-canvas/canvas.css` |
| `--ease` `cubic-bezier(.4, 0, .2, 1)`, 200ms | `assets/install-wizard/wizard.css` |

## Component rules

- **Canvas buttons** (`canvas.css`): min 32×32px, padding 4px 10px, 1px `--gd-border`, radius 6px, `--gd-stage` background; pressed toggle / primary use `--gd-accent` with `--gd-accent-text`; disabled opacity .5.
- **Canvas focus** (`canvas.css`): 2px solid `--gd-focus` outline, offset 2px.
- **Canvas chips** (`canvas.css`): pill, 1px border, 12px text; status colored by border + text.
- **Comment pin** (`canvas.css`): 26px min, radius `13px 13px 13px 2px`, 2px `#0b1220` border, kept at screen size with inverse zoom.
- **Brand buttons** (`wizard.css`): min-height 46px, radius `--radius-sm`, 600 15px; primary `--accent` on `--bg` with `--glow`; secondary transparent with `--border`; ghost `--border-soft` + `--text-muted`.
- **Brand focus** (`wizard.css`): 2px solid `--accent` outline, offset 2px.
- Every state also has a text label (`wizard.css` header comment); never color alone.
