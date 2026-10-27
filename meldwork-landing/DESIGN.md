# DESIGN.md — Meldwork

Meldwork's own design system, extracted from the shipped app (`frontend/src/styles/base-foundation.css`) and the v3 Trace brand marks. Generated per the Google Stitch DESIGN.md format (design-md skill). All landing/marketing UI must consume these tokens exactly.

## 1. Visual Theme & Atmosphere

Dark, quiet, instrument-panel calm. Meldwork is a local-first workspace where selected Agents collaborate to advance a shared task. The visual language connects their contributions: a near-black field, a faint dot-matrix of participants, one continuous coral work line, and generous negative space. Density is low; motion is slow and deliberate; nothing loops aggressively. Retro dot-matrix display type signals the "run state / terminal" heritage without becoming a gimmick.

Marketing copy leads with "Set the goal. Let Agents work together." Emphasize shared context, discussion, authorized execution, peer review, and less manual coordination. Users set goals and permissions and step in when information or key decisions are needed. Local history supports revisiting the work; do not promise complete evidence traceability, guaranteed correctness, or tasks completing without human input.

## 2. Color Palette & Roles

| Token | HEX | Role |
|---|---|---|
| `bg` | `#000000` | Page base (marketing) |
| `bg-deep` | `#06080a` | Canvas / media backdrop |
| `surface` | `#101315` | Raised panels, cards |
| `surface-raised` | `#1b1f21` | Pills, dark buttons (app dark token) |
| `surface-hover` | `#24292c` | Dark button hover |
| `ink` | `#f7f8fa` | Primary text on dark (wordmark ink) |
| `ink-soft` | `#c3cdd1` | Secondary text |
| `muted` | `#93a0a5` | Labels, captions (app dark muted) |
| `faint` | `#707b80` | Disabled / tertiary |
| `coral` | `#d98568` | Product dark-theme accent; active indicators, glyphs, focus |
| `coral-deep` | `#d45f52` | Product light-theme accent |
| `line` | `rgba(255,255,255,0.10)` | Hairline borders on dark |
| `pill-white` | `#ffffff` | Nav pill, primary CTA, logo badge |
| `nav-ink` | `#26343c` | Text on white pills (app light text) |

Light/dark mapping: marketing defaults to dark and supports a light-theme toggle. Accent RGB and translucent effects follow the selected product accent; do not reintroduce the older saturated `#ef5a45` into interface effects. Brand assets retain their original colors.

## 3. Typography Rules

Families:
- UI: `"Inter", "Segoe UI", system-ui, sans-serif` (weights 400/500/600)
- Display: local `"Meldwork Pixel CJK", monospace` (Fusion Pixel 12px proportional, OFL-1.1), covering Latin and Chinese glyphs with the bundled license notices.
- Use the local display font for headings and short state labels; keep body text in the system Chinese sans-serif stack. Chinese headings allow character wrapping; preserve Latin words as units.
- Mono accents: same display stack for stat glyphs

| Level | Size | Weight | Tracking | Line-height |
|---|---|---|---|---|
| Display / h1 | clamp(40px, 6.2vw, 84px) | 400 (display font) | -0.04em | 1.08 |
| h2 section | clamp(28px, 3.6vw, 44px) | 400 display | -0.03em | 1.15 |
| h3 card | 18–20px | 600 Inter | -0.01em | 1.3 |
| Body | 15–16.5px | 400 | 0 | 1.6 |
| Eyebrow | 12px | 600 | +0.18em uppercase | 1 |
| Caption / label | 11–12.5px | 500 | +0.01em | 1.4 |

Solid ink headlines only — no gradient text, no shimmer on type.

## 4. Component Stylings

- **White pill nav**: bg `#fff`, radius 999, height 44–48, shadow `0 4px 14px rgba(0,0,0,0.16)`; links `nav-ink` 500, opacity .5/.78/1; active = three 3px coral dots under label.
- **Primary CTA**: white pill, `nav-ink` 600, padding 12–13 × 22–28, glow `0 0 0 1px rgba(255,255,255,.15), 0 0 22px rgba(255,255,255,.32), 0 0 44px rgba(239,90,69,.18)`; hover translateY(-2px) scale(1.02).
- **Dark pill**: `surface-raised`, text `#c8c8c8`; hover `surface-hover` + white text + translateY(-1px).
- **Logo badge**: white circle 42–48px, Trace mark at 72% contain; hover scale(1.06).
- **Card**: `surface` bg, `line` border, radius 16–20, padding 24–30; hover: coral-tinted border + cursor spotlight.
- **Avatar ring** (agent logos): dark ring `#16191b` + `rgba(255,255,255,.35)` border, 5px padding, inner white disc; overlap -42%.
- Buttons/links focus-visible: 2px coral outline, offset 2.

## 5. Layout Principles

- 4px base scale; section vertical rhythm clamp(96px, 14vh, 160px).
- Content max-width 1120px; hero copy max-width 900px; text columns ≤ 620px.
- Single centered column narrative; grids 3-up (modes) / 2-up (screenshots) / 4-up (stats), collapsing 3→1, 2→1, 4→2.
- Whitespace over dividers: no boxed section frames; hairlines only inside cards.

## 6. Depth & Elevation

- Shadow-1 (nav/pills): `0 4px 14px rgba(0,0,0,0.16)`
- Shadow-2 (cards): `0 16px 42px rgba(0,0,0,0.42)` (app dark shadow)
- Shadow-3 (overlays): `0 30px 90px rgba(0,0,0,0.6)`
- z-order: canvas 0 → veil 1 → content 2 → nav 40 → menu 50.
- Surfaces differ by bg lightness steps (`#06080a` → `#101315` → `#1b1f21`), not by borders.

## 7. Do's and Don'ts

Do:
- Use coral only for acceptance/active/focus moments — it must stay rare.
- Keep the trace-line metaphor consistent: continuous rounded line, round terminals, one bright end point.
- Respect `prefers-reduced-motion`: static frame, final states, no marquee.
- Ground every claim in README facts (12 CLIs, 3 modes, local-first collaboration, opt-in writes, user decisions when needed). Label historical examples with their version.

Don't:
- No gradient/shimmer headlines; no glassmorphism everywhere; no neon multi-color.
- No cards in the hero composition; hero stays one full-bleed scene.
- No stock enterprise logo walls (Microsoft/Google) — only real supported Agent CLI marks.
- No heavy shadows beyond the three defined levels; no border-radius < 12 on cards.

## 8. Responsive Behavior

- Breakpoints: 1024 / 720 / 420.
- ≤1024: modes 3→1 column wide cards; screenshots 2→1 at 720.
- ≤720: pill nav → burger + white sheet menu (radius 28, staggered links); stats 4→2; hero type clamps down; canvas renders static frame on coarse pointers.
- Touch targets ≥ 44px.

## 9. Agent Prompt Guide

Quick reference: bg `#000`, surface `#101315`, ink `#f7f8fa`, muted `#93a0a5`, coral `#ef5a45`, white pill nav, dot-matrix display type, soft shadow `0 4px 14px rgba(0,0,0,.16)`.

Prompt template: "Dark instrument-panel landing for a local-first multi-agent review tool: near-black field with faint dot-matrix, one continuous coral trace line ending in a glowing acceptance point, white pill navigation, dot-matrix display headline in solid white, generous whitespace, slow deliberate motion, coral reserved for active states only."
