# Attempt 1: Fix Signal Detail Chat Button

## Problem
Opening the signal detail page resulted in a non-functional chat button and multiple Alpine.js errors in the browser console:
- `__signalDetail is not defined`
- `viewState is not defined`
- `chatOpen is not defined`
- `chatInput is not defined`

## Root Cause
The `express-ejs-layouts` middleware has `layout extractScripts: true` configured in `server.ts`. This setting extracts `<script>` tags from page views into a `scripts` variable for the layout to render. However, `views/layout.ejs` never rendered this `scripts` variable.

The `signal-detail.ejs` view defines `window.__signalDetail()` in a `<script>` tag at the top of the file. When the page rendered, this script was extracted and stored in the `scripts` variable, but since the layout never output it, the function was **never defined** on the window. Alpine.js then failed because all its `x-data="__signalDetail(...)"` bindings referenced a non-existent function.

Other pages like `signals.ejs` worked fine because they use inline `x-data="{...}"` objects instead of calling global functions.

## Fix
Added script rendering to `views/layout.ejs` just before the Alpine.js `<script defer>` tag:

```ejs
<!-- Extracted page scripts — must load before Alpine so global functions are available -->
<% if (typeof scripts !== 'undefined') { %><%- scripts %><% } %>
```

**Why `typeof` check instead of `scripts || ''`:** In EJS, accessing an undefined variable throws a `ReferenceError`. The expression `scripts || ''` first evaluates `scripts`, which fails when the variable isn't in scope. Using `typeof scripts !== 'undefined'` safely checks without throwing.

## Verification
All 471 tests pass across 40 test files (`npx vitest run`).

## Files Changed
- `views/layout.ejs` — added extracted scripts rendering block before Alpine.js load