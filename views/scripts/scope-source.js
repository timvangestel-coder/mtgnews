/**
 * ScopeSource — browser-compatible scope utility for chat panel.
 * Pure functions: reads scope from URL, builds request payloads.
 * Loaded before chat-panel.js so window.ScopeSource is available.
 */
(function() {
  window.ScopeSource = {
    /**
     * Read chat scope from the current browser URL.
     * Empty string params normalized to undefined (no filter selected).
     */
    fromCurrentURL: function() {
      var url = new URL(window.location.href);
      var hasTopicKey = url.searchParams.has('topicKey');
      var rawChannelId = url.searchParams.get('channelId');
      var rawIncludeIrrelevant = url.searchParams.get('includeIrrelevant');
      // topicKey: if param is present, return its value (including empty string '' which means "all signals").
      // If param is absent entirely, return undefined (not a list-scope filter).
      // Empty channelId IS normalized to undefined — channelId='' has no semantic meaning.
      return {
        topicKey: hasTopicKey ? url.searchParams.get('topicKey') : undefined,
        channelId: rawChannelId || undefined,
        includeIrrelevant: rawIncludeIrrelevant === 'true'
      };
    },

    /**
     * Build the URL for GET /chat/history with scope params appended.
     */
    buildHistoryURL: function(scope) {
      var parts = [];
      if (scope.signalVideoId) {
        parts.push('signalVideoId=' + encodeURIComponent(scope.signalVideoId));
      } else if (scope.topicKey !== undefined) {
        parts.push('topicKey=' + encodeURIComponent(scope.topicKey));
      }
      if (scope.channelId) {
        parts.push('channelId=' + encodeURIComponent(scope.channelId));
      }
      var query = parts.join('&');
      return '/chat/history' + (query ? '?' + query : '');
    },

    /**
     * Build the POST body for /chat/ask.
     */
    buildAskBody: function(question, scope) {
      var body = { question: question };
      if (scope.signalVideoId) {
        body.signalVideoId = scope.signalVideoId;
      } else {
        // List-scoped — always send topicKey as scope indicator
        body.topicKey = scope.topicKey !== undefined ? scope.topicKey : '';
      }
      if (scope.channelId) body.channelId = scope.channelId;
      if (scope.includeIrrelevant) body.includeIrrelevant = true;
      return body;
    }
  };
})();