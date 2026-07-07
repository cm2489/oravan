/*!
 * Oravan embed loader (S13, +bill-card S14). Dependency-free, under 5KB.
 *
 *   <div id="my-widget"></div>
 *   <script src="https://<oravan-origin>/embed.js"
 *           data-oravan-widget="rep-lookup"
 *           data-target="my-widget"
 *           data-locale="en"></script>
 *
 * Bill-card: data-slug (required, e.g. "hr-1787-119") plus optional theme
 * knobs data-accent (hex color), data-radius ("sharp"|"soft"|"round"),
 * data-font ("system"|"serif") - re-validated server-side
 * (lib/embed-theme.ts) before any becomes a style; this loader just
 * forwards whatever attribute is present as a query param.
 *
 * `data-target` is optional - if omitted, the iframe lands right after
 * this <script> tag. Everything the widget needs (data, chrome, i18n, the
 * EN/ES toggle) lives inside the cross-origin iframe itself: this file
 * only injects it and relays its reported height back. No fetch, no
 * storage, no analytics, nothing read from the host page - the privacy
 * claim ("collects nothing about your visitors") is enforced by ordinary
 * cross-origin iframe isolation, not by this script being well-behaved
 * (docs/ideation/2026-07-02-embeds-spec.md §2.1, §2.3).
 *
 * TODO(subdomain): the iframe target is derived from this script's own src
 * origin below, never a hardcoded constant - moving to embed.<domain>
 * (rename-gated, see lib/site.ts) needs no change here.
 */
(function () {
  'use strict';

  var WIDGET_TITLES = {
    'rep-lookup': 'Oravan representative lookup',
    'bill-card': 'Oravan bill decoder',
  };

  // Attributes forwarded as iframe query params only for the widgets that
  // read them - kept data-driven so a future widget's own params slot in
  // here without another branch in init() below.
  var WIDGET_PARAM_ATTRS = {
    'bill-card': ['slug', 'accent', 'radius', 'font'],
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

    var widget = script.getAttribute('data-oravan-widget') || 'rep-lookup';
    var locale = script.getAttribute('data-locale') || 'en';
    var targetId = script.getAttribute('data-target');
    var host = targetId ? document.getElementById(targetId) : null;

    var query = 'locale=' + encodeURIComponent(locale);
    var paramAttrs = WIDGET_PARAM_ATTRS[widget] || [];
    for (var i = 0; i < paramAttrs.length; i++) {
      var value = script.getAttribute('data-' + paramAttrs[i]);
      if (value) query += '&' + paramAttrs[i] + '=' + encodeURIComponent(value);
    }

    var iframe = document.createElement('iframe');
    iframe.src = origin + '/embed/' + widget + '?' + query;
    iframe.title = WIDGET_TITLES[widget] || 'Oravan widget';
    iframe.style.width = '100%';
    iframe.style.maxWidth = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.height = DEFAULT_HEIGHT + 'px';
    iframe.style.colorScheme = 'light dark';
    iframe.setAttribute('scrolling', 'no');
    // Privacy comes from ordinary cross-origin isolation, not sandbox flags
    // - the host's JS is already locked out of this different-origin frame
    // regardless. `sandbox` is defense-in-depth against what the WIDGET can
    // do TO the host; allow-same-origin stays in since this is Oravan's own
    // trusted code, needed so its own same-origin fetch() calls still work.
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
    );
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('data-oravan-embed', widget);

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
      if (!data || data.source !== 'oravan-embed' || data.type !== 'resize') return;
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
