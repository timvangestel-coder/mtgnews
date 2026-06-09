/**
 * ScopeSource — single source of truth for chat scope data.
 *
 * Pure functions that read scope from URL query params and construct
 * request payloads. Eliminates Alpine state drift by providing point-of-use
 * scope reading instead of maintaining stale reactive properties.
 *
 * Framework-agnostic: no Alpine, no HTMX dependencies. Works in both
 * browser (chat-panel.js) and test contexts.
 */

/** Scope data extracted from URL query params. */
export interface ChatScopeData {
  /** Topic filter key (e.g., 'mtg'). Undefined = no topic filter active. */
  topicKey?: string;
  /** Channel filter ID. Undefined = no channel filter active. */
  channelId?: string;
  /** Include irrelevant signals in scope. */
  includeIrrelevant: boolean;
}

/** Scope data including optional per-signal video ID. */
export interface ChatScopeDataWithVideo extends ChatScopeData {
  signalVideoId?: string;
}

/** POST body for /chat/ask endpoint. */
export interface AskBody {
  question: string;
  topicKey?: string;
  channelId?: string;
  includeIrrelevant?: boolean;
  signalVideoId?: string;
}

/**
 * ScopeSource provides pure functions for reading and building chat scope data.
 * All methods are static — no instantiation needed.
 */
export const ScopeSource = {
  /**
   * Read chat scope from a URL string.
   * Empty string params are normalized to undefined (no filter selected).
   * HTMX artifacts (htmx=true) are ignored.
   */
  fromURL(urlString: string): ChatScopeData {
    const url = new URL(urlString);
    // topicKey: if param is present, return its value (including empty string '' which means "all signals").
    // If param is absent entirely, return undefined (not a list-scope filter).
    const hasTopicKey = url.searchParams.has('topicKey');
    const rawChannelId = url.searchParams.get('channelId');
    const rawIncludeIrrelevant = url.searchParams.get('includeIrrelevant');

    return {
      topicKey: hasTopicKey ? url.searchParams.get('topicKey') : undefined,
      channelId: rawChannelId || undefined,
      includeIrrelevant: rawIncludeIrrelevant === 'true',
    };
  },

  /**
   * Build the URL for GET /chat/history with scope params appended.
   */
  buildHistoryURL(scope: ChatScopeDataWithVideo): string {
    const params = new URLSearchParams();

    if (scope.signalVideoId) {
      params.set('signalVideoId', scope.signalVideoId);
    } else if (scope.topicKey !== undefined) {
      // Always send topicKey for list-scoped chat — even empty string is valid
      // as "all signals" indicator per issue #130 design.
      params.set('topicKey', scope.topicKey);
    }

    if (scope.channelId) {
      params.set('channelId', scope.channelId);
    }

    const query = params.toString();
    return query ? `/chat/history?${query}` : '/chat/history';
  },

  /**
   * Build the POST body for /chat/ask.
   * For list-scoped chat: sends topicKey (empty string = "all signals").
   * For per-signal chat: sends signalVideoId only.
   */
  buildAskBody(input: { question: string } & ChatScopeDataWithVideo): AskBody {
    const body: AskBody = { question: input.question };

    if (input.signalVideoId) {
      // Per-signal chat
      body.signalVideoId = input.signalVideoId;
    } else {
      // List-scoped chat — always send topicKey as scope indicator
      body.topicKey = input.topicKey !== undefined ? input.topicKey : '';
    }

    if (input.channelId) {
      body.channelId = input.channelId;
    }

    if (input.includeIrrelevant) {
      body.includeIrrelevant = true;
    }

    return body;
  },
};