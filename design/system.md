# Gentle Shell design system

Captured from the project's CSS sources:

- `assets/install-wizard/wizard.css` — installation wizard, gentlemanprogramming.com tokens.
- `assets/design-canvas/canvas.css` — the Gentle Design canvas. It uses the same brand set as the wizard, plus a few derived tokens and layout sizes recorded below.

Both are dark only (`color-scheme: dark`) and use local font stacks only (no web fonts, no external resources). Every state also has a text label; never color alone (`wizard.css` header comment).

## Colors — brand set (both sources)

| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#1a1218` | Page and canvas background; text on accent |
| `--bg-deep` | `#000000` | Deepest background (canvas tool rail) |
| `--surface` | `#20161e` | Bars, side panels, toast |
| `--surface-1` | `#241822` | Raised surface: cards, mode chip |
| `--surface-2` | `#342230` | Higher surface: selected items, counts, dot grid |
| `--border` | `#342230` | Borders |
| `--border-soft` | `#ffffff17` | Soft borders, ghost buttons, tags |
| `--text` | `#f6eff3` | Primary text |
| `--text-muted` | `#a78e9b` | Secondary text |
| `--text-faint` | `#76616b` | Tertiary, decorative only (below AA for body text); pending timeline steps |
| `--accent` | `#f095c8` | Primary buttons, links, focus outline, pins, selected tab |
| `--accent-strong` | `#ff76c3` | Pressed primary |
| `--accent-soft` | `#ffb1dd` | Inline code, hover text, counts |
| `--success` | `#b4e7c7` | Success, done steps, Sent |
| `--warning` | `#e0c27a` | Waiting, active pin |
| `--error` | `#ff718f` | Errors, alerts, Detached |
| `--info` | `#a9c7ee` | In progress, current step |

## Colors — canvas derived tokens (`assets/design-canvas/canvas.css`)

| Token | Value | Usage |
| --- | --- | --- |
| `--accent-wash` | `#f095c814` | Hover/selection wash |
| `--accent-line` | `#f095c899` | Accent borders (active card) |
| `--wash` | `#ffffff0f` | Neutral wash (code chips) |
| `--paper` | `#ffffff` | Artboard iframe background |
| `--success-halo` / `--success-line` | `#b4e7c726` / `#b4e7c766` | Success dot halo / chip border |
| `--error-halo` / `--error-wash` / `--error-line` | `#ff718f26` / `#ff718f1a` / `#ff718f80` | Error dot halo / alert background / alert border |
| `--info-halo` / `--info-line` | `#a9c7ee33` / `#a9c7ee66` | Current step halo / chip border |
| `--warning-line` | `#e0c27a66` | Waiting chip border |
| `--scrim` | `#000000b3` | Dialog backdrop |

## Typography

| Token / stack | Source | Notes |
| --- | --- | --- |
| `--font-sans`: `Inter, "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | both | Wizard 16px/1.6 base; canvas 14px/1.5 base |
| `--font-mono`: `"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace` | both | Code chips, selectors, feature paths, kbd |
| Canvas sizes in use | `canvas.css` | 11 (tags, kbd, timestamps), 12 (meta, chips), 13 (cards, alerts), 14 (body), 15–16 (titles, 600) |
| Wizard sizes in use | `wizard.css` | Display clamp 34–58, lead 17–18, body 16, buttons 600 15, small 13 |

## Spacing

No spacing tokens in either source. Values in use in `canvas.css` (gap/padding): 4, 6, 8, 10, 12, 16, 24 px; 8 px is the most common. Wizard values include 12, 16, 24, 28 px.

## Layout (`assets/design-canvas/canvas.css`)

| Token | Value | Usage |
| --- | --- | --- |
| `--rail-width` | `60px` | Tool rail |
| `--bar-height` | `56px` | Top bar |
| `--nav-width` | `240px` | Artboard list |
| `--side-width` | `360px` | Review side |

Viewport: `--bg` with a dot grid of `--surface-2` (1 px dots, 22 px spacing).

## Radius

| Token / value | Source |
| --- | --- |
| `--radius-sm` 8px, `--radius-md` 12px, `--radius-lg` 16px, `--radius-pill` 999px | both |
| `6px` (code chips, small controls), `4px` (thumbnails, kbd), `50%` (dots), `13px 13px 13px 2px` (pins) | `canvas.css` |

## Shadows and motion

| Token / value | Source |
| --- | --- |
| `--glow` `0 10px 30px #f095c84d`; `--glow-hover` `0 14px 36px #f095c86b` | `wizard.css` (`--glow` also in `canvas.css`) |
| `--shadow-panel` `0 24px 60px #00000073, 0 0 40px #f095c81a` | both: popovers, dialogs, toast, floating alerts |
| `--shadow-frame` `0 2px 16px #00000080` | `canvas.css`: artboard frames, pins |
| `--shadow-pop` `0 4px 16px #00000099` | `canvas.css`: floating buttons |
| `--ease` `cubic-bezier(.4, 0, .2, 1)`; 120–200ms | both; motion only under `prefers-reduced-motion: no-preference` |

## Component rules

- **Buttons** (`canvas.css`): inline-flex, min 36×36, padding 4px 12px, gap 8px, 1px `--border`, `--radius-sm`, transparent background. Primary (`.gd-primary`): `--accent` background and border, `--bg` text, 600, `--glow`. Disabled: reduced opacity, no glow.
- **Brand buttons** (`wizard.css`): min-height 46px, padding 13px 24px, `--radius-sm`, 600 15px; primary `--accent` on `--bg` with `--glow`, lifts 2px on hover; secondary transparent with `--border`; ghost `--border-soft` + `--text-muted`.
- **Focus** (both): 2px solid `--accent` outline, offset 2px, on every control.
- **Tool rail** (`canvas.css`): `--bg-deep`, 40×40 icon buttons in `--text-muted`; pressed tool gets `--surface-2`, `--accent` icon and a 3px accent bar on its left edge. Every icon-only button has an accessible name and a title naming its shortcut.
- **Tabs** (`canvas.css`): `--text-muted`, 2px bottom border; selected `--text` with `--accent` underline; count badge pill `--surface-2` with `--accent-soft`, 12px.
- **Cards** (`canvas.css`): `--surface-1`, 1px `--border`, `--radius-md`; active card uses `--accent-line`.
- **Chips and tags** (`canvas.css`): pill, 1px border, 11–12px 600; state color carried by text plus the matching `*-line` border (Chosen = accent with a dot; Alternative = `--border-soft` muted).
- **Code chips** (both): `--font-mono` 12px, `--accent-soft` on `--wash`, 1px `--border-soft`, 6px radius.
- **Pins** (`canvas.css`): 26px min, radius `13px 13px 13px 2px`, 2px `--bg` border, `--accent` fill with `--bg` number, 700 12px; active pin `--warning`; kept at screen size with inverse zoom.
- **Mode chip** (`canvas.css`): floating pill at the bottom center of the viewport, `--surface-1`, 1px `--border`, `--shadow-pop`, a status dot before the text.
- **Alerts** (`canvas.css`): `role="alert"`, flex with an error icon, 1px `--error-line`, `--error-wash` background, 13px text, a small mono code line, and a dismiss button. Over an artboard they get an opaque `--surface` layer and `--shadow-panel`.
- **Toast** (`canvas.css`): top center of the canvas, `--surface`, 1px `--accent` (or `--error`), `--radius-sm`, `--shadow-panel`, 600; auto-hides.
- **Timeline steps** (`canvas.css`): 10px dot; done `--success`, current `--info` with `--info-halo`, pending `--text-faint` outline; label plus muted timestamp.
- **Keyboard keys** (`canvas.css`): `--font-mono` 11px, 1px `--border-soft` with a 2px bottom border, 4px radius, `--text-muted`.
