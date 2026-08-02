# Currency War Transfer Design System

## 0. Research Log

- Embedded refs: shortlisted `playstation`, `aside`, and `nvidia`; only `aside.md` was materialised in the installed skill package, so picked its product-app framing, thin dividers, squircle controls, and precise hierarchy. The indexed Layer A `taste-skill.md` was unavailable and is explicitly skipped.
- Lazyweb: ran 2 desktop queries (`game strategy search character filter`, `game team builder strategy cards`) and viewed 3 screens: a Hearthstone collection grid, a filter-plus-profile result list, and a card-list result. Harvested the compact filter rail, dense visual roster, persistent result count, and row-level action grammar; no source assets are shipped.
- Imagen: generated a three-direction concept board at `C:\Users\cmtse\.codex\generated_images\019fb668-fe72-7a83-bcc5-3ac7d3cd2504\exec-5dcadd1e-359c-4967-bf25-ce6a93979b58.png`; selected Concept A, the luminous parchment tactical index, because it keeps long Chinese strategy text readable while making roster comparison distinctive.
- UI/UX DB: unavailable in the installed skill package. Palette and typography were checked manually against WCAG 2.2 AA contrast targets.

## 1. Atmosphere & Direction

The interface is a luminous tactical index: warm paper surfaces, precise ink typography, restrained amber selection signals, and cool teal system states. It should feel like a serious Strategy Compendium that happens to be powered by a transfer service, not an official game client and not a generic SaaS dashboard.

The memorable moment is selection: choosing a strategy draws an amber line through the card, promotes it into the fixed transfer tray, and makes its final roster visually continuous between the list and the action area. No copyrighted game logos or background artwork are used; live character portraits come only from the source strategy API as content.

## 2. Colour Tokens

| Token | Value | Role |
| --- | --- | --- |
| `--colour-canvas` | `#eee8da` | Page atmosphere |
| `--colour-paper` | `#fffdf7` | Primary surface |
| `--colour-paper-raised` | `#fff8e9` | Selected/elevated surface |
| `--colour-paper-muted` | `#f4efe3` | Quiet controls and skeletons |
| `--colour-ink` | `#20241f` | Primary text |
| `--colour-ink-soft` | `#5f635b` | Secondary text |
| `--colour-ink-faint` | `#85877f` | Metadata |
| `--colour-rule` | `#d8cfbc` | Hairline divider |
| `--colour-rule-strong` | `#9f9275` | Strong containment |
| `--colour-amber` | `#b66d0f` | Selection and primary action |
| `--colour-amber-dark` | `#744006` | Primary-action hover/text |
| `--colour-amber-pale` | `#f4dfb8` | Selected-state wash |
| `--colour-teal` | `#17666a` | Success/system status |
| `--colour-teal-pale` | `#dceceb` | Informational wash |
| `--colour-danger` | `#9f352a` | Error state |
| `--colour-danger-pale` | `#f5ded9` | Error wash |
| `--colour-focus` | `#185f9d` | Focus ring |
| `--colour-white` | `#ffffff` | Avatar/keyline contrast |
| `--colour-cost-1` | `#5b6275` | Cost-1 portrait field |
| `--colour-cost-2` | `#4f9179` | Cost-2 portrait field (green) |
| `--colour-cost-3` | `#5f73a8` | Cost-3 portrait field (blue) |
| `--colour-cost-4` | `#80699d` | Cost-4 portrait field |
| `--colour-cost-5` | `#b58a3a` | Cost-5 portrait field (yellow) |

### Dark theme override

Dark mode keeps the parchment hierarchy but shifts it into a midnight compendium:
charcoal canvas, ink-black paper, muted gold selection, and desaturated teal
system feedback. Components keep consuming the semantic tokens above;
`html[data-theme="dark"]` changes only their values.

| Token | Dark value | Role |
| --- | --- | --- |
| `--colour-canvas` | `#111714` | Night canvas |
| `--colour-paper` | `#18201c` | Primary dark surface |
| `--colour-paper-raised` | `#222a23` | Selected/elevated dark surface |
| `--colour-paper-muted` | `#141b18` | Quiet dark controls |
| `--colour-ink` | `#f3eddf` | Primary dark-theme text |
| `--colour-ink-soft` | `#c0baad` | Secondary dark-theme text |
| `--colour-ink-faint` | `#96988f` | Dark-theme metadata |
| `--colour-rule` | `#38423b` | Dark hairline divider |
| `--colour-rule-strong` | `#727c70` | Dark strong containment |
| `--colour-amber` | `#d58a28` | Dark selection/action |
| `--colour-amber-dark` | `#f0b45b` | Dark action emphasis |
| `--colour-amber-pale` | `#3d2d17` | Dark selected-state wash |
| `--colour-teal` | `#77c2c2` | Dark system status |
| `--colour-teal-pale` | `#183436` | Dark informational wash |
| `--colour-danger` | `#f08b7f` | Dark error state |
| `--colour-danger-pale` | `#3b211f` | Dark error wash |
| `--colour-focus` | `#7fc2ff` | Dark focus ring |
| `--colour-white` | `#f8f4ea` | Portrait keyline contrast |
| `--colour-cost-1` | `#434a5c` | Dark cost-1 portrait field |
| `--colour-cost-2` | `#38725f` | Dark cost-2 portrait field (green) |
| `--colour-cost-3` | `#485d91` | Dark cost-3 portrait field (blue) |
| `--colour-cost-4` | `#654f82` | Dark cost-4 portrait field |
| `--colour-cost-5` | `#8a692d` | Dark cost-5 portrait field (yellow) |

The browser colour scheme and `theme-color` metadata follow the active theme.
An explicit user choice is stored locally; otherwise the first visit follows
`prefers-color-scheme`.

## 3. Typography

No remote fonts are required. This avoids blocking Chinese text and keeps the static shell fast.

| Token | Stack / Size | Line height | Use |
| --- | --- | --- | --- |
| `--font-display` | `"Noto Serif TC", "PMingLiU", Georgia, serif` | — | Page and section headings |
| `--font-body` | `"Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif` | — | UI and long text |
| `--font-mono` | `ui-monospace, "Cascadia Code", monospace` | — | IDs and status codes |
| `--text-0` | `0.75rem` | `1.4` | Micro metadata |
| `--text-1` | `0.875rem` | `1.5` | Labels and secondary text |
| `--text-2` | `1rem` | `1.6` | Body |
| `--text-3` | `1.25rem` | `1.35` | Card title |
| `--text-4` | `1.75rem` | `1.2` | Section heading |
| `--text-5` | `clamp(2rem, 5vw, 4.25rem)` | `1.05` | Page display |

Display text uses normal to medium weight. Interface labels may use 600; avoid heavy 800–900 weights.

## 4. Spacing & Geometry

Base unit: `4px`.

| Token | Value |
| --- | --- |
| `--space-1` | `0.25rem` |
| `--space-2` | `0.5rem` |
| `--space-3` | `0.75rem` |
| `--space-4` | `1rem` |
| `--space-5` | `1.25rem` |
| `--space-6` | `1.5rem` |
| `--space-8` | `2rem` |
| `--space-10` | `2.5rem` |
| `--space-12` | `3rem` |
| `--space-16` | `4rem` |

| Geometry token | Value | Use |
| --- | --- | --- |
| `--radius-control` | `0.5rem` | Inputs and compact buttons |
| `--radius-panel` | `0.75rem` | Search and transfer panels |
| `--radius-pill` | `999px` | Status and selected-role chips only |
| `--content-width` | `90rem` | Main page maximum |
| `--filter-width` | `21rem` | Desktop search rail |
| `--action-width` | `19rem` | Desktop selected tray |
| `--role-popover-width` | `36rem` | Desktop role catalogue and one-row category tags |
| `--role-popover-max-height` | `26rem` | Maximum role catalogue height before internal scrolling |

## 5. Reusable Primitives & States

### Button

- Variants: `primary` amber fill, `secondary` paper with rule, `quiet` text-only.
- Default: sharp text, 44px minimum touch height. Hover changes colour and raises by one subtle transform. Active returns to baseline. Focus uses a 3px `--colour-focus` outline. Disabled retains readable text at reduced contrast. Loading replaces the leading icon with a CSS spinner and preserves width.

### Field

- Label remains visible above the control. Optional hint sits below.
- Default paper fill with strong rule; hover darkens the rule; focus uses focus outline and amber inner keyline. Error uses danger keyline and an adjacent textual message. Disabled uses muted paper.

### Mode tabs

- Two peer buttons in a single ruled track: URL/ID and details search.
- Active mode uses ink fill and paper text. Keyboard arrow navigation is supported. The inactive panel is hidden semantically and visually.

### Role picker and role chip

- Role names are localised to the active interface language. The filter matches
  Simplified Chinese, Traditional Chinese, and English aliases regardless of
  the active language. Every chip uses the source portrait icon with a textual
  fallback.
- A single-choice tag row filters the catalogue by all characters, costs 1–5,
  or expert consultant status. Tags use native buttons with `aria-pressed`, a
  visible selected state, and SVG icons. Text filtering and the selected tag
  combine with AND semantics; selected characters remain selected when hidden.
- A logical character may have several internal upgrade IDs. Silver Wolf
  LV.999 is displayed once, appears in the cost-3, cost-4, and cost-5 filters,
  and retains all three IDs for strategy matching. Its picker portrait follows
  the active filter (blue, purple, or yellow); lineup portraits use the actual
  internal variant's cost.
- The search rail owns a stacking layer above result records, and the role
  popover owns the highest layer inside that rail. Result cards must never
  paint over an open role picker.
- The popover is capped by both its height token and the live visual viewport.
  It opens towards the larger available region when the preferred height does
  not fit below the trigger. Its toolbar and category filters stay visible while
  only the character grid scrolls, so every character remains reachable without
  moving the search rail.

### Theme toggle

- A compact 44px header button uses inline sun/moon SVGs, never emoji.
- Its accessible label describes the action (switch to dark or light), not only
  the current state.
- Toggling updates `data-theme`, `color-scheme`, browser `theme-color`, and the
  local preference without reloading or losing search state.

- Trigger exposes selected count and expands a popover containing a text filter, tag row, and checkbox grid.
- Each role chip contains a 32px portrait, localised name, and visible checked state. Portrait fields use the visible character's `displayCost`; when a grouped upgrade role is shown under a specific cost filter, that active cost controls the picker portrait colour. Cost filters use every value in `costs`. Hover uses amber-pale wash; focus is explicit; disabled roles cannot be selected. Empty and load-error states are textual.

### Strategy candidate

- Detail search combines optional title, author display name, and selected roles
  with AND matching. At least one criterion is required.

- A semantic radio card presented as a full-width tactical record, not a generic floating tile.
- Anatomy: selection control, Chinese title, author line, engagement statistics,
  description excerpt, final roster, and source link. Engagement statistics show
  the source strategy's like and save totals as labelled, read-only metadata with
  inline SVG icons: a heart for likes and a star for saves. Missing upstream
  totals resolve to zero.
- Default uses paper and a left index column. Hover darkens the rule. Selected uses amber keyline, pale wash, and a visible `已選擇` label. Focus-within uses the focus outline. Expired cards remain readable but disabled. Loading uses structured skeleton rows. Empty and error are separate status panels.

### Character portrait

- 36px in result rows, 32px in chips. Circular image with paper fallback initials, white keyline, and front/back grouping label supplied outside the image.

### Status panel

- Variants: info, success, error, empty. Always contains an SVG icon, heading, actionable body, and optional retry button. Colour is never the sole signal.

### Transfer tray

- Appears only after selection. Desktop is sticky in the right rail; mobile is a fixed bottom sheet with safe-area padding.
- Shows selected title, roster summary, disclaimer, and primary submit button. Loading locks duplicate submissions, adds the existing button spinner, and shows a working status panel with a token-coloured progress sweep. A queued transfer keeps the tray open, shows its job ID, and polls without asking the user to resubmit. Success exposes the returned global share code in the official `##…=##` wrapper and a copy button. Partial success lists every ignored item; failure and timeout states remain retryable.

### External Strategy Compendium links

- The footer presents the China and Global Strategy Compendiums as peer text links in
  a wrapping group. Both open in a new tab and use locale-specific labels.

### Administrator console

- `/admin` is an operational companion to the public compendium and reuses the
  same parchment, ink, amber, teal, rule, typography, spacing and focus tokens.
  It must not introduce a second visual language or expose administrator or
  worker secrets after sign-in.
- The signed-out state is a single-purpose authentication panel with a password
  field, a six-digit Authenticator field when TOTP is configured, submit button,
  useful error copy and no operational data in the HTML. Both fields use the
  existing Field primitive, preserve a logical password-then-code reading order,
  and remain usable at 200% zoom. Authentication uses an HTTP-only session
  cookie; neither credential is persisted by browser JavaScript.
- The signed-in state has three regions in reading order: current service
  status and usage, safety settings, then recent transfer records. Destructive
  or service-enabling settings use a danger callout and explicit explanatory
  text rather than colour alone.
- Settings are grouped by intent: submission access, source allow-list,
  per-IP limits, publishing-account daily quota, queue capacity and history
  retention. Every numeric field shows its unit and accepted range. Save,
  saving, success, validation-error and worker-unavailable states are explicit.
- The record table uses semantic table markup on wide screens and remains
  horizontally scrollable at narrow widths. Status is always text-labelled;
  IDs and timestamps use the mono token. Empty, loading and error states use
  the existing status-panel primitive.
- Authentication expiry returns focus to the sign-in heading. Successful save
  keeps focus on the save status, and refresh never discards unsaved changes
  without confirmation.
- A compact text link connects the public page and administrator console. The
  administrator route is intentionally discoverable but reveals no data until
  authenticated.

## 6. Motion & Interaction

| Token | Value | Use |
| --- | --- | --- |
| `--duration-fast` | `120ms` | Hover/focus colour |
| `--duration-normal` | `180ms` | Popover/tray entrance |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | All transitions |

- Animate only `transform`, `opacity`, and `filter`.
- Candidate selection may translate the amber marker by 2px; no decorative idle motion.
- Role popover and transfer tray enter with opacity plus 4px translate.
- The transfer working panel uses a horizontal progress sweep driven only by `transform`; it communicates active publishing and stops as soon as a terminal result arrives.
- `prefers-reduced-motion: reduce` removes transforms and collapses timings to near-zero.

## 7. Depth & Surface

Strategy: mixed, with borders as the main language and shadows reserved for floating layers.

| Level | Value | Usage |
| --- | --- | --- |
| Hairline | `1px solid var(--colour-rule)` | Cards and section structure |
| Strong | `1px solid var(--colour-rule-strong)` | Inputs and selected boundary |
| Floating | `0 12px 32px rgb(53 43 24 / 0.14)` | Role popover and mobile tray only |
| Hero | `0 18px 30px rgb(53 43 24 / 0.12)` | Decorative region-transfer diagram only |

Dark mode keeps the same two elevations with neutral shadows:
`0 12px 32px rgb(0 0 0 / 0.36)` for floating layers and
`0 18px 30px rgb(0 0 0 / 0.3)` for the hero diagram.

| Layer token | Value | Usage |
| --- | --- | --- |
| `--layer-content` | `0` | Results and ordinary page content |
| `--layer-search` | `10` | Sticky search rail above result records |
| `--layer-popover` | `40` | Role picker inside the search rail |
| `--layer-tray` | `50` | Mobile transfer tray |

In the route diagram, the light theme uses an ink CN node and amber GL node.
Dark mode changes CN to a raised charcoal node with light text and GL to bright
gold with canvas-dark text; neither endpoint may become light-on-light.

Paper texture is created with subtle CSS radial/linear gradients using declared colour tokens; no downloaded texture asset.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA: 4.5:1 for body text, 3:1 for large text and controls.
- Every control is keyboard reachable; mode tabs use tab semantics, candidate cards use native radios, and the role picker uses native checkboxes.
- Minimum touch target is 44px except decorative portraits.
- Focus indicators remain visible on all paper and amber surfaces.
- Light and dark token sets meet the same contrast targets; theme selection is
  also expressed by the toggle's accessible label.
- Search/loading/result counts use an `aria-live="polite"` region; submission errors use `role="alert"`.
- Avatar images have meaningful names; decorative SVGs are hidden.
- Portraits beside a visible character name use empty alternative text to avoid
  duplicate announcements; roster-only portraits announce the localised name.
- Long Chinese descriptions are clamped visually but remain available through an expand control.
- Motion honours reduced-motion preferences.

### Personas

- A mobile player pasting a shared URL with one hand: exact lookup must be the shortest path.
- A desktop theory-crafter comparing several lineups: title, author, description, and final roster must be scannable without opening each source page.
- A keyboard or screen-reader user: every role choice, candidate selection, and transfer state must be announced and operable without pointer input.
- An administrator operating the publishing account: current limits, queue
  pressure and recent failures must be understandable without inspecting JSON
  files or revealing credentials; keyboard-only operation and 200% zoom must
  preserve every setting and record action.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| Public transfer submission requires an external admin worker queue | `/api/transfers` | Vercel must not receive or launch the administrator's persistent browser profile | Keep submissions disabled until the worker and administrator console are configured; enforce allow-list, quota, rate and queue limits before enabling |
| Full Lighthouse audit against deployed CDN is pending | Deployment | No deployed URL exists yet | Run mobile and desktop audits after Vercel deployment |
