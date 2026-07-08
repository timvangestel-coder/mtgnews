/**
 * UI State Module
 * ===============
 * Extracted Alpine.js data functions for UI components.
 * Exposed as window.UiState so templates can reference via x-data="UiState.filterBar()".
 */

window.UiState = (() => {
  /**
   * Parse URL search params into a key->string map.
   */
  function _urlParams() {
    var params = new URLSearchParams(window.location.search);
    var map = {};
    for (var pair of params.entries()) {
      map[pair[0]] = pair[1];
    }
    return map;
  }

   /**
    * Filter Bar — segmented control state for signals page.
    * Reads active filters from URL params for visual state only.
    * Filter changes trigger HTMX hx-get requests (server-driven).
    *
    * Accessibility: roving tabindex pattern for filter pill groups.
    * Each group (topic, channel, date) tracks a focusedIndex so ArrowLeft/Right
    * moves focus within the group. The active pill gets tabindex=0, others -1.
    */
   function filterBar(topics, channels) {
     var params = _urlParams();

     return {
       // Data from server
       topics: topics || [],
       channels: channels || [],

       // Active filter state — driven by URL params
       selectedTopic: params.topicKey || '',
       selectedChannel: params.channelId || '',
       showIrrelevant: params.showIrrelevant === 'true',
       showUnreviewed: params.showUnreviewed !== 'false',
       dateFilter: params.dateFilter || '',

       // UI state
       filtersExpanded: false,

       // Roving tabindex focus indices — one per segmented control group
       // Index into the pills array (0 = "All" button, 1+ = data items)
       topicFocusIndex: -1,
       channelFocusIndex: -1,
       dateFocusIndex: -1,

       /** Ordered date filter options for keyboard navigation */
       dateOptions: ['', 'today', 'week', 'month'],

       /**
        * Compute the number of topic pills (All Topics + N topics).
        */
       get _topicCount() { return this.topics.length + 1; },

       /**
        * Compute the number of channel pills (All Channels + filtered channels).
        */
       get _channelCount() { return this.filteredChannels.length + 1; },

       /**
        * Number of date filter pills.
        */
       get _dateCount() { return this.dateOptions.length; },

       /**
        * Move focus within a segmented control group.
        * @param {'topic'|'channel'|'date'} group
        * @param {'left'|'right'} direction
        */
       movePillFocus: function (group, direction) {
         var indexProp = group + 'FocusIndex';
         var countProp = '_' + group + 'Count';
         var count = this[countProp];
         if (count === 0) return;

         // Initialize focus index to the active pill on first arrow-key press
         var currentIndex = this[indexProp];
         if (currentIndex < 0) {
           currentIndex = this._findActivePillIndex(group);
           this[indexProp] = currentIndex;
         }

         var nextIndex;
         if (direction === 'left') {
           nextIndex = currentIndex <= 0 ? count - 1 : currentIndex - 1;
         } else {
           nextIndex = currentIndex >= count - 1 ? 0 : currentIndex + 1;
         }
         this[indexProp] = nextIndex;

         // Move DOM focus to the target pill
         var pillId = group + '-pill-' + nextIndex;
         var pillEl = document.getElementById(pillId);
         if (pillEl) pillEl.focus();
       },

       /**
        * Find the index of the currently active pill in a group.
        */
       _findActivePillIndex: function (group) {
         // Index 0 is always "All" — active when selected value is empty string
         if (group === 'topic') {
           if (!this.selectedTopic) return 0;
           var i = 1;
           for (; i <= this.topics.length; i++) {
             if (this.topics[i - 1].key === this.selectedTopic) return i;
           }
         } else if (group === 'channel') {
           if (!this.selectedChannel) return 0;
           var fc = this.filteredChannels;
           var j = 1;
           for (; j <= fc.length; j++) {
             if (fc[j - 1].channel_id === this.selectedChannel) return j;
           }
         } else if (group === 'date') {
           var activeDate = this.dateFilter || '';
           var di = this.dateOptions.indexOf(activeDate);
           return di >= 0 ? di : 0;
         }
         return 0;
       },

       /**
        * Set focus index when a pill is clicked (keeps roving tabindex in sync).
        */
       setPillFocusIndex: function (group, index) {
         var indexProp = group + 'FocusIndex';
         this[indexProp] = index;
       },

      /**
       * Channels filtered by selected topic.
       */
      get filteredChannels() {
        return this.selectedTopic
          ? this.channels.filter(function (c) { return c.topic_key === this.selectedTopic; }.bind(this))
          : this.channels;
      },

      /**
       * Build URL with current filter params.
       * @param {boolean} forAjax - add htmx param if true
       */
      _buildUrl: function (forAjax) {
        var p = new URLSearchParams();
        if (this.selectedTopic) p.set('topicKey', this.selectedTopic);
        else p.set('topicKey', '');
        if (this.selectedChannel) p.set('channelId', this.selectedChannel);
        else p.set('channelId', '');
        if (this.showIrrelevant) p.set('showIrrelevant', 'true');
        if (!this.showUnreviewed) p.set('showUnreviewed', 'false');
        if (this.dateFilter && this.dateFilter !== '') p.set('dateFilter', this.dateFilter);
        var url = '/signals?' + p.toString();
        window.history.pushState({}, '', url);
        if (forAjax) {
          p.set('htmx', 'true');
          return '/signals?' + p.toString();
        }
        return url;
      },

      /**
       * Trigger HTMX reload of the signals table.
       */
      _apply: function () {
        var self = this;
        this.$nextTick(function () {
          htmx.ajax('GET', self._buildUrl(true), { target: '#signals-table' });
        });
      },

      /**
        * Select a topic (clears channel selection).
        * @param {*} key - topic key
        * @param {number} [pillIndex] - optional pill index for roving tabindex
        */
       selectTopic: function (key, pillIndex) {
         this.selectedTopic = key;
         this.selectedChannel = '';
         if (pillIndex !== undefined) this.topicFocusIndex = pillIndex;
         this._apply();
       },

       /**
        * Select a channel.
        * @param {*} id - channel id
        * @param {number} [pillIndex] - optional pill index for roving tabindex
        */
       selectChannel: function (id, pillIndex) {
         this.selectedChannel = id;
         if (pillIndex !== undefined) this.channelFocusIndex = pillIndex;
         this._apply();
       },

       /**
        * Set date filter preset.
        * @param {*} filter - date filter value
        * @param {number} [pillIndex] - optional pill index for roving tabindex
        */
       setDateFilter: function (filter, pillIndex) {
         this.dateFilter = filter;
         if (pillIndex !== undefined) this.dateFocusIndex = pillIndex;
         this._apply();
       },

      /**
       * Toggle showIrrelevant flag.
       */
      toggleIrrelevant: function () {
        this.showIrrelevant = !this.showIrrelevant;
        this._apply();
      },

      /**
       * Toggle showUnreviewed flag.
       */
      toggleUnreviewed: function () {
        this.showUnreviewed = !this.showUnreviewed;
        this._apply();
      },

      /**
       * Expand/collapse filter icon panel.
       */
      toggleFilters: function () {
        this.filtersExpanded = !this.filtersExpanded;
      }
    };
  }

  /**
   * Signal List View — card list interaction state.
   * Placeholder for future client-side enhancements (selection, bulk actions).
   */
  function signalListView() {
    return {
      /* Reserved for future: selectedIds, selectionMode, etc. */
    };
  }

  /**
   * Signal Detail Tabs — three-state view toggle with keyboard navigation.
   * Manages viewState: 'summary' | 'transcript' | 'split'
   * Provides ArrowLeft/ArrowRight tab navigation with full ARIA support.
   */
  function detailTabs(initialViewState) {
    return {
      viewState: initialViewState || 'summary',
      highlighted: null,

      /** Ordered list of tab identifiers for keyboard navigation */
      tabOrder: ['summary', 'transcript', 'split'],

      /**
       * Select a view state (called from tab clicks).
       */
      setViewState: function (state) {
        this.viewState = state;
      },

      /**
       * Keyboard handler — move focus to previous/next tab.
       * Dispatches custom event so the template can move DOM focus.
       */
      moveTabFocus: function (direction) {
        var currentIndex = this.tabOrder.indexOf(this.viewState);
        var nextIndex;
        if (direction === 'left') {
          nextIndex = currentIndex <= 0 ? this.tabOrder.length - 1 : currentIndex - 1;
        } else {
          nextIndex = currentIndex >= this.tabOrder.length - 1 ? 0 : currentIndex + 1;
        }
        var nextTabId = 'tab-' + this.tabOrder[nextIndex];
        var tabEl = document.getElementById(nextTabId);
        if (tabEl) tabEl.focus();
      },

      /**
       * Handle summary pill click — navigate to split view + scroll transcript.
       */
      handleSummaryPillClick: function (ms) {
        this.viewState = 'split';
        var self = this;
        setTimeout(function () {
          self.scrollToTranscript(ms);
        }, 1050);
      },

      /**
       * Handle transcript pill click — navigate to split view + scroll summary.
       */
      handleTranscriptPillClick: function (ms) {
        if (this.viewState !== 'split') {
          this.viewState = 'split';
          var self = this;
          setTimeout(function () {
            self.scrollToSummary(ms);
          }, 1050);
        } else {
          this.scrollToSummary(ms);
        }
      },

      /**
       * Scroll transcript pane to the segment at the given timestamp.
       */
      scrollToTranscript: function (ms) {
        var target = document.getElementById('t-' + ms);
        if (!target) {
          var segments = document.querySelectorAll('[id]');
          segments = Array.prototype.filter.call(segments, function (s) { return s.id && s.id.indexOf('t-') === 0; });
          var closest = null;
          var closestDiff = Infinity;
          segments.forEach(function (seg) {
            var segMs = parseInt(seg.id.replace('t-', ''), 10);
            var diff = Math.abs(segMs - ms);
            if (diff < closestDiff) {
              closestDiff = diff;
              closest = seg;
            }
          });
          target = closest;
        }
        if (!target) return;
        var container = document.getElementById('transcript-pane');
        if (container) {
          container.scrollTop = target.offsetTop + container.scrollTop - container.offsetTop;
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        this.highlightTarget(target);
      },

      /**
       * Scroll summary pane to the pill at the given timestamp.
       */
      scrollToSummary: function (ms) {
        var pills = document.querySelectorAll('#summary-pane a[data-timestamp]');
        var target = null;
        pills.forEach(function (a) {
          if (parseInt(a.getAttribute('data-timestamp'), 10) === ms) {
            target = a;
          }
        });
        if (!target) {
          var closest = null;
          var closestDiff = Infinity;
          pills.forEach(function (a) {
            var pillMs = parseInt(a.getAttribute('data-timestamp'), 10);
            var diff = Math.abs(pillMs - ms);
            if (diff < closestDiff) {
              closestDiff = diff;
              closest = a;
            }
          });
          target = closest;
        }
        if (!target) return;
        var self = this;
        var transcriptPane = document.getElementById('transcript-pane');
        var savedScrollTop = transcriptPane ? transcriptPane.scrollTop : 0;
        var container = document.getElementById('summary-pane');
        if (container) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (transcriptPane) {
          requestAnimationFrame(function () {
            transcriptPane.scrollTop = savedScrollTop;
          });
        }
        this.highlightTarget(target);
      },

      /**
       * Briefly highlight an element for visual feedback.
       */
      highlightTarget: function (el) {
        var self = this;
        if (this.highlighted && this.highlighted !== el) {
          this.highlighted.classList.remove('bg-yellow-100');
        }
        this.highlighted = el;
        el.classList.add('bg-yellow-100');
        setTimeout(function () {
          if (el) el.classList.remove('bg-yellow-100');
        }, 1500);
      },

      /**
       * Initialize — set up TimestampNav and hash navigation.
       */
      init: function () {
        var self = this;
        window.__alpineReady = true;

        // Use TimestampNav for document-level click delegation
        window.TimestampNav.init({
          samePage: true,
          onSummaryClick: function (ms) { self.handleSummaryPillClick(ms); },
          onTranscriptClick: function (ms) { self.handleTranscriptPillClick(ms); },
          onChatClick: function (ms) {
            self.viewState = 'split';
            setTimeout(function () {
              self.scrollToTranscript(ms);
            }, 1050);
            document.dispatchEvent(new CustomEvent('chat-timestamp-clicked', { detail: { ms: ms } }));
          }
        });

        // Hash fragment navigation
        var hash = window.location.hash;
        if (hash) {
          var match = hash.match(/^#t-(\d+)$/);
          if (match) {
            var ms = parseInt(match[1], 10);
            self.handleSummaryPillClick(ms);
          }
        }
      }
    };
  }

  /**
   * Admin Tabs — tab navigation for the admin panel.
   * Manages activeTab state, keyboard roving focus, and fragment fetching.
   */
  function adminTabs() {
    var TAB_ENDPOINTS = {
      channels: '/admin/channels-fragment',
      topics: '/admin/topics-fragment',
      polling: '/admin/polling-fragment',
      data: '/admin/data-fragment'
    };

    /** Ordered tab IDs for keyboard roving focus */
    var TAB_ORDER = ['channels', 'topics', 'polling', 'data'];

    return {
      activeTab: document.querySelector('[data-admin-default-tab]')
        ? document.querySelector('[data-admin-default-tab]').getAttribute('data-admin-default-tab')
        : 'channels',

      init: function () {
        var self = this;
        ['refreshChannels', 'refreshTopics', 'refreshPolling', 'refreshData'].forEach(function (name) {
          document.body.addEventListener(name, function () {
            var tabKey = name.replace('refresh', '').toLowerCase();
            if (tabKey === self.activeTab) {
              self.fetchTab(tabKey);
            }
          });
        });
      },

      switchTab: function (tabName) {
        if (tabName === this.activeTab) return;
        history.replaceState(null, '', '/admin?tab=' + tabName);
        var self = this;
        this.activeTab = tabName;
        // Use requestAnimationFrame to let Alpine render the new tab div before fetching
        requestAnimationFrame(function () {
          self.fetchTab(tabName);
        });
      },

      /**
       * Keyboard handler — move roving focus to previous/next tab.
       * Matches detailTabs().moveTabFocus() pattern.
       */
      moveTabFocus: function (direction) {
        var currentIndex = TAB_ORDER.indexOf(this.activeTab);
        var nextIndex;
        if (direction === 'left') {
          nextIndex = currentIndex <= 0 ? TAB_ORDER.length - 1 : currentIndex - 1;
        } else {
          nextIndex = currentIndex >= TAB_ORDER.length - 1 ? 0 : currentIndex + 1;
        }
        var nextTabId = 'admin-tab-' + TAB_ORDER[nextIndex];
        var tabEl = document.getElementById(nextTabId);
        if (tabEl) {
          tabEl.focus();
          // Activate the tab on focus (roving tabindex pattern)
          this.switchTab(TAB_ORDER[nextIndex]);
        }
      },

      fetchTab: function (tabKey) {
        var el = document.getElementById(tabKey + '-tab-content');
        if (!el) return;
        var url = TAB_ENDPOINTS[tabKey];
        if (!url) return;

        fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
          .then(function (res) { return res.text(); })
          .then(function (html) {
            el.innerHTML = html;
            if (typeof htmx !== 'undefined') {
              htmx.process(el);
            }
          });
      }
    };
  }

  /**
   * DeleteModal — reusable confirmation modal with entity counts.
   *
   * Dual-mode payload for `open-delete-modal.window` event:
   *   { title, message, actionUrl, actionPayload?, countsUrl?, counts? }
   *
   * - If `counts` provided: use directly, no fetch (undo/purge mode)
   * - If `countsUrl` provided (no `counts`): fetch from URL before showing (channel delete mode)
   */
  function deleteModal() {
    return {
      open: false,
      busy: false,
      error: null,

      // Payload fields
      title: '',
      message: '',
      actionUrl: '',
      actionPayload: null,
      countsUrl: null,
      counts: null,

      init: function () {
        var self = this;
        window.addEventListener('open-delete-modal', function (evt) {
          self.open = true;
          self.busy = false;
          self.error = null;
          self.title = evt.detail.title || 'Confirm';
          self.message = evt.detail.message || '';
          self.actionUrl = evt.detail.actionUrl || '';
          self.actionPayload = evt.detail.actionPayload || null;
          self.countsUrl = evt.detail.countsUrl || null;
          self.counts = evt.detail.counts || null;

          // If countsUrl provided but no inline counts, fetch first
          if (self.countsUrl && !self.counts) {
            self.fetchCounts();
          }
        });
      },

      fetchCounts: function () {
        var self = this;
        self.busy = true;
        fetch(self.countsUrl)
          .then(function (res) { return res.json(); })
          .then(function (data) {
            self.counts = data;
            self.busy = false;
          })
          .catch(function (err) {
            self.error = 'Failed to load counts. Please try again.';
            self.busy = false;
            console.error('DeleteModal counts fetch failed:', err);
          });
      },

      cancel: function () {
        this.open = false;
      },

      close: function () {
        this.open = false;
      },

      confirm: function () {
        var self = this;
        if (this.busy) return;
        this.busy = true;
        this.error = null;

        var body = new URLSearchParams();
        if (this.actionPayload) {
          Object.keys(this.actionPayload).forEach(function (key) {
            body.append(key, self.actionPayload[key]);
          });
        }

        fetch(this.actionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'HX-Request': 'true',
          },
          body: body.toString(),
        })
          .then(function (response) {
            if (response.ok) {
              // Consume the fragment response body
              return response.text().then(function () {
                // Read HX-Trigger header and dispatch events on document.body
                var triggerHeader = response.headers.get('HX-Trigger');
                if (triggerHeader) {
                  try {
                    var triggers = JSON.parse(triggerHeader);
                    Object.keys(triggers).forEach(function (eventName) {
                      document.body.dispatchEvent(
                        new CustomEvent(eventName, { detail: triggers[eventName] })
                      );
                    });
                    // Events dispatched — tab wrappers handle their own refresh via HTMX
                    self.open = false;
                    self.busy = false;
                    return;
                  } catch (e) {
                    // If HX-Trigger is not valid JSON, fall through to reload
                  }
                }

                // Fallback: full page reload for non-fragment actions
                location.reload();
              });
            } else {
              self.error = 'Action failed. Please try again.';
              self.busy = false;
            }
          })
          .catch(function (err) {
            self.error = 'Network error. Please try again.';
            self.busy = false;
            console.error('DeleteModal confirm failed:', err);
          });
      },

      /** Build display lines from counts object */
      get countLines() {
        if (!this.counts) return [];
        // Support both formats:
        // - Channel delete mode: signalsDeleted, mentionsDeleted, chatsDeleted, progressDeleted
        // - Undo/Purge mode: channels, signals, mentions, chats, progress
        var labels = {
          channels: 'Channels',
          signalsDeleted: 'Signals affected',
          signals: 'Signals',
          mentionsDeleted: 'Entity mentions',
          mentions: 'Entity mentions',
          chatsDeleted: 'Chat conversations',
          chats: 'Chat rows',
          progressDeleted: 'Poll progress rows',
          progress: 'Poll run progress',
        };
        var self = this;
        return Object.entries(labels)
          .filter(function (entry) { return self.counts[entry[0]] != null; })
          .map(function (entry) {
            return {
              key: entry[0],
              label: entry[1],
              value: self.counts[entry[0]],
            };
          });
      },
    };
  }

  return { filterBar, signalListView, detailTabs, adminTabs, deleteModal };
})();
