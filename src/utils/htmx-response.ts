import { Request, Response } from 'express';

/**
 * Respond to HTMX requests with a 200 + HX-Redirect header, or fallback redirect for non-HTMX.
 * The HX-Redirect header causes HTMX to perform a full page navigation to the target URL,
 * which refreshes the UI so newly created/updated data becomes visible while preserving tab state.
 * Used across all admin route modules after mutating operations (add, remove, toggle, update).
 */
export function htmxNoContent(req: Request, res: Response, fallbackPath: string): void {
  if (req.headers['hx-request'] === 'true') {
    res.status(200).set('HX-Redirect', fallbackPath).end();
  } else {
    res.redirect(fallbackPath);
  }
}
