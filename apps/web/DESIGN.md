---
name: Phone Use Console
description: A quiet developer console for cloud phones, in light and dark, where the live phone is the only spectacle.
colors:
  ground: "#fafafa"
  surface: "#ffffff"
  ink: "#111113"
  ink-2: "#3b3b42"
  ink-hover: "#2b2b30"
  on-ink: "#ffffff"
  muted: "#6a6a73"
  faint: "#a4a4ad"
  line: "#ececef"
  line-strong: "#dcdce1"
  wash: "color-mix(in srgb, #111113 5%, transparent)"
  violet: "#6c4cff"
  violet-ink: "#5b3df5"
  green-ink: "#15803d"
  amber: "#b45309"
  red: "#dc2626"
  red-fill: "#dc2626"
  red-fill-hover: "#b91c1c"
  night: "#111114"
  night-ink: "#ececf1"
  bezel: "#0b0b0d"
  bezel-ring: "#cfcfd6"
  live-green: "#16a34a"
  screen-off: "#1a1a1f"
  boot-screen: "#17171c"
  boot-mark: "#4a4a54"
  boot-runner: "#d4d4dc"
  code-selection: "rgba(154, 134, 255, 0.45)"
  auth-night: "#101014"
  ground-dark: "#0d0d10"
  surface-dark: "#141417"
  ink-dark: "#ececf1"
  ink-2-dark: "#c9c9d1"
  ink-hover-dark: "#ffffff"
  on-ink-dark: "#111113"
  muted-dark: "#9d9da8"
  faint-dark: "#55555f"
  line-dark: "#232329"
  line-strong-dark: "#2f2f37"
  wash-dark: "rgba(255, 255, 255, 0.05)"
  violet-dark: "#9a86ff"
  violet-ink-dark: "#b3a4ff"
  green-ink-dark: "#5fdc8c"
  amber-dark: "#f0a43a"
  red-dark: "#ff6b5b"
  night-dark: "#08080a"
  bezel-dark: "#050506"
  bezel-ring-dark: "#34343c"
typography:
  display:
    fontFamily: "Geist Sans, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.9rem, 3.4vw, 2.6rem)"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Geist Sans, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "24px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist Sans, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "Geist Sans, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 600
  body:
    fontFamily: "Geist Sans, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "Geist Sans, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 500
  label:
    fontFamily: "Geist Sans, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
  mono:
    fontFamily: "Geist Mono, ui-monospace, 'SF Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "4px"
  thumb: "5px"
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.ground}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.red}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  button-danger-armed:
    backgroundColor: "{colors.red-fill}"
    textColor: "#ffffff"
  button-danger-armed-hover:
    backgroundColor: "{colors.red-fill-hover}"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "28px"
  button-create:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  button-copy:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "4px 12px"
  link:
    backgroundColor: "transparent"
    textColor: "{colors.violet-ink}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.52rem 0.7rem"
  sidebar:
    backgroundColor: "{colors.surface}"
    width: "232px"
  phone-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px"
  phone-row-selected:
    backgroundColor: "{colors.wash}"
  phone-thumb:
    backgroundColor: "{colors.night}"
    rounded: "{rounded.thumb}"
    width: "28px"
  stage-header:
    backgroundColor: "{colors.surface}"
    height: "64px"
    padding: "12px 24px 12px 32px"
  live-frame:
    backgroundColor: "{colors.bezel}"
  boot-screen:
    backgroundColor: "{colors.boot-screen}"
  agent-panel:
    backgroundColor: "{colors.surface}"
    width: "340px"
  client-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    padding: "0 0 8px"
  client-tab-selected:
    textColor: "{colors.ink}"
  code-block:
    backgroundColor: "{colors.night}"
    textColor: "{colors.night-ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: "16px"
  banner:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  auth-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    width: "384px"
    padding: "2.1rem 2rem"
---

# Design System: Phone Use Console

<!-- Boundary: apps/web (app.phoneuse.dev) ONLY. The landing app keeps its own
     dark/violet world and its own design system; nothing here applies to it. -->

## Overview

**Creative North Star: "The Phone, and As Little Else As Possible"**

This record was written from the built console after commit 914d48d ("strip the console down to the phone and what the agent did"): `app/globals.css`, `app/layout.tsx`, `lib/theme.ts`, `lib/console.ts`, `components/console/*`, `components/LiveView.tsx` and `components/PhoneViewer.tsx`. Where the build and the plans differ, the build wins. The direction contract at the top of `components/Dashboard.tsx` reads:

> THESIS: the live phone is the product. Three quiet panes: your phones, the one you're watching at full height, and one panel that shows either how to connect an agent or what it did. Everything else earns its place or goes.
>
> OWN-WORLD: DESIGN.md's canon (Geist, hairlines, ink primaries, violet only for links and focus) in light and dark; no status dots, words carry state.
>
> STORY: start a phone, copy its config into the agent, watch it work.
>
> FIRST VIEWPORT: sidebar of phones (thumbnail, name, one word); a one-line stage header over the full-height screen; the panel on the right.
>
> FORM: the merged prototype, distilled at the owner's request.
>
> FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md.

The console has three panes. A 232px sidebar lists your phones, each as a thumbnail, a name and one word. A fluid stage shows the selected phone at full viewport height inside a real night bezel, under a one-line header. A 340px panel shows one thing at a time: how to connect an agent, or what the agent did. The owner said the previous build "looks AI generated" and asked for it to be simple, so the simplification removed everything that called attention to itself: the nav block, counts, pills, status dots, ID lines, tabs, timeline nodes, footers and icon cards. What remains is text in four sizes, 1px hairlines, ink buttons and one held violet, spaced on one scale.

Light is the default. Dark follows the system until the person picks a theme with the toggle, and the choice is stored on `<html data-theme>`. Both themes share one structure and change only token values. Night objects (the bezel, the boot screen, the code block) stay dark in both themes, because they depict hardware and terminals, not page surfaces.

**Key Characteristics:**
- Three panes with the phone first: 232px sidebar, fluid stage, 340px panel; one column at 960px and below.
- One spacing scale (4, 8, 12, 16, 24, 32, 48) and four type sizes (12, 14, 18, 24) inside the console.
- State is a word, not a dot. The only dots are the live-stream pulse under the phone and the amber waiting pulse in the panel.
- Violet is for links, focus, text selection and control mode, nothing else.
- Flat: 1px hairlines and tonal steps; the input focus ring is the only shadow.
- Light and dark from one token set; night objects never invert.
- Motion is functional and switches off entirely under reduced motion.

## Colors

A neutral ground and surface, ink primaries, three state hues used only as text or one small mark, one held violet, and a few night tokens for device and code objects. Every role that changes with the theme has a light token and a `-dark` twin in the frontmatter. Components reference the role (`var(--ink)`) and the theme swaps the value.

### Primary
- **Ink** (ink / ink-dark): text, headings, the primary button fill, the selected client tab's underline, the pressed toggle's border (Hand back), the selected chip's border at narrow widths, and the logo mark. In dark it is near-white, so the primary button becomes a light button with dark text (on-ink flips with it). Hover uses ink-hover.
- **Second Ink** (ink-2 / ink-2-dark): text that sits between ink and muted: inline code, banner copy, the control banner and the Usage summary line.

### Secondary
- **Held Violet** (violet / violet-dark): the `:focus-visible` outline, text selection (22% mix), the focused input's border and 14% ring, the control-mode frame outline, and the 8% hover wash on link buttons.
- **Violet Ink** (violet-ink / violet-ink-dark): violet as text: the auth mode switch and links inside prose. Buttons never use it. It is darker than violet in light and lighter in dark so link text stays legible on both.

### Tertiary (state hues, as text)
- **Working Green** (green-ink / green-ink-dark): the word "working" in the sidebar, and nothing else. **Live Green** (live-green) is a fixed literal used only for the live-stream dot.
- **Caution Amber** (amber / amber-dark): the waiting pulse, the stage's time left under five minutes, and the "Shown once" line for a fresh key.
- **Danger Red** (red / red-dark, red-fill, red-fill-hover): the word "failed", the create-failure notice, danger buttons, error lines and the error banner's border (30% into line). An armed destructive button fills with red-fill and white text. Red-fill has no dark twin, so the armed fill is the same in both themes while red text lightens to red-dark.

### Neutral
- **Ground** (ground / ground-dark): page background, the stage canvas, the account sections, and the hover fill of secondary and copy buttons.
- **Surface** (surface / surface-dark): sidebar, stage header, panel, banners, inputs and the auth card.
- **Muted** (muted / muted-dark): every state word except working and failed, short IDs, times, the stage meta, hints, the sidebar's bottom links, Sign out and table headers. The stylesheet records 4.9:1 on white and 4.7:1 on ground in light.
- **Faint** (faint / faint-dark): non-text marks only: the "·" before the stage meta, hover borders on secondary buttons and inputs, and the live dot when the stream is stale.
- **Hairline** (line / line-dark): pane edges, the stage header's bottom edge, banners, the client tabs' baseline, the rules around the key state, table rows, the user-row divider and narrow phone chips.
- **Strong Hairline** (line-strong / line-strong-dark): borders on controls: secondary and copy buttons, inputs, thumbnails and `kbd`.
- **Wash** (wash / wash-dark): 5% ink in light, 5% white in dark. Hover and selected fill on phone rows, hover on icon and create buttons, the key box, and inline code.

### Night Objects
- **Night** (night / night-dark) with **Night Ink** (night-ink): the code block in the panel, the key-usage `pre`, and the backing behind sidebar thumbnails.
- **Bezel** (bezel / bezel-dark) with **Bezel Ring** (bezel-ring / bezel-ring-dark): the device frame and its 1px edge, light gray in light so the black frame has an edge against the near-white ground.
- **Screen Off** (screen-off): the screen before a stream's first frame; its "Waiting for the phone…" caption is #9a9aa6.
- **Boot Screen**, **Boot Mark**, **Boot Runner** (boot-screen, boot-mark, boot-runner): a phone with no stream yet. The track under the runner is 10% white; a booting sidebar thumbnail shows a 2px bar at 30% white.
- **Code Selection** (code-selection): text selection inside the code block, with white text.
- **Auth Night** (auth-night): the auth statement panel, fixed in both themes.

### Named Rules
**The Violet-Is-Interaction Rule.** Violet marks links, focus, text selection and the person's own control of the phone, and nothing else. It never fills a button and never marks a selected row (selection is a wash). As a fill it is only a tint: the 8% hover wash on link buttons. The 30% radial glow on the auth statement panel is the one held exception.

**The Words-Carry-State Rule.** A phone's state is one lowercase word. Only "working" (green-ink) and "failed" (red) take a color; every other word is muted. There are no status dots: the only dots in the console are the live-stream pulse under the phone and the amber waiting pulse in the panel, and each sits beside words that say the same thing.

**The Night Object Rule.** The bezel, the boot screen and the code block stay night in both themes. Their tokens deepen slightly in dark but never invert. The page theme never reaches inside a phone or a code block.

**The Twin Block Rule.** Dark values are declared twice in globals.css: in `@media (prefers-color-scheme: dark)` on `:root:not([data-theme="light"])`, and on `:root[data-theme="dark"]`. Any change to a dark token edits both blocks identically.

## Typography

**Body Font:** Geist Sans (`geist/font/sans`, variable `--font-geist-sans`; fallback -apple-system, "Segoe UI", sans-serif)
**Label/Mono Font:** Geist Mono (`geist/font/mono`, variable `--font-geist-mono`; fallback ui-monospace, "SF Mono", monospace)

**Character:** One quiet grotesk at a 14px base, antialiased, with Geist Mono for machine values. Tabular figures are set only where numbers change in a column: activity times (in Geist Mono) and the Usage "Billed" column.

### Hierarchy
- **Display** (650, clamp(1.9rem, 3.4vw, 2.6rem), 1.1, -0.03em): the auth statement only. Balanced wrap, max 13ch, #fdfdfe on the auth night panel.
- **Headline** (600, 24px, -0.02em): the first-run heading, the closed receipt, and the API key and Usage headings.
- **Title** (600, 18px, -0.01em): the device name in the stage header and the failed-phone heading.
- **Heading** (600, 14px): the panel headings ("Connect your agent", "Activity"), banner headings, "Phones" at the top of the sidebar, and the current bottom link (Usage or API key).
- **Body** (400, 14px, 1.5): activity sentences, the stage meta, section intros, table cells and the sidebar's bottom links. Centered first-run and receipt copy is capped at 40ch.
- **UI** (500, 14px): button labels, phone names and client tabs.
- **Label** (400, 12px): state words, short IDs, times, hints, the live note and the create-failure notice. Table headers, create buttons and copy buttons use it at 500.
- **Mono** (Geist Mono, 12px; 1.6 in code blocks): IDs, activity times, config, keys. Inline code is 12px on wash, padded 0 4px with a 4px radius, in ink-2.

Weights inside the console are 400, 500 and 600. The auth screen also uses 550 and 650, and the shared wordmark is 700. No uppercase and no positive letter-spacing anywhere.

The auth screen and the `/phones/<id>` viewer size their type in rem (auth heading 1.35rem, labels 0.8rem, legal line 0.75rem; viewer heading 1rem, caption 0.85rem). Everything inside the console shell uses the four px sizes.

### Named Rules
**The Four Sizes Rule.** Inside the console, type is 12, 14, 18 or 24px. Hierarchy comes from those four steps, from weight (400, 500, 600) and from ink against muted. Only the auth screen uses a display clamp.

**The Mono-Is-Machine Rule.** Geist Mono marks values a machine produces or reads: phone IDs, the MCP config and shell exports, the API key and its mask, file and variable names in inline code, and `kbd`. Activity times are mono too, so the time column lines up. Mono is never used for headings or decoration.

## Layout

- **Shell:** a CSS grid at min-height 100dvh with columns `232px minmax(0, 1fr)`, becoming `232px minmax(0, 1fr) 340px` when the panel shows. The panel shows only in the Phones section, for a selected phone that is running, preparing or queued. Sidebar and panel are sticky at full viewport height and scroll on their own, the sidebar with a right hairline and the panel with a left one.
- **Sidebar:** pads 24px 12px 16px, a column with 32px between the logo, the phone list and the foot; the foot (Usage, API key, Docs, then the user row) is pushed to the bottom.
- **Stage:** the header, the control banner while in control, then the canvas. The header is at least 64px tall, pads 12px 24px 12px 32px, and has a bottom hairline. The canvas centers the phone with 32px 24px padding and sizes it from viewport height: iPhone width clamp(220px, (100dvh − 200px) × 0.46, 340px); Android clamp(216px, (100dvh − 200px) × 0.45, 330px). Above 960px, control mode shrinks the iPhone to clamp(200px, (100dvh − 290px) × 0.46, 340px) to make room for the banner and toolbar.
- **Panel:** pads 24px, a column with 16px between blocks. Activity rows pad 8px vertically.
- **Centered states** (first run, closed receipt): 12px gaps, padding 48px 24px 12vh, buttons 24px below the copy.
- **Account sections** (API key, Usage): max-width 1120px, padded 48px, the heading block 24px above the content.
- **Banners:** above the stage, 16px from the top and 32px from the sides, padded 12px 16px.
- **Spacing:** one scale, 4, 8, 12, 16, 24, 32 and 48px, written as plain px values. Rows in a list sit 4px apart (phone rows, bottom links, create buttons, a phone's name and its word). Every padding and gap in the console is on this scale; dimensions such as the 6px dots and the 20px chip thumbnail are sizes, not spacing.

**At 960px and below:** one column in DOM order: top bar, main, panel.
- The sidebar becomes a two-row top bar. Row one has the logo mark on the left (the wordmark is visually hidden) and Usage, API key, Docs, the theme toggle and Sign out on the right (the user's name is visually hidden). Row two is a horizontally scrolling strip of phone chips, followed by the create buttons. A chip has a 20px thumbnail, the name and the state word, a 1px hairline border and 4px 12px 4px 4px padding; the selected chip gets an ink border instead of a wash. The "Phones" heading and the short ID are visually hidden. A create failure spans the full width.
- The stage header pads 12px 16px with no minimum height, the canvas pads 24px 16px, and the phone is min(260px, 68vw) wide.
- The panel follows the stage. It is static, has a top hairline and pads 24px 16px.
- Account sections pad 24px 16px 48px.

**At 560px and below:** the stage actions take their own full-width row, left-aligned, and the key state stacks.

**At 880px and below:** the auth split becomes one column and the statement panel is removed.

**Deep links:** the section lives in the URL (`?section=keys` or `?section=usage`; Phones is the bare path) through `pushState`, so a refresh keeps it and Back walks between sections.

## Elevation & Depth

The system is flat. Depth comes from 1px hairlines and three tonal steps: ground (page, stage canvas, sections), surface (sidebar, stage header, panel, banners), and night objects (bezel, code block), which are the darkest layer in both themes. Hover and selection are 5% washes; control mode adds the violet outline around the phone. Nothing lifts, scales or casts a shadow on hover.

### Shadow Vocabulary
- **Focus ring** (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--violet) 14%, transparent)`): the only box-shadow in the app, on focused inputs together with a violet border.

### Outline Vocabulary
- **Focus outline** (`outline: 2px solid var(--violet); outline-offset: 2px`): every `:focus-visible`; it follows the element's own radius. Headings that take focus programmatically (the stage name, first-run, receipt and section headings) suppress it.
- **Control outline** (`outline: 2px solid var(--violet); outline-offset: 4px` on the live frame, outline-color transition 0.15s): shown while the person controls the phone.

### Named Rules
**The Hairline Rule.** Regions separate with a 1px line or a tonal step, never a shadow. The only lines thicker than 1px are the two violet outlines, the 2px ink underline on the selected client tab, and the 2px boot and booting-thumbnail bars.

## Shapes

Quiet rounded rectangles on a rectilinear grid. The radius ladder, by role:
- **4px** (xs): inline code, `kbd`, Android thumbnails and the narrow-width thumbnails.
- **5px** (thumb): iPhone thumbnails in the sidebar.
- **6px** (sm): the skeleton's caption bar. Every button uses 8px.
- **8px** (md): primary, secondary and danger buttons, inputs, phone rows, banners, the code block, the key box and the key `pre`.
- **12px** (lg): the auth card only.
- **Circles** (50%): the live dot and the waiting pulse.
- **44px**: the stage skeleton's phone block.

**The Real Bezel Rule.** Device frames are drawn in container-query units on the `.dash-live` container, so the bezel scales with the screen at any size. iPhone: a 402:874 screen, frame radius 16.5cqw, screen radius 13.2cqw. Android: a 540:1200 screen, frame radius 11cqw, screen radius 8cqw. Both pad the screen by 3.4cqw inside a bezel-colored frame with a 1px bezel-ring edge. Every depiction of a device (sidebar thumbnail, narrow chip, stage skeleton) keeps the true screen ratio for its platform.

**The Shared Mark Rule.** The viewfinder logo (`.logo`, `.logo-mark` with `::before`/`::after` corner brackets and a rotated 6px center square) is a binding brand asset whose markup and CSS are shared verbatim with the landing app. Never redraw, restyle or approximate it. It draws in `var(--ink)`, so it follows the theme. To tint it, set `--ink` on a parent, as the boot screen does with boot-mark; never edit the mark. Load-bearing dependency: the box-sizing reset **must** cover pseudo-elements (`*, *::before, *::after { box-sizing: border-box; }`), because the corner brackets are pseudo-element borders and break under `content-box`.

## Components

### Buttons
One shape, four variants, two sizes. Every button is 32px tall (28px with `.is-sm`), has an 8px radius, weight 500, a 6px icon gap and a 1px border slot (transparent where unused), so no variant is a pixel taller or wider than another. Text is 14px, or 12px at `.is-sm`. Disabled is 0.5 opacity. Background, border and color change over 0.12s.
- **Primary** (`.dash-btn`): ink fill and border, on-ink text; hover goes to ink-hover. One per view at most: New iPhone, Copy config, Approve, Generate key, Start a new iPhone, Copy link in the viewer. The auth card's full-width submit (`.dash-btn-block`) is 38px to match its inputs.
- **Secondary** (`.dash-btn2`): surface with a line-strong border; hover goes to ground with a faint border. As a toggle (`aria-pressed="true"`) the border turns ink; this is how Take control becomes Hand back. Also New Android phone, View usage, Deny, Rotate key, Try again (small), Copy in the key box (small), and Home, Return and Paste in control mode.
- **Ghost** (`.dash-ghost`): no fill or border, muted text; hover adds the wash and ink text, and `aria-current="page"` makes it ink at 600. Every quiet action: the sidebar's New iPhone / New Android phone (with a plus), Usage, API key, Docs and Sign out; and, at the small size, Dismiss, the panel's Connection / Activity switch, Use screenshots / Use live video, and the viewer's "← Console". Inside the sidebar, ghost buttons pad 0 8px so their text lines up with the phone rows.
- **Danger** (`.dash-danger`): the secondary shape with red text; hover adds a 6% red tint and a redder border. Armed (`.is-armed`), it fills red with white text (see Two-Step Guarded Actions). Close in the stage header.
- **Icon** (`.dash-iconbtn`): a square ghost, 32px (28px at `.is-sm`) with a 14px glyph. The theme toggle, the small copy-ID button and the verification banner's dismiss.
- **Not buttons:** the client tabs (Claude Code, Cursor, Shell) are tabs with an ink underline, and the "Phones" heading is a plain text nav item.
- **Copy:** one shared button whose label flips to "Copied" (or "Copy failed") for 1.6s inside an `aria-live="polite"` span. It renders as whichever variant its place needs: the small icon button (phone ID), small secondary (key box), primary (Copy config).
- `:focus-visible` draws the 2px violet outline at a 2px offset without changing the button's radius.

### Two-Step Guarded Actions (signature)
Destructive actions never fire on the first click. The first click arms the control: it relabels ("Close" becomes "Confirm close", "Rotate key" becomes "Replace current key?") and fills with red-fill and white text. The armed close button also gets a visually hidden description: "Click again to close this phone. Its connection token ends with it." The second click fires. An armed control disarms after 4 seconds. While a phone closes, the button is replaced by muted "Closing…" text with `role="status"`, and the sidebar word reads "closing". On a failed phone the button reads "Dismiss".

### Inputs / Fields
- **Style** (`.dash-input`): surface, 1px line-strong, 8px radius, padding 0.52rem 0.7rem, muted placeholder.
- **Hover:** the border goes to faint. **Focus:** violet border plus the focus ring, which replaces the native outline.
- **Errors:** a red `.dash-error` line with `role="alert"`; inputs carry no error styling.
- The paste field in the control toolbar is the same input with 8px 12px padding.

### Sidebar (navigation)
A 232px sticky column on surface.
- **Logo:** the shared mark and the 14px wordmark, linking to phoneuse.dev.
- **Phones:** "Phones" (14px/600, ink) heads the list and is itself the Phones nav item (`aria-current="page"`). New iPhone and New Android phone (ghost buttons with a plus) sit under the list. Each row is a 28px thumbnail, then the device name (14px/500) with a 4-character mono short ID in muted, and the state word under it (12px). Rows are 8px padded with an 8px radius and a 12px gap; hover and the selected row (`aria-current="true"`) get the wash. Queued and preparing phones show a pulsing bar instead of a thumbnail. With no phones, the list reads "No phones running." in muted. A create failure appears under them as 12px red text with Try again (small secondary) and Dismiss (small ghost), `role="alert"`.
- **State words:** working (green-ink), failed (red), and in muted: idle, no agent yet, running, starting, queued, #N in line, closing.
- **Bottom:** Usage, API key and Docs as plain muted text links (the current one in ink at 600), then the user row below a hairline: the name, the theme toggle and a muted Sign out.
- **Thumbnail:** 28px wide at the platform's true screen ratio, on night with a line-strong border and a 5px radius (4px for Android).

**The Quiet Thumbnail Rule.** A sidebar thumbnail is one frame taken from the phone's `/stream` socket, after which the socket is closed (it gives up after 8 seconds). It never uses the screenshot RPC, because RPC calls land in the action log as if the agent had acted. Opening `/stream` also counts as activity and keeps a phone alive, so a frame is taken only right after an agent action, never on a timer: the refresh key changes at most once per 15-second window, and only while the last agent action is less than 60 seconds old. An idle phone keeps its last frame and is never kept alive by its thumbnail.

### Theme Toggle
One icon button in the user row: a moon in light, a sun in dark, labelled "Use dark theme" or "Use light theme". It reflects the theme on screen (the system setting resolves through the media query) and stores an explicit `light` or `dark` under `phone-use-theme` in localStorage and on `<html data-theme>`, unless the new theme matches the system setting, in which case it clears the saved choice and follows the system again. A first visit follows the system. An inline script in `<head>` applies the stored choice before first paint, so a dark-theme user never sees a white flash. The `theme-color` meta follows the system (#fafafa light, #0d0d10 dark), and each theme sets `color-scheme` so native controls and scrollbars match.

### Stage Header
One line that wraps only when tight: the device name (18px h1, which takes focus without an outline), the 12-character mono short ID in muted with an icon copy button, then the meta after a faint "·": "48 min left" while running (amber under five minutes) or the state word (starting, #N in line, queued, closing, reconnecting, failed). The actions are pushed right: Take control (iOS phones that are running and connected) and Close.

### Live View and the Night Bezel (signature)
The frame (see the Real Bezel Rule) shows the real screen: H.264 video on iOS, `/stream` JPEG frames on Android. Under it, the live note (12px muted, centered) shows a 6px pulsing live-green dot with the stream state ("Live video", "Live screen · updating", "Screenshot mode · updating", "Video paused · tab hidden") and, on iOS, a link to switch between video and screenshots. When the stream is not live, the screen dims to 0.45 opacity over 0.3s and the dot turns faint and stops pulsing.
- **Boot frame:** queued, preparing, closing and reconnecting phones show the bezel with a boot-screen fill, the shared mark tinted boot-mark, and a 40%-wide 2px track with the boot runner moving across it (20cqw between mark and track). A caption under it says what is happening ("Starting, usually a few seconds", "Waiting for a free phone, about 2 min").
- **Failed:** a centered note with an 18px heading ("This iPhone didn't start"), the error in muted, and "Start a new iPhone".

### Control Mode
Take control (the secondary toggle) adds three things: a control banner under the stage header (surface, ink-2 text, a bottom hairline, padding 8px 32px: "You're controlling the phone. Your taps can interrupt the agent. Esc hands it back." with a `kbd`); the 2px violet outline at a 4px offset around the frame; and a toolbar under the screen with Home and Return (secondary, equal width) and a paste field with Paste. Esc or Hand back returns to watching. Selecting a different phone always starts in view-only mode.

### Agent Panel
One view at a time. Each view opens with a row holding a 14px/600 heading and, on the right, a small ghost button to the other view (on Connect, only once the agent has acted). The panel opens on Connect until the phone's first agent action, then on Activity; a manual choice is remembered per phone.
- **Connect your agent:** one muted sentence ("Add this to your agent. The token stops working when the phone closes."); client tabs (Claude Code, Cursor, Shell) as plain 14px/500 text on a hairline, the selected one in ink with a 2px ink underline (`role="group"`, `aria-pressed`); the config in a night code block (Geist Mono 12px/1.6, 16px padding, scrolls horizontally) with the token masked to its first and last four characters; one primary Copy config button that copies the real token; a 12px muted line saying where to save it (`.mcp.json`, `.cursor/mcp.json`, or a terminal); and, until the agent acts, the waiting line: a 6px amber pulse beside "Waiting for your agent's first action…", which after 30 seconds becomes "Still waiting. Restart your agent so it loads the config, then ask it to do something on the phone."
- **Activity:** the phone's real action log, newest first, as plain rows: a 64px column with the 12px muted clock time (Geist Mono, tabular), then one sentence ("Tap “Track order”", "Read the screen (3×)"). Repeated screen reads fold into one row with a count. The person's own input reads "Your input from this console". Rows have no nodes, icons or dividers.

### Banners
Above the stage: surface, 1px hairline, 8px radius, a 14px/600 heading and copy in ink-2 (muted when it follows a heading; max 64ch). The CLI approval banner offers Approve (primary) and Deny (secondary); the email-verification note has an icon dismiss; an error banner has a red-tinted border (30% red into line) and a Dismiss link. No banner has a tinted fill.

### First Run and Closed Receipt
Both are centered states with one heading, one sentence and buttons.
- **First run** (no phones): "Give your agent a phone", "Start a phone, add its config to your agent, and watch it work here.", then New iPhone (primary) and, with Android enabled, New Android phone (secondary).
- **Closed receipt:** "iPhone closed", then "12.4 min billed · 7 agent actions" in muted, then New iPhone (primary) and View usage (secondary).

### API Key and Usage
Each section is a 24px heading with one muted sentence under it.
- **API key:** two columns from 1200px (one below), each under a 14px/600 sub-heading with a hairline: **Your key** and **Use it**. Your key: "Active key · created 3 d ago", the masked key in 12px mono muted, a 12px muted note and Rotate key (secondary) on the right, which arms to "Replace current key?"; a fresh key shows the amber "Shown once" line and the key in a wash box with Copy; with no key, one muted line and Generate key (primary). Use it: two short steps, From your terminal (`phone-use login`, which opens this console to approve and replaces the current key, then `phone-use create ios`) and In scripts and CI (`PHONE_USE_CLOUD_URL` and `PHONE_USE_CLOUD_TOKEN` exports), each a night code block that wraps long values (breaking mid-value, so `export NAME=` stays on its line), with a small Copy at the right of the step's heading. The commands come from the CLI source.
- **Usage:** three figures (Minutes billed, Sessions, Running now: 12px muted labels over 24px/600 tabular numbers, 48px apart, no boxes), then **Minutes billed per day** for the last 14 days, then the full session table. The chart is a single series, so it has no legend; its caption names it and gives the 14-day total. Columns are at most 24px wide in ink-2 (ink on hover) with 4px rounded tops, square on a line-strong baseline, 2px apart, over a 160px plot; days are bucketed by session end in local time. Only the peak day carries a direct value label; every day shows its date and minutes in a tooltip on hover, and the table below is the accessible data view (the plot has a summary `aria-label`). Axis labels are 12px muted day numbers, with the month on the first day and on the 1st; at narrow widths only the first and last show. The table: 12px/500 muted headers, cells padded 12px with hairline rows, IDs in mono muted, billed minutes tabular, end time and reason muted; it scrolls inside its wrapper with a 560px minimum width.

### Loading
- **Stage skeleton** (first load only, `aria-hidden`): a 280px phone-shaped block at 402:874 with a 44px radius and a 160px × 12px bar, both shimmering between line and ground.
- Until the session check answers, the console renders an empty auth-split shell, so a signed-in person never sees the sign-in form flash.

### Auth
A 0.9fr / 1.1fr split on ground. The left statement panel has fixed colors in both themes: an auth-night fill with a 30% violet radial glow from the bottom left, the display statement in #fdfdfe, a 1rem paragraph in #9a9aa6 (max 34ch) and a 0.8rem footnote in #8a8a95. The right side holds a 384px auth card: the logo, a 1.35rem/650 heading, a muted subline, Continue with Google (bordered like a secondary button, 550), an "or" divider of two hairlines, labelled inputs, a full-width primary button, a violet-ink mode switch and a muted legal line.

### Phone Viewer (`/phones/<id>`)
A standalone page on ground. A bar holds "← Console" (link button), a 1rem heading with the ID in mono at 0.8rem, and Copy link (primary). The live view is min(100%, 420px, (100dvh − 200px) × 402/874) wide and at least 220px, with an Enable controls toggle and the same Home / Return / Paste toolbar on iOS.

### Motion
- **dash-pulse** (1.6s ease-in-out infinite; opacity 0.4 at 50%): the live dot, the waiting pulse and the booting thumbnail bar. It stops when the stream is stale.
- **dash-boot** (1.5s, `--ease` = cubic-bezier(0.16, 1, 0.3, 1), infinite; translateX from −100% to 230%): the boot runner.
- **dash-shimmer** (1.4s linear infinite; a 200% gradient sweep): the stage skeleton.
- **State changes:** 0.12s ease on background and border; 0.15s on the control outline; 0.3s on stale dimming.

**The Kill-Switch Rule.** `prefers-reduced-motion: reduce` sets `animation: none` and `transition: none` on everything, with `!important`.

## Do's and Don'ts

### Do:
- **Do** keep the live phone the largest thing in the first viewport: size it from viewport height inside the 232px / fluid / 340px shell.
- **Do** take spacing from 4, 8, 12, 16, 24, 32 and 48px, and type from 12, 14, 18 and 24px, inside the console.
- **Do** say a phone's state in one lowercase word, coloring only "working" (green-ink) and "failed" (red).
- **Do** define every new color as a token in the light `:root` and in both dark blocks, and reference roles (`var(--ink)`) in components.
- **Do** keep bezels, boot screens and code blocks night in both themes.
- **Do** draw devices in container-query units at the platform's true screen ratio (402:874 iPhone, 540:1200 Android).
- **Do** guard destructive actions in two steps (arm, relabel, red fill, confirm; disarm after 4 seconds; "Closing…" while it runs).
- **Do** take sidebar thumbnails as one `/stream` frame right after an agent action, and at no other time.
- **Do** give every secret and snippet a copy button that announces through `aria-live`, and mask tokens on screen while copying the real value.
- **Do** collapse to the top bar at 960px, visually hiding the wordmark and the "Phones" heading rather than removing them, and keep `?section=` deep links and `aria-current`.
- **Do** keep the dependency posture: next, react, react-dom, geist and @vercel/analytics only; inline stroke SVG icons (15px, 1.4 stroke, currentColor); no icon packages.

### Don't:
- **Don't** redraw or restyle the shared logo mark, or narrow the box-sizing reset; tint the mark only by setting `--ink` on a parent.
- **Don't** add status dots, count pills, badges, counted tabs, timeline nodes, icon cards or panel footers; the simplification removed them on purpose.
- **Don't** fill a button, mark a selection or color a heading with violet.
- **Don't** let the page theme invert a bezel, boot screen or code block.
- **Don't** refresh thumbnails on a timer or through the screenshot RPC; a timer keeps idle phones alive, and the RPC writes fake agent actions into the log.
- **Don't** use faint for text a person needs to read; it is for marks.
- **Don't** introduce shadows, hover lifts, uppercase or tracked labels, or a fifth type size inside the console.
- **Don't** show closed or errored sessions among the phones; they belong to Usage.
- **Don't** edit one dark token block without the other.
- **Don't** import landing CSS or its dark/violet world; the console and landing are separate worlds sharing only the logo and voice.
