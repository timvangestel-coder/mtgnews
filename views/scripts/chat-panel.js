/**
 * Chat Panel Alpine component.
 * This script MUST load before Alpine.js so the function is available
 * when Alpine evaluates x-data="chatPanel({...})".
 *
 * Architecture: uses ScopeSource (scope-source.js) as single source of truth
 * for chat scope data. All scope reads happen at point-of-use via
 * ScopeSource.fromCurrentURL(), eliminating Alpine state drift.
 */
(function() {
  function chatPanelFn(scope) {
    // Explicit hasVideoId flag: false means list-scoped (signal list page),
    // true means per-signal (signal detail page). When undefined, infer from
    // presence of topicKey/channelId — preserves backward compatibility.
    var isMulti;
    if (scope.hasVideoId !== undefined) {
      isMulti = !scope.hasVideoId;
    } else {
      isMulti = !!scope.topicKey || !!scope.channelId;
    }
    return {
      chatOpen: false, chatInput: '', historyLoaded: false,
      showIrrelevant: scope.showIrrelevant || false,
      signalCount: scope.signalCount || 0,
      channelsMap: scope.channelsMap || {}, videoId: scope.videoId || '',
      toastVisible: false, toastMessage: '',
      _isMulti: isMulti,
      /** Scope used for last history load — compared on re-open to detect filter changes. */
      _lastHistoryScope: null,
      /** Timer ID for manual status polling (replaces HTMX hx-trigger). */
      _statusPollTimer: null,

      /**
       * Read current scope from URL via ScopeSource (single source of truth).
       * Also refresh signalCount from DOM element if available.
       */
      _readScope: function() {
        var s = window.ScopeSource.fromCurrentURL();
        // Refresh signal count from the data-signal-count DOM element
        var countEl = document.querySelector('[data-signal-count]');
        if (countEl) this.signalCount = parseInt(countEl.textContent, 10) || 0;
        return s;
      },

      /** Dynamic scope label built from current URL scope + signal count. */
      get scopeLabel() {
        var parts = [];
        parts.push(this.signalCount + ' signal' + (this.signalCount !== 1 ? 's' : ''));
        // Read topicKey/channelId from URL at display time — no stale state
        var s = window.ScopeSource.fromCurrentURL();
        if (s.topicKey) parts.push('\u00b7 ' + s.topicKey);
        if (s.channelId) {
          var displayName = this.channelsMap && this.channelsMap[s.channelId] ? this.channelsMap[s.channelId] : s.channelId;
          parts.push('\u00b7 ' + displayName);
        }
        return 'Chat \u00b7 ' + parts.join(' ');
      },

       init() {
         var self = this;
         if (!this._isMulti) return;
         document.addEventListener('htmx:afterRequest', function(evt) {
           // Programmatic htmx.ajax() calls set evt.target to document.body.
           // Check the HTMX internal info to see if #signals-table was the swap target.
           var target = evt.detail && evt.detail.elt ? evt.detail.elt : null;
           if (!target) {
             // Fallback: also check evt.target.closest for hx-get attribute requests
             target = evt.target && evt.target.closest ? evt.target.closest('#signals-table') : null;
           }
           if (!target || (target.id !== 'signals-table' && !target.closest('#signals-table'))) return;
           // Refresh signal count from DOM on every filter change (always, not just when open)
           var countEl = document.querySelector('[data-signal-count]');
           if (countEl) self.signalCount = parseInt(countEl.textContent, 10) || 0;
           // Only show toast and reload history when chat is actually open
           if (self.chatOpen && self.historyLoaded) {
             self.toastMessage = 'Scope updated: ' + self.signalCount + ' signals';
             self.toastVisible = true;
             setTimeout(function() { self.toastVisible = false; }, 3000);
             self.loadHistory();
           }
         });
       },

        toggleChat() {
          if (!this.chatOpen) {
            // Always refresh signal count from DOM when opening chat — ensures fresh count after filter changes.
            var countEl = document.querySelector('[data-signal-count]');
            if (countEl) this.signalCount = parseInt(countEl.textContent, 10) || 0;

            this.chatOpen = true;
            if (!this.historyLoaded) {
              this.loadHistory();
            } else {
              // Reload history if scope changed since last load (user closed chat, changed pills, re-opened).
              var currentScope = window.ScopeSource.fromCurrentURL();
              if (!this._scopeEqual(currentScope, this._lastHistoryScope)) {
                this.loadHistory();
              }
            }
          } else {
           // Stop status polling when closing chat to prevent background timers.
           this._stopStatusPolling();
           this.chatOpen = false;
         }
       },

       /** Start manual JS-based polling for pending questions (replaces HTMX hx-trigger). */
       _startStatusPolling: function() {
         var self = this;
         // Clear any existing timer first to prevent duplicates.
         if (this._statusPollTimer) clearInterval(this._statusPollTimer);

         // Poll every 3 seconds for pending questions.
         this._statusPollTimer = setInterval(function() {
           var pendingEls = document.querySelectorAll('[data-chat-status="pending"]');
           if (!pendingEls || pendingEls.length === 0) {
             clearInterval(self._statusPollTimer);
             self._statusPollTimer = null;
             return;
           }
           for (var i = 0; i < pendingEls.length; i++) {
             var el = pendingEls[i];
             var chatId = el.getAttribute('data-chat-id');
             if (!chatId) continue;
             fetch('/chat/' + chatId + '/status')
               .then(function(r) { return r.json(); })
               .then(function(data) {
                 if (data.status === 'done' || data.status === 'failed') {
                   // Update this specific answer div.
                   var statusDiv = el;
                   if (data.status === 'failed') {
                     statusDiv.innerHTML = '<strong>A:</strong> <span class="font-medium">failed</span>';
                     statusDiv.setAttribute('data-chat-status', 'failed');
                   } else {
                     // For done, we need the answer text — re-fetch history for this entry.
                     // Simplest: replace with a loading indicator and reload full history.
                     self.loadHistory();
                     clearInterval(self._statusPollTimer);
                     self._statusPollTimer = null;
                   }
                 }
               })
               .catch(function() { /* ignore */ });
           }
         }, 3000);
       },

       /** Stop manual status polling. */
       _stopStatusPolling: function() {
         if (this._statusPollTimer) {
           clearInterval(this._statusPollTimer);
           this._statusPollTimer = null;
         }
       },

       /** Check if two scope objects are equal (used to detect filter changes). */
       _scopeEqual: function(a, b) {
         if (!a || !b) return a === b;
         return a.topicKey === b.topicKey && a.channelId === b.channelId;
       },

       async loadHistory() {
         try {
           var containerId = this._isMulti ? 'signals-chat-history-content' : 'chat-history-content';
           var container = document.getElementById(containerId);

           // Read scope from URL at point-of-use — no stale Alpine state
           var s = window.ScopeSource.fromCurrentURL();
           var url;
           if (this._isMulti) {
             url = window.ScopeSource.buildHistoryURL({
               topicKey: s.topicKey !== undefined ? s.topicKey : '',
               channelId: s.channelId
             });
           } else {
            url = window.ScopeSource.buildHistoryURL({
              signalVideoId: this.videoId
            });
          }
          var response = await fetch(url); if (!response.ok) return;
          var html = await response.text();

           // Clear ALL content first to kill any active HTMX poller timers.
           // HTMX 2.x keeps internal interval timers alive even after elements are removed from DOM.
           // If we set innerHTML without clearing first, old hx-trigger timers keep firing while
           // htmx.process() creates NEW timers for the fresh content — resulting in rapid-fire duplicate polls.
           if (container) {
             container.innerHTML = '';  // kill all existing elements (and their HTMX timers stop with them)
             container.innerHTML = html;  // then load fresh content
             if (window.htmx && htmx.process) htmx.process(container);

             // Start manual JS polling for pending questions.
             this._startStatusPolling();
           }

           this.historyLoaded = true;
           // Store current scope so toggleChat can detect filter changes on re-open.
           this._lastHistoryScope = { topicKey: s.topicKey, channelId: s.channelId };
        } catch (e) {}
      },

      async sendQuestion() {
        var self = this; var question = this.chatInput.trim();
        if (!question) return; this.chatInput = '';
        try {
          // Read scope from URL at point-of-use — no stale Alpine state
          var s = window.ScopeSource.fromCurrentURL();
          var body;
          if (this._isMulti) {
            body = window.ScopeSource.buildAskBody(question, {
              topicKey: s.topicKey,
              channelId: s.channelId,
              includeIrrelevant: this.showIrrelevant
            });
          } else {
            body = window.ScopeSource.buildAskBody(question, {
              signalVideoId: this.videoId
            });
          }
          var response = await fetch('/chat/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (!response.ok) { alert('Error: ' + response.status); return; }
          self.loadHistory();
        } catch (err) { alert('Error sending question'); }
      }
    };
  }

  // Register as global for x-data="chatPanel(...)" expressions
  window.chatPanel = chatPanelFn;

  // Also register with Alpine.data() if Alpine is already loaded
  if (window.Alpine && typeof Alpine.data === 'function') {
    Alpine.data('chatPanel', chatPanelFn);
  }
})();