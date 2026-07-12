/**
 * SpeakerButton — Alpine.js data object for TTS audio playback on Signal Detail page.
 *
 * States: idle → loading → playing → idle (on end/stop/error)
 *
 * Exposed as window.SpeakerButton so EJS templates can reference via x-data="SpeakerButton(videoId)".
 */
(function () {
  window.SpeakerButton = function (videoId) {
    return {
      audioState: 'idle', // 'idle' | 'loading' | 'playing'
      audioEl: null,

      get idle() {
        return this.audioState === 'idle';
      },
      get loading() {
        return this.audioState === 'loading';
      },
      get playing() {
        return this.audioState === 'playing';
      },

      /** CSS classes for the speaker icon based on current state */
      get iconClass() {
        if (this.audioState === 'loading') return 'animate-pulse text-brand-600 dark:text-brand-400';
        if (this.audioState === 'playing') return 'text-brand-600 dark:text-brand-400';
        return 'text-muted-400 hover:text-muted-600 dark:text-muted-500 dark:hover:text-muted-300';
      },

      /** Click handler — toggle playback */
      click: function () {
        if (this.audioState === 'playing' || this.audioState === 'loading') {
          this._stop();
        } else {
          this._play();
        }
      },

      /** Start audio playback */
      _play: function () {
        var self = this;
        self.audioState = 'loading';

        var audio = new Audio('/signals/' + videoId + '/audio');
        self.audioEl = audio;

        audio.addEventListener('canplaythrough', function () {
          self.audioState = 'playing';
          audio.play().catch(function () {
            // Autoplay may be blocked — reset to idle
            self._reset();
          });
        });

        audio.addEventListener('ended', function () {
          self._reset();
        });

        audio.addEventListener('error', function () {
          self._reset();
        });

        // Start loading
        audio.load();
      },

      /** Stop audio playback and reset state */
      _stop: function () {
        if (this.audioEl) {
          this.audioEl.pause();
          this.audioEl.src = '';
          this.audioEl = null;
        }
        this.audioState = 'idle';
      },

      /** Reset to idle state without cleanup (handled by event) */
      _reset: function () {
        this.audioEl = null;
        this.audioState = 'idle';
      },
    };
  };
})();
