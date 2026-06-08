import { Router } from 'express';
import { ChatManager, ChatMessage } from '../services/chat-manager';
import { ChatQueue } from '../chat-queue';
import { TimestampFormatter } from '../timestamp-formatter';

function formatAnswer(answer: string | null | undefined): string {
  if (!answer) return '';
  return TimestampFormatter.format(answer);
}

export function createChatRouter(chatManager: ChatManager, chatQueue?: ChatQueue) {
  const router = Router();

  // POST /chat/ask — accept JSON body with signalVideoId + question
  // If ChatQueue is available, returns immediately with question ID (two-phase async)
  // Otherwise falls back to streaming LLM tokens (legacy behavior)
  router.post('/chat/ask', async (req, res) => {
    const { signalVideoId, question } = req.body as { signalVideoId?: string; question?: string };

    if (!signalVideoId || !question) {
      res.status(400).json({ error: 'signalVideoId and question are required' });
      return;
    }

    // Use ChatQueue for async processing if available (Issue #120)
    if (chatQueue) {
      try {
        const id = chatQueue.enqueue(signalVideoId, question);
        res.json({ id: Number(id), status: 'pending' });
      } catch (error: unknown) {
        const err = error as Error;
        if (err.message?.includes('not found')) {
          res.status(404).json({ error: err.message });
        } else {
          res.status(500).json({ error: 'Failed to enqueue question' });
        }
      }
      return;
    }

    // Legacy streaming behavior when no queue is provided
    try {
      const stream = chatManager.ask(signalVideoId, question, (text) => TimestampFormatter.format(text));

      let firstToken: string | undefined;
      let exhausted = false;

      try {
        const firstResult = await stream.next();
        if (!firstResult.done) {
          firstToken = firstResult.value;
        } else {
          exhausted = true;
        }
      } catch (error: unknown) {
        const err = error as Error;
        if (err.message?.includes('not found')) {
          res.status(404).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: 'Failed to generate response' });
        return;
      }

      res.setHeader('Content-Type', 'text/plain');
      res.flushHeaders();

      if (firstToken !== undefined) {
        res.write(firstToken);
      }

      if (!exhausted) {
        for await (const token of stream) {
          res.write(token);
        }
      }

      res.end();
    } catch (error: unknown) {
      const err = error as Error;
      if (!res.headersSent) {
        if (err.message?.includes('not found')) {
          res.status(404).json({ error: err.message });
        } else {
          res.status(500).json({ error: 'Failed to generate response' });
        }
      } else {
        res.end();
      }
    }
  });

  // GET /chat/:id/status — return processing status for HTMX polling (Issue #120)
  // Returns HTML fragment when called via HTMX (for hx-swap), JSON otherwise
  router.get('/chat/:id/status', (_req, res) => {
    const id = parseInt(_req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    if (!chatQueue) {
      res.status(501).json({ error: 'Status endpoint requires ChatQueue' });
      return;
    }

    const info = chatQueue.statusInfo(id);
    if (info === null) {
      res.status(404).json({ error: `Chat question ${id} not found` });
      return;
    }

    // HTMX requests get HTML fragment for hx-swap="outerHTML" + hx-select
    if (_req.headers['hx-request']) {
      res.render('_chatAnswerStatus', {
        id,
        status: info.status,
        answer: formatAnswer(info.answer),
        layout: false,
      });
    } else {
      // Non-HTMX requests get JSON (for API consumers / tests)
      res.json({ id, ...info });
    }
  });

  // GET /chat/history?signalVideoId=X — return HTMX fragment of Q&A pairs
  // Includes per-message status from ChatQueue so template can render pending/failed states
  router.get('/chat/history', (req, res) => {
    const signalVideoId = req.query.signalVideoId as string | undefined;

    let messages: ChatMessage[] = [];
    if (signalVideoId) {
      messages = chatManager.getHistory(signalVideoId);
    }

    // Build a status map for each message when queue is available
    const statusMap: Record<number, 'pending' | 'done' | 'failed'> = {};
    if (chatQueue) {
      for (const msg of messages) {
        const s = chatQueue.status(msg.id);
        if (s) statusMap[msg.id] = s;
      }
    }

    // Transform answers: convert Markdown to HTML so views render formatted content
    const messagesWithHtml = messages.map((msg) => ({
      ...msg,
      answerHtml: formatAnswer(msg.answer),
    }));

    res.render('_chatHistory', {
      messages: messagesWithHtml,
      statusMap,
      layout: false,
    });
  });

  // DELETE /chat/:id — remove the chat message, return 204 No Content
  router.delete('/chat/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    chatManager.delete(id);
    res.status(204).end();
  });

  return router;
}