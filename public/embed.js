/*!
 * Oravan embed loader (S13, +bill-card S14, +action-panel S19).
 * Dependency-free, under 5KB.
 *
 *   <div id="my-widget"></div>
 *   <script src="https://<oravan-origin>/embed.js"
 *           data-oravan-widget="rep-lookup"
 *           data-target="my-widget"
 *           data-locale="en"></script>
 *
 * Bill-card: data-slug plus optional theme knobs data-accent (hex color),
 * data-radius ("sharp"|"soft"|"round"), data-font ("system"|"serif") -
 * re-validated server-side (lib/embed-theme.ts); this loader just forwards
 * attributes as query params.
 *
 * Action panel (paid tier only): data-slug plus data-token, the 128-bit
 * tenant capability token (embeds spec §3.2) - the one unavoidable place
 * it appears in a URL. Nothing further happens to it here: no logging, no
 * echo, no fetch of its own. The server page is what authorizes.
 *
 * `data-target` is optional - if omitted, the iframe lands right after
 * this <script> tag. Everything the widget needs lives inside the
 * cross-origin iframe itself: this file only injects it and relays its
 * height back. No fetch, no storage, no analytics, nothing read from the
 * host page - "collects nothing about your visitors" is ordinary
 * cross-origin isolation, not this script being well-behaved
 * (docs/ideation/2026-07-02-embeds-spec.md §2). The iframe target is
 * derived from this script's own src origin, never a hardcoded constant.
 */
(function () {
  'use strict';

  var WIDGET_TITLES = {
    'rep-lookup': 'Oravan representative lookup',
    'bill-card': 'Oravan bill decoder',
    'action-panel': 'Oravan action panel',
  };

  // Per-widget query params - data-driven so a future widget just adds a row.
  var WIDGET_PARAM_ATTRS = {
    'rep-lookup': ['accent', 'radius', 'font'],
    'bill-card': ['slug', 'accent', 'radius', 'font'],
    'action-panel': ['slug', 'token', 'accent', 'radius', 'font'],
  };

  // White-label knobs, every widget; validated server-side (embed-theme).
  var UNIVERSAL_ATTRS = ['brandless', 'attribution'];

  // Taller pre-resize placeholder for the extra ZIP step; cosmetic only.
  var WIDGET_DEFAULT_HEIGHT = { 'action-panel': 620 };
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
    var paramAttrs = (WIDGET_PARAM_ATTRS[widget] || []).concat(UNIVERSAL_ATTRS);
    for (var i = 0; i < paramAttrs.length; i++) {
      var value = script.getAttribute('data-' + paramAttrs[i]);
      if (value) query += '&' + paramAttrs[i] + '=' + encodeURIComponent(value);
    }

    var iframe = document.createElement('iframe');
    iframe.src = origin + '/embed/' + widget + '?' + query;
    var title = WIDGET_TITLES[widget] || 'Oravan widget';
    // Brandless: neutral accessible title.
    if (script.getAttribute('data-brandless')) title = title.replace('Oravan ', '');
    iframe.title = title;
    iframe.style.width = '100%';
    iframe.style.maxWidth = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.height = (WIDGET_DEFAULT_HEIGHT[widget] || DEFAULT_HEIGHT) + 'px';
    iframe.style.colorScheme = 'light dark';
    iframe.setAttribute('scrolling', 'no');
    // sandbox is defense-in-depth against the widget, not the isolation
    // mechanism itself; allow-same-origin stays for our own fetch() calls.
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
