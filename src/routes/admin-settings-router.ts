import { Router } from 'express';
import Database from 'better-sqlite3';
import { setAppSetting, deleteAppSetting } from '../db/app-settings';

export function createAdminSettingsRouter(db: Database.Database) {
  const router = Router();

  // POST /admin/settings/default-prompt — save or clear global default prompt
  router.post('/admin/settings/default-prompt', (req, res) => {
    const prompt = req.body.prompt as string;

    if (prompt === '') {
      deleteAppSetting(db, 'default_summary_prompt');
    } else {
      setAppSetting(db, 'default_summary_prompt', prompt);
    }

    // 303 redirect for HTMX browsers
    res.redirect(303, '/admin?tab=topics');
  });

  return router;
}