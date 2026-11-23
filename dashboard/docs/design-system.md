# Dashboard design system

## Shared stylesheet and document contract

Link `/dashboard.css` before view-specific styles. Use its custom properties for shared colors, type, and spacing. Keep view layout and SVG geometry in the view. The stylesheet requires no build step.

Every standalone view begins with `<a class="skip-link" href="#main">Skip to main content</a>`, followed by `<main id="main">` and one `<h1 id="view-title" tabindex="-1">` inside it. Focus the heading on explicit view navigation. The shell uses a banner, a `<nav aria-label="Views">` containing the tablist, and a main landmark for its panels.

| Shell contract | View behavior |
| --- | --- |
| `localStorage["zm.paused"] === "1"` | Pause updates before poll rendering and on the `storage` event. Provide a pause control when standalone. |
| `localStorage["zm.keys"] === "off"` | Disable single-key shortcuts and hide keycap hints. |
| `window.parent.zm.announce(text, {assertive})` | Use the shell announcer when available. Embedded views announce view-specific changes. Standalone views own their connection and freshness announcements. |
| `window.parent.zm.modal(open)` | Notify the shell when an embedded modal opens or closes so the shell header and tabs can become inert. Guard calls and support direct view URLs. |

Display times with a visible UTC suffix. Use sentence case and tabular numerals for counts and times.

## Color tokens

Use 4.5:1 for regular text and 3:1 for large text, control boundaries, meaningful graphics, and focus rings. The contrast test applies the WCAG relative-luminance formula to the pairs below. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

| Token | Light | Use and checked surfaces |
| --- | --- | --- |
| `--canvas` | `#E8ECF0` | Page backdrop |
| `--surface` | `#FFFFFF` | Cards, dialogs, tables, fields |
| `--surface-subtle` | `#F4F6F9` | Table headings, keycaps, quiet surface |
| `--surface-hover` | `#EDF1F5` | Hover state |
| `--surface-selected` | `#E1EBFA` | Selected and pressed state |
| `--text` | `#1C2630` | Primary text on all five neutral surfaces |
| `--text-secondary` | `#44515D` | Secondary text on all five neutral surfaces |
| `--text-muted` | `#526173` | Help, counts, and headers on all five neutral surfaces |
| `--placeholder` | `#5F6D7E` | Optional hint within a visibly labeled field on surface or subtle |
| `--divider` | `#CBD3DC` | Decorative rules and panel edges |
| `--accent` | `#1457A8` | Links, selection, and focus on all five neutral surfaces, primary fill |
| `--accent-hover` | `#0F4688` | Primary hover fill |
| `--on-accent` | `#FFFFFF` | Button or chip text on accent and accent hover |
| `--control-border` | `#6B7B8E` | Control edges on all five neutral surfaces and danger tint, neutral graph edges |
| `--disabled-text` | `#5B6878` | Disabled text on disabled background |
| `--disabled-bg` | `#E4E9EE` | Disabled control fill |

Keep text and meaningful graphics at full opacity. Place fields in a surface or subtle section and keep their visible labels. Use the divider only where another cue identifies the component.

### Status and identity

Use a word and a decorative icon together. Each status ink is text on its corresponding tint and a meaningful stroke against canvas or surface. The tint is supplementary.

| `data-role` | Ink token | Tint token | Labels and icons |
| --- | --- | --- | --- |
| `danger` | `--danger` · `#9A1F27` | `--danger-tint` · `#FCE8EA` | Urgent, Blocked (octagon), Merge freeze (lock) |
| `warning` | `--warning` · `#6E4300` | `--warning-tint` · `#FFF0D0` | Warning, Needs work (triangle), Offline (slashed circle) |
| `success` | `--success` · `#12603A` | `--success-tint` · `#E1F4E9` | Live, Ready, Passed, Merged (check in a circle) |
| `info` | `--info` · `#154E96` | `--info-tint` · `#E6EFFD` | Info, Landing (information circle) |
| `neutral` | `--neutral` · `var(--text-secondary)` | `--neutral-tint` · `#ECF0F4` | CI running (clock), Stacked (layers), On hold (pause), Idle (dash in a circle) |
| `ask` | `--ask` · `#4A2A9E` | `--ask-tint` · `#EFE9FD` | Ask, dependent pull request (speech bubble) |

Graph and ATC share the shell's slug-to-color function when available. The fallback palette is `--identity-1` through `--identity-8`, in order `#B4531A`, `#5B3FB5`, `#0B7A78`, `#1F5FBF`, `#A8316F`, `#5E7410`, `#8F4A26`, and `#2F6F3A`. Use `--identity-fallback` (neutral ink) for unknown sessions. Put the session name alongside the mark, or use `--on-identity` for white labels on the fill. The fill clears 3:1 against canvas.

Use dash patterns, terminal markers, and text labels to distinguish relationships. Use shape to distinguish event types, such as circles for tests and squares for builds. Place opaque surface/ink label plates under text crossing a line or hatch. Provide an HTML equivalent from the same model before the chart in DOM order and at narrow widths. Keep the SVG named with `role="img"` and a short description.

## Type, space, and interaction

Keep the root at 100% and load `--font-ui` for general text. Use `--font-mono` for identifiers, hashes, keycaps, and times. `.mono` and `.tabular` apply font and number formatting independently.

| Size and line tokens | Value | Weight and use |
| --- | --- | --- |
| `--text-xs`, `--line-xs` | 0.75rem / 1rem | 600 for table headers and chips, also for counts, hints, and keycaps |
| `--text-sm`, `--line-sm` | 0.875rem / 1.25rem | 400–600 for the default UI, tables, and buttons |
| `--text-md`, `--line-md` | 1rem / 1.5rem | 400–600 for prose, dialogs, fields, and card titles |
| `--text-lg`, `--line-lg` | 1.25rem / 1.75rem | 650 for section and dialog headings |
| `--text-xl`, `--line-xl` | 1.5rem / 2rem | 650 for view titles |
| `--text-metric`, `--line-metric` | 2rem / 2.25rem | 650 for headline metrics |

Use at least 12 CSS px for all text, including SVG at its fit scale. Leave heading and label case intact.

- `--space-1` through `--space-7` equal 4, 8, 12, 16, 24, 32, and 48 CSS px at the default root. Use `--page-inset` for 16px below 48rem and 24px from 48rem. Use 16px inside cards, 8px between controls, 4px between a label and its field, and 24px between sections.
- `--radius-sm`, `--radius-control`, `--radius-card`, `--radius-dialog`, and `--radius-pill` equal 4, 6, 8, 12, and 999px. Use a 1px divider for cards, panels, and tables. Use `--shadow-pop` for popovers and toasts, `--shadow-dialog` for dialogs, and `--backdrop` on modal backdrops.
- Standalone targets are at least 24×24 CSS px with at least 4px between controls. `--control-size` is 36px by default and 44px with a coarse pointer. Inline text links stay underlined.
- At 40rem stack or expand form rows and title/status as space allows. At 48rem switch between single-column views and expanded navigation. At 64rem enable side-by-side inspectors or rails. Use `minmax(0, …)` grid tracks and keep track minimums at or below 16rem. Scroll wide plots and tables inside independently labeled regions with a linear equivalent. Below 30rem tall the shell scrolls normally.
- The focus ring is 2px accent with a 2px offset. Use `.focus-inset` on clipped targets and `.focus-halo` on saturated fills. Sort buttons use inset focus, and primary buttons have a halo. Sticky regions set scroll padding to their header height plus 8px. Focus targets have 8px block scroll margin.
- Limit transitions to 200ms and use static shapes for state. The reduced-motion media rule removes animations, transitions, and smooth scrolling. Honor the same preference when triggering motion in JavaScript.

## Component markup

| Primitive | Markup and behavior |
| --- | --- |
| `.btn` | Secondary by default. Add `.btn--primary`, `.btn--ghost`, or `.btn--icon`. Icon-only controls have an accessible name and a matching tooltip. Toggle buttons use `aria-pressed`, and disabled controls have nearby reason text. For an in-flight action, keep focus with `aria-disabled="true"`, guard the action in JavaScript, and change the label to “Sending…”. |
| `.field` | Apply to the control. Use a visible `<label for>` (optionally `.field-label`), `.field-help` linked with `aria-describedby`, and an always-mounted `.field-error[role="alert"]` for errors. Use `aria-invalid` and pair error text with the urgent icon. Use radio groups inside `fieldset`/ `legend` for one-of-many filters, pressed buttons for independent toggles, and expanded buttons for disclosures. |
| `.chip[data-role]` | Use a span for static status, or a native button or link for an action. Include an icon and a word. `.chip--emphasis` uses accent and on-accent for “Landing”. Keep interactive chips outside other interactive targets. |
| `.tbl` | Native table, caption, column headers with `scope="col"`, identifier headers with `scope="row"`. `.numeric` aligns numbers to the end and uses tabular numerals. Sort using a button inside a header, with `aria-sort` on the header and a decorative direction cue. Use `.tbl-scroll` with `role="region"`, a name, and `tabindex="0"` for wide tables. |
| `.card` | Section with a real heading, labeled by the heading. Use a link in the heading and separate action buttons. |
| `.dialog` | Native dialog opened with `showModal()`, labeled by its heading, with a visible Close control. Use `.dialog-body` for scrolling content and a wrapping footer for actions. Focus the first relevant field or the Help heading. On Cancel, Close, or Escape, restore the actual opener, with a fallback to the enabled Message button or selected tab. A backdrop dismissal requires both pointer-down and click on the backdrop. |
| `.state[data-state]` | Use `loading`, `empty`, `no-match`, `error`, or `stale`. Loading uses `aria-busy`. Empty follows a successful request. No match offers to clear filters. Error offers Retry. Stale retains content and shows the last successful snapshot time. |
| `.ic.ic-*` | Decorative 16px CSS mask with `aria-hidden="true"` and a visible word nearby. Names are `urgent`, `warning`, `success`, `info`, `neutral`, `locked`, `offline`, `clock`, `layers`, `pause`, `ask`, `external-link`, `close`, and `chevron`. |
| `.sr-only`, `.live-region` | Visually hidden text remains available to assistive technology. Mount an empty `role="status" aria-atomic="true"` and an empty `role="alert"` at initial render. Announce state transitions, send outcomes, and filter result changes. Keep routine poll and clock ticks silent. |
| `.skip-link` | First link in the document, points to `#main` and becomes visible on focus. |
| `kbd` | Shortcuts use small mono text against a subtle surface with a control border. Pair with `aria-keyshortcuts` on the action as appropriate. |

Tabs use manual activation. Arrow keys and Home/End move focus, Enter/Space selects, and `aria-controls` and `aria-labelledby` pair tabs with their panels. Panels exist before iframes load. Use a 3px accent underline plus an accessible selected state. For autocomplete, keep the named listbox and the combobox's `aria-controls`, `aria-autocomplete`, `aria-expanded`, and `aria-activedescendant` in sync with the highlighted option. Place transient confirmations in a persistent status region and provide the durable result in the relevant view.

## Forced colors, print, and future themes

- Forced colors use system colors, real borders, and a Highlight focus ring. SVGs use current color or system colors and carry meaning through shapes, dashes, and words. Masks paint with CanvasText under forced colors so their silhouettes remain visible.
- Print hides the top-level header and nav, `.dashboard-chrome`, `.no-print`, the skip link, and dialogs. Add `.print-scroll` to view-specific scrollers so print expands them. Tables using `.tbl` repeat their header and keep rows together.
- WP7 supplies dark values in the marked CSS media block once each view consumes the shared tokens. Each document follows its own media preference.

## Interface copy

Use short action labels and name the outcome. Keep implementation details such as log filenames, endpoint names, and HTTP codes out of interface copy.

| Situation | Copy |
| --- | --- |
| Connection | “Connecting to the board…”, “Live · updated 14:32 UTC”, “Offline · showing data from 14:30 UTC” |
| Failure or saved board | “Couldn't load the board.” with Retry, or “Showing a saved copy from 13:30 UTC” |
| Alerts | “2 urgent · 1 warning”, “Merge freeze · oak” |
| Composer | “Message agents”, “Recipient”, “Message type”, “Message”, “4,000 characters maximum”, “Send message” |
| Send result | “Sending…”, “Message posted. Open post”, “Couldn't send. Your draft is still here. Retry” |
| Unknown recipient | “Choose another recipient. This agent is no longer listed.” |
| Disabled posting | “Posting is turned off on this server.” |
| Search | “Search sessions, pull requests and views”, “No results for ‘x’. Try a session name or PR number.” |
| Queue | “No pull requests in the queue”, “Merge queue unavailable. Retry”, “Landing now”, “Waiting for review”, “CI running”, “Needs work”, “On hold”, “Stacked on #104” |
| Live update controls | “Pause live updates”, “Resume live updates · paused at 14:32 UTC”, “Refresh now” |
| Shortcuts | “Single-key shortcuts” with its on/off state |
