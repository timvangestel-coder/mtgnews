/**
 * DeleteModal — reusable Alpine.js confirmation modal with entity counts.
 *
 * Dual-mode payload for `open-delete-modal.window` event:
 *   { title, message, actionUrl, actionPayload?, countsUrl?, counts? }
 *
 * - If `counts` provided: use directly, no fetch (undo/purge mode)
 * - If `countsUrl` provided (no `counts`): fetch from URL before showing (channel delete mode)
 *
 * See ADR-0015 #187.
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

    init() {
      window.addEventListener('open-delete-modal', (evt) => {
        this.open = true;
        this.busy = false;
        this.error = null;
        this.title = evt.detail.title || 'Confirm';
        this.message = evt.detail.message || '';
        this.actionUrl = evt.detail.actionUrl || '';
        this.actionPayload = evt.detail.actionPayload || null;
        this.countsUrl = evt.detail.countsUrl || null;
        this.counts = evt.detail.counts || null;

        // If countsUrl provided but no inline counts, fetch first
        if (this.countsUrl && !this.counts) {
          this.fetchCounts();
        }
      });
    },

    fetchCounts() {
      this.busy = true;
      fetch(this.countsUrl)
        .then((res) => res.json())
        .then((data) => {
          this.counts = data;
          this.busy = false;
        })
        .catch((err) => {
          this.error = 'Failed to load counts. Please try again.';
          this.busy = false;
          console.error('DeleteModal counts fetch failed:', err);
        });
    },

    cancel() {
      this.open = false;
    },

    close() {
      this.open = false;
    },

    async confirm() {
      if (this.busy) return;
      this.busy = true;
      this.error = null;

      try {
        const body = new URLSearchParams();
        if (this.actionPayload) {
          for (const [key, value] of Object.entries(this.actionPayload)) {
            body.append(key, value);
          }
        }

        const response = await fetch(this.actionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'HX-Request': 'true',
          },
          body: body.toString(),
        });

        if (response.ok) {
          // For undo/purge actions, swap the data tab fragment inline and close modal
          if (this.isFragmentAction) {
            const html = await response.text();
            const dataTabEl = document.getElementById('data-tab-content');
            if (dataTabEl) {
              // Use innerHTML to keep #data-tab-content inside Alpine's <template x-if> scoping.
              // outerHTML breaks out of the template, causing content to leak onto all tabs.
              dataTabEl.innerHTML = html;
              this.open = false;
              this.busy = false;
            } else {
              location.reload();
            }
          } else {
            location.reload();
          }
        } else {
          this.error = 'Action failed. Please try again.';
          this.busy = false;
        }
      } catch (err) {
        this.error = 'Network error. Please try again.';
        this.busy = false;
        console.error('DeleteModal confirm failed:', err);
      }
    },

    /** Build display lines from counts object */
    get countLines() {
      if (!this.counts) return [];
      // Support both formats:
      // - Channel delete mode: signalsDeleted, mentionsDeleted, chatsDeleted, progressDeleted
      // - Undo/Purge mode: channels, signals, mentions, chats, progress
      const labels = {
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
      return Object.entries(labels)
        .filter(([key]) => this.counts[key] != null)
        .map(([key, label]) => ({
          key,
          label,
          value: this.counts[key],
        }));
    },

    /** Check if this is an HTMX fragment action (undo/purge) */
    get isFragmentAction() {
      return this.actionUrl && (this.actionUrl.includes('/undo-all') || this.actionUrl.includes('/purge-all'));
    },
  };
}

// Register globally so Alpine can pick it up
window.deleteModal = deleteModal;