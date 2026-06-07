import { Router } from 'express';
import { ChatManager, ChatMessage } from '../services/chat-manager';
import { TimestampFormatter } from '../timestamp-formatter';

export function createChatRouter(chatManager: ChatManager) {
  const router = Router();

  // POST /chat/ask — accept JSON body with signalVideoId + question, stream LLM tokens back
  router.post('/chat/ask', async (req, res) => {
    const { signalVideoId, question } = req.body as { signalVideoId?: string; question?: string };

    if (!signalVideoId || !question) {
      res.status(400).json({ error: 'signalVideoId and question are required' });
      return;
    }

    // The ask() method throws "Signal X not found" on first .next() call —
    // consume first token to surface errors before flushing headers.
    try {
      // Start the async generator and consume first iteration to trigger validation
      const stream = chatManager.ask(signalVideoId, question, (text) => TimestampFormatter.format(text));
      
      // Attempt to get the first token — this is where "not found" errors surface
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

      // First token obtained — now safe to flush headers and stream
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

  // GET /chat/history?signalVideoId=X — return HTMX fragment of Q&A pairs
  router.get('/chat/history', (req, res) => {
    const signalVideoId = req.query.signalVideoId as string | undefined;

    let messages: ChatMessage[] = [];
    if (signalVideoId) {
      messages = chatManager.getHistory(signalVideoId);
    }

    res.render('_chatHistory', {
      messages,
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