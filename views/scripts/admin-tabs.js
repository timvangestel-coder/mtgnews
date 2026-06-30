/**
 * Admin Tabs Alpine component.
 * Registered on window so Alpine's x-data="adminTabs()" can find it.
 * Loaded before Alpine via layout.ejs (like deleteModal).
 */
(function () {
  var TAB_ENDPOINTS = {
    channels: '/admin/channels-fragment',
    topics: '/admin/topics-fragment',
    polling: '/admin/polling-fragment',
    data: '/admin/data-fragment'
  };

  window.adminTabs = function () {
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
  };
})();