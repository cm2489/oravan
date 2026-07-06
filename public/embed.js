/*!
 * Rostra embed loader (S13). Dependency-free, ~1.5KB, well under the 5KB
 * budget. Usage:
 *
 *   <div id="my-widget"></div>
 *   <script src="https://<rostra-origin>/embed.js"
 *           data-rostra-widget="rep-lookup"
 *           data-target="my-widget"
 *           data-locale="en"></script>
 *
 * `data-target` is optional - if omitted, the iframe is inserted right
 * after this <script> tag. Everything the widget needs (data, chrome,
 * i18n, the EN/ES toggle) lives inside the cross-origin iframe itself:
 * this file only injects it and relays its reported height back. No
 * fetch, no storage, no analytics, nothing read from the host page - the
 * privacy claim ("collects nothing about your visitors") is enforced by
 * the browser's own iframe origin isolation, not by this script being
 * well-behaved (docs/ideation/2026-07-02-embeds-spec.md §2.1, §2.3).
 *
 * TODO(subdomain): once the embed.<domain> subdomain lands (rename-gated -
 * see lib/site.ts's SITE_ORIGIN), nothing here needs to change: the iframe
 * target is derived from THIS script's own src origin below, never a
 * hardcoded constant, so serving this same file from a new origin is the
 * entire migration.
 */
(function () {
  'use strict';

  var WIDGET_TITLES = {
    'rep-lookup': 'Rostra representative lookup',
  };

  var DEFAULT_HEIGHT = 480;

  function currentScript() {
    if (document.currentScript) return document.currentScript;
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  }

  function init() {
    var script = currentScript();
    if (!script || !script.src) return;

    var origin;
    try {
      origin = new URL(script.src).origin;
    } catch {
      return;
    }

    var widget = script.getAttribute('data-rostra-widget') || 'rep-lookup';
    var locale = script.getAttribute('data-locale') || 'en';
    var targetId = script.getAttribute('data-target');
    var host = targetId ? document.getElementById(targetId) : null;

    var iframe = document.createElement('iframe');
    iframe.src = origin + '/embed/' + widget + '?locale=' + encodeURIComponent(locale);
    iframe.title = WIDGET_TITLES[widget] || 'Rostra widget';
    iframe.style.width = '100%';
    iframe.style.maxWidth = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.height = DEFAULT_HEIGHT + 'px';
    iframe.style.colorScheme = 'light dark';
    iframe.setAttribute('scrolling', 'no');
    // The privacy guarantee here ("the host page can't see inside this
    // iframe") comes from ordinary cross-origin browser isolation - this
    // widget is served from Rostra's own origin, a different origin than
    // whatever page embeds it, so the host's JS is already locked out
    // regardless of sandbox flags. `sandbox` is defense-in-depth against
    // what the WIDGET can do TO the host (no top-level navigation, no
    // plugins), not a restriction on Rostra's own first-party code - so
    // allow-same-origin stays in: this is our own trusted widget, and
    // without it same-origin calls like the ZIP lookup's own fetch() get
    // treated as cross-origin from an opaque origin and fail outright.
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
    );
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('data-rostra-embed', widget);

    if (host) {
      host.appendChild(iframe);
    } else if (script.parentNode) {
      script.parentNode.insertBefore(iframe, script.nextSibling);
    } else {
      return;
    }

    window.addEventListener('message', function (event) {
      if (event.origin !== origin) return;
      if (event.source !== iframe.contentWindow) return;
      var data = event.data;
      if (!data || data.source !== 'rostra-embed' || data.type !== 'resize') return;
      if (data.widget !== widget) return;
      var height = Number(data.height);
      if (height > 0) iframe.style.height = height + 'px';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
