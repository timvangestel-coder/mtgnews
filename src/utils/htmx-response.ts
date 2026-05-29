import { Request, Response } from 'express';

/**
 * Respond to HTMX requests with 204 No Content, or fallback redirect for non-HTMX.
 * Used across all admin route modules to preserve tab state without page reloads.
 */
export function htmxNoContent(req: Request, res: Response, fallbackPath: string): void {
  if (req.headers['hx-request'] === 'true') {
    res.status(204).end();
  } else {
    res.redirect(fallbackPath);
  }
}