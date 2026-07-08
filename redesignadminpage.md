# Admin Page Redesign Issue

## Summary
The Admin Panel is structurally sound, but the implementation is shallow in several places: Admin fragments still leak raw Tailwind colors, the Topics CRUD surface mixes display/edit state and global action adapters, the Channels controls use multiple tiny HTMX forms, and the Data tab is presented as a backend-style table rather than a modern admin panel.

This issue consolidates the redesign into a single vertical slice that modernizes the Admin Panel UI and interaction seams while preserving the existing page layout and behavior.

## What to build
Implement a cohesive Admin Panel modernization that includes:

- Tokenizing remaining Admin fragment colors and dark mode states so server-rendered HTML uses semantic design tokens consistently.
- Flattening the Topics tab into a clearer CRUD module with an explicit edit interface and a deeper action seam instead of `window.__topicSubmit()`.
- Consolidating Channel actions in the Channels tab behind a unified action adapter, removing the current set of separate HTMX forms for toggle and topic update flows.
- Modernizing the Data tab into a summary panel with accessible count chips and grouped restore/purge actions, instead of a plain table report.
- Hardening the Admin tab keyboard navigation so focus state and active state are distinct and tab activation feels reliable.

This should be delivered as one complete Admin Panel improvement, not as separate isolated fixes.

## Acceptance criteria
- [ ] All Admin view fragments use semantic design tokens for color, background, border, and focus states, with matching dark-mode variants.
- [ ] The Topics tab no longer relies on a global `window.__topicSubmit()` adapter and instead exposes a clear, testable topic edit/delete action seam.
- [ ] Channel toggle and topic assignment actions are unified behind a consistent Admin channel action interface rather than multiple tiny HTMX forms.
- [ ] The Data tab renders as a modern summary panel with grouped restore/purge affordances and tokenized styling.
- [ ] Admin tabs support robust keyboard navigation with separate focus and activation behavior, consistent ARIA tab semantics, and no brittle focus/active-state coupling.
- [ ] The redesign is consistent with the project’s existing Group A Admin/Signal design philosophy and dark-mode patterns.

## Blocked by
None — can start immediately.

---

*Note: this issue is written as a single combined Admin Panel redesign item in `redesignadminpage.md`. No GitHub issue was created.*