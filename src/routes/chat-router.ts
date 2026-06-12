import { Router } from 'express';
import { ChatManager, ChatMessage } from '../services/chat-manager';
import { ChatQueue } from '../chat-queue';
import { ChatResponseFormatter } from '../chat-response-formatter';
import { ChatScope } from '../signal-chat-scope';

function formatAnswer(answer: string | null | undefined, isFormatted: number = 0): string {
  if (!answer) return '';
  // Skip re-formatting when answer was already formatted during storage (issue #135)
  if (isFormatted) return answer;
  // Use empty signalMap — raw answers without citation context get fragment-only links
  return ChatResponseFormatter.format(answer, {});
}

export function createChatRouter(chatManager: ChatManager, chatQueue?: ChatQueue) {
  const router = Router();

  // POST /chat/ask — accept JSON body with either:
  //   - { signalVideoId, question } — per-signal chat (existing)
  //   - { topicKey?, channelId?, includeIrrelevant?, question } — list-scoped chat (new)
  // If ChatQueue is available, returns immediately with question ID (two-phase async)
  // Otherwise falls back to streaming LLM tokens (legacy behavior)
  router.post('/chat/ask', async (req, res) => {
    const body = req.body as {
      signalVideoId?: string;
      topicKey?: string;
      channelId?: string;
      includeIrrelevant?: boolean;
      question?: string;
    };

    const { question } = body;
    if (!question) {
      res.status(400).json({ error: 'question is required' });
      return;
    }

    // Bug 2 fix (issue #135): reject mixed scope types.
    // An empty string topicKey ('') is a valid list-scope indicator from the
    // signal list page when no topic filter is selected — it means "all signals".
    const hasSignalVideoId = !!body.signalVideoId;
    const hasListScope = body.topicKey !== undefined && body.topicKey !== null || !!body.channelId;
    if (hasSignalVideoId && hasListScope) {
      res.status(400).json({ error: 'Cannot mix signalVideoId with list-scoped params (topicKey/channelId)' });
      return;
    }

    // Determine if this is list-scoped or per-signal
    const isListScoped = hasListScope;

    if (isListScoped) {
      // List-scoped chat — empty string topicKey means "all signals" (no filter).
      // Preserve empty string '' so DB persists it — process() uses this to
      // distinguish list-scoped (topic_key='') from per-signal (signal_video_id set).
      const scope: ChatScope = {
        topicKey: body.topicKey !== '' ? body.topicKey : '',  // keep '' as-is for DB persistence
        channelId: body.channelId,
        includeIrrelevant: body.includeIrrelevant,
        question,
      };

      if (chatQueue) {
        try {
          const id = chatQueue.enqueueScoped(scope);
          res.json({ id: Number(id), status: 'pending' });
        } catch (error: unknown) {
          res.status(500).json({ error: 'Failed to enqueue question' });
        }
        return;
      }

      // No queue: use submit directly
      try {
        const id = chatManager.submit(scope);
        res.json({ id: Number(id), status: 'pending' });
      } catch (error: unknown) {
        res.status(500).json({ error: 'Failed to create question' });
      }
      return;
    }

    // Per-signal chat (existing behavior)
    const signalVideoId = body.signalVideoId;
    if (!signalVideoId) {
      res.status(400).json({ error: 'signalVideoId is required for per-signal chat' });
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
      const stream = chatManager.ask(signalVideoId, question, (text) => ChatResponseFormatter.format(text, {}));

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
        answer: formatAnswer(info.answer, info.isFormatted),
        layout: false,
      });
    } else {
      // Non-HTMX requests get JSON (for API consumers / tests)
      res.json({ id, ...info });
    }
  });

  // GET /chat/history — return HTMX fragment of Q&A pairs
  // Per-signal: ?signalVideoId=X
  // List-scoped: ?topicKey=mtg&channelId=UC... or ?topicKey= (empty) for all signals
  // Includes per-message status from ChatQueue so template can render pending/failed states
  router.get('/chat/history', (req, res) => {
    const signalVideoId = req.query.signalVideoId as string | undefined;
    const topicKey = req.query.topicKey as string | undefined;
    const channelId = req.query.channelId as string | undefined;

    let messages: ChatMessage[] = [];

    if (signalVideoId) {
      // Per-signal history (existing)
      messages = chatManager.getHistory(signalVideoId);
    } else if (topicKey !== undefined || channelId !== undefined) {
      // List-scoped history — empty string topicKey means "all signals" scope.
      // Use '' instead of undefined so process/getHistory can distinguish from per-signal.
      const scope: ChatScope = {
        topicKey: topicKey ?? '',  // '' for both missing and empty → list-scoped all signals
        channelId: channelId,
      };
      messages = chatManager.getHistory(scope);
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
      answerHtml: formatAnswer(msg.answer, msg.is_formatted),
    }));

    res.render('_chatHistory', {
      messages: messagesWithHtml,
      statusMap,
      layout: false,
    });
  });

  // DELETE /chat/:id — cancel in-flight processing and remove the chat message, return 204 No Content
  router.delete('/chat/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    if (chatQueue) {
      chatQueue.cancel(id);
    } else {
      chatManager.delete(id);
    }
    res.status(204).end();
  });

  return router;
}