/**
 * TimestampNav — framework-agnostic timestamp click interception module.
 *
 * Provides document-level click delegation for timestamp pill links across all pages.
 * Replaces inline click handlers hardcoded in signal-detail.ejs's Alpine init().
 *
 * Follows the ScopeSource pattern: pure JS loaded before Alpine, registered as
 * `window.TimestampNav`, consumed by EJS templates.
 *
 * Interface:
 *   TimestampNav.init({
 *     samePage: true | false,
 *     onSummaryClick?: function(ms),
 *     onTranscriptClick?: function(ms),
 *     onChatClick?: function(ms)
 *   });
 *
 * - samePage=true: clicks are intercepted (preventDefault), appropriate callback fires with {ms}
 * - samePage=false: clicks pass through to browser navigation (href follows, no interception)
 */
(function() {
  window.TimestampNav = {
    /**
     * Initialize timestamp click delegation.
     * @param {Object} options
     * @param {boolean} options.samePage - true=intercept clicks, false=pass through to navigation
     * @param {Function} [options.onSummaryClick] - called with ms when summary pane link clicked
     * @param {Function} [options.onTranscriptClick] - called with ms when transcript pane link clicked
     * @param {Function} [options.onChatClick] - called with ms when chat panel link clicked
     */
    init: function(options) {
      var samePage = options.samePage === true;
      var onSummaryClick = options.onSummaryClick;
      var onTranscriptClick = options.onTranscriptClick;
      var onChatClick = options.onChatClick;

      // Remove any previous handler to avoid duplicates on re-init
      if (this._handler) {
        document.removeEventListener('click', this._handler);
      }

      var self = this;
      this._handler = function(e) {
        // Find closest timestamp link via event bubbling
        var target = e.target;
        if (!target || !target.closest) return;
        var link = target.closest('a[data-timestamp]');
        if (!link) return;

        // Must be inside one of the known containers
        var summaryPane = link.closest('#summary-pane');
        var transcriptPane = link.closest('#transcript-pane');
        var chatPanel = link.closest('[data-chat-panel]') || link.closest('.chat-history');

        if (!summaryPane && !transcriptPane && !chatPanel) return;

        // Extract timestamp in milliseconds
        var ms = parseInt(link.getAttribute('data-timestamp'), 10);
        if (isNaN(ms)) return;

        if (samePage) {
          e.preventDefault();
          if (summaryPane && onSummaryClick) onSummaryClick(ms);
          else if (transcriptPane && onTranscriptClick) onTranscriptClick(ms);
          else if (chatPanel && onChatClick) onChatClick(ms);
        }
        // samePage=false: do nothing, let browser follow href
      };

      document.addEventListener('click', this._handler);
    },

    /**
     * Remove the click delegation handler.
     */
    destroy: function() {
      if (this._handler) {
        document.removeEventListener('click', this._handler);
        this._handler = null;
      }
    }
  };
})();