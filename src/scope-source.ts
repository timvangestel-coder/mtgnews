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

/** Date range bounds produced from a preset filter. */
export interface DateRange {
  /** ISO 8601 start date (inclusive). Undefined = no lower bound. */
  from?: string;
  /** ISO 8601 end date (inclusive). Undefined = no upper bound. */
  to?: string;
}

/**
 * Maps a preset date filter to ISO date bounds.
 * - 'all' or undefined → {} (no filtering)
 * - 'today' → { from: start of today }
 * - 'week' → { from: 7 days ago }
 * - 'month' → { from: 30 days ago }
 */
export function computeDateRange(dateFilter?: string): DateRange {
  if (!dateFilter) return {};

  if (dateFilter === 'today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return { from: today.toISOString() };
  }

  const daysAgoMap: Record<string, number> = {
    'week': 7,
    'month': 30,
  };

  const days = daysAgoMap[dateFilter];
  if (days === undefined) return {};

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString() };
}

/** Scope data extracted from URL query params. */
export interface ChatScopeData {
  /** Topic filter key (e.g., 'mtg'). Undefined = no topic filter active. */
  topicKey?: string;
  /** Channel filter ID. Undefined = no channel filter active. */
  channelId?: string;
  /** Include irrelevant signals in scope. */
  includeIrrelevant: boolean;
  /** Date range preset filter. 'all' | 'today' | 'week' | 'month'. */
  dateFilter?: string;
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
  dateFilter?: string;
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

    const rawDateFilter = url.searchParams.get('dateFilter');

    return {
      topicKey: hasTopicKey ? (url.searchParams.get('topicKey') ?? undefined) : undefined,
      channelId: rawChannelId || undefined,
      includeIrrelevant: rawIncludeIrrelevant === 'true',
      dateFilter: rawDateFilter || undefined,
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

    // Include dateFilter unless it is the default "all"
    if (scope.dateFilter && scope.dateFilter !== 'all') {
      params.set('dateFilter', scope.dateFilter);
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

    // Include dateFilter for list-scoped chat unless it is the default "all"
    if (!input.signalVideoId && input.dateFilter && input.dateFilter !== 'all') {
      body.dateFilter = input.dateFilter;
    }

    return body;
  },
};