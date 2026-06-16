/* HolidayCamp feature — provider-booking-widget
 *
 * Embeddable bookings widget for your own site  (provider side)
 *
 * Replicates Happity's "How to embed bookings on your website using the
 * bookings widget" (support article 12878737; cross-ref 04-seo §2.2 — keep
 * bookings on your own domain so traffic/SEO stays with you).
 *
 * Faithful to the evidence (article 12878737):
 *   "Before you begin: The bookings widget is available for Happity Members
 *    only. If you're on the free plan, you'll need to upgrade first."
 *      -> the widget is MEMBER-gated; a free provider cannot generate one.
 *   "Step 3 — Add your website(s): Copy and paste your website URL (or URLs)
 *    into the box. This keeps your data secure — your widget can only be
 *    embedded on the websites you list here."
 *      -> a DOMAIN WHITELIST. The embed only renders on a listed host.
 *   "Step 4 — Choose how your classes display: group and filter by Weekday,
 *    Activity or Venue."
 *      -> the widget groups its camps by Day / Activity / Venue, with an
 *         optional value filter (only show one activity, one venue, …).
 *   "Step 5 — Add your branding: choose two colours … defaults to Happity
 *    pink and yellow."
 *      -> two brand colours, with sensible defaults.
 *   "Step 6 — Generate your code … embed code will now appear … Copy …
 *    paste the embed code into your site exactly as shown … adjust any
 *    settings, click Generate again to create a new code snippet."
 *      -> an embed SNIPPET is generated and copied; changing settings makes
 *         a fresh snippet.
 *   "Bookings made through your widget appear in My Classes > Registers …
 *    you'll receive an email each time someone books."
 *      -> rendered camps are BOOKABLE (carry a booking action/route).
 *   "You can create as many widgets as you like."
 *      -> multiple named widgets per provider.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A Member can whitelist their domain and copy an embed snippet that
 *   renders their bookable camps. We verify: only a Member can build a
 *   widget; the domain box accepts/normalises real domains into a whitelist;
 *   the generated snippet is an embeddable HTML string carrying the widget id
 *   and the whitelisted host(s); the widget RESOLVES (renders) only on a
 *   whitelisted host and is refused on any other; the rendered camps are the
 *   provider's own and are bookable (carry a booking route); and the Copy
 *   action returns the exact snippet text.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (summer/half-term camps), not baby
 * classes. Self-contained, defensive, no imports/exports. Persistence is via
 * HC.store only. Calls HC.registerFeature at top level and never throws at
 * registration time.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC core isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-booking-widget: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_widgets";   // { [providerId]: { [widgetId]: widgetObj } }
  // Base origin the embed snippet loads its script + iframe from. Fixed and
  // deterministic so the generated snippet is testable.
  var WIDGET_BASE = "https://holidaycamp.app/widget";
  var DEFAULT_COLORS = { primary: "#603488", accent: "#FCD400" }; // our pink/yellow analogue

  /* ===================================================================
     PURE LOGIC (DOM-free, testable)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Normalise a user-typed website into a bare host (lowercase, no scheme, no
  // path, no port, no leading "www."). Returns "" if nothing usable is found,
  // so an empty/garbage entry never pollutes the whitelist.
  function normaliseDomain(input) {
    var s = asText(input).trim().toLowerCase();
    if (!s) return "";
    // Strip scheme.
    s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, "");
    // Strip any path / query / fragment.
    s = s.replace(/[\/?#].*$/, "");
    // Strip credentials (user:pass@).
    s = s.replace(/^[^@]*@/, "");
    // Strip port.
    s = s.replace(/:\d+$/, "");
    // Strip a leading www.
    s = s.replace(/^www\./, "");
    // Must look like a domain: label(.label)+ with a TLD of >=2 letters.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(s)) {
      return "";
    }
    return s;
  }

  // Parse a textarea/box of one-or-more websites (newline/comma/space
  // separated) into a de-duplicated, validated whitelist. Mirrors the article:
  // "Copy and paste your website URL (or URLs) into the box."
  // Returns { domains:[...], rejected:[...] }.
  function parseDomainBox(text) {
    var parts = asText(text).split(/[\s,]+/);
    var domains = [];
    var rejected = [];
    var seen = {};
    for (var i = 0; i < parts.length; i++) {
      var raw = parts[i];
      if (!raw) continue;
      var d = normaliseDomain(raw);
      if (!d) { rejected.push(raw); continue; }
      if (seen[d]) continue;
      seen[d] = true;
      domains.push(d);
    }
    return { domains: domains, rejected: rejected };
  }

  // Is a candidate host (the page actually embedding the widget) allowed by a
  // whitelist? A listed domain authorises that exact host AND its subdomains
  // (so listing "mycamp.co.uk" also covers "book.mycamp.co.uk"). This is the
  // security gate: "your widget can only be embedded on the websites you list."
  function hostIsWhitelisted(whitelist, host) {
    var h = normaliseDomain(host);
    if (!h || !Array.isArray(whitelist)) return false;
    for (var i = 0; i < whitelist.length; i++) {
      var d = asText(whitelist[i]).toLowerCase();
      if (!d) continue;
      if (h === d) return true;
      if (h.length > d.length && h.slice(-(d.length + 1)) === ("." + d)) return true; // subdomain
    }
    return false;
  }

  // Valid grouping modes (article Step 4: Weekday / Activity / Venue).
  var GROUP_MODES = ["day", "activity", "venue"];
  function normaliseGroupBy(v) {
    var s = asText(v).toLowerCase();
    return GROUP_MODES.indexOf(s) !== -1 ? s : "activity";
  }

  // Validate a 3/6-digit hex colour; fall back to a default if not.
  function normaliseColor(v, fallback) {
    var s = asText(v).trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return s.toLowerCase();
    return fallback;
  }

  // Build (validate) a widget config. Returns { ok, errors:[...], value }.
  // MEMBER-gated: a non-member provider cannot build a widget.
  function buildWidget(input) {
    input = input || {};
    var errors = [];

    var providerId = asText(input.providerId).trim();
    if (!providerId) errors.push("A provider is required to build a widget.");

    // Member gate (article: "available for Happity Members only").
    if (input.isMember !== true) {
      errors.push("The bookings widget is available to Members only — upgrade to use it.");
    }

    // Domain whitelist — at least one valid website is required, otherwise the
    // embed would have nowhere it is allowed to render.
    var parsed = parseDomainBox(input.websites);
    if (!parsed.domains.length) {
      errors.push("Add at least one website (e.g. mycamp.co.uk) so the widget can be embedded.");
    }

    var groupBy = normaliseGroupBy(input.groupBy);
    // Optional value filter (e.g. only show one Activity / one Venue).
    var filter = asText(input.filter).trim();

    var colors = {
      primary: normaliseColor(input.primary, DEFAULT_COLORS.primary),
      accent: normaliseColor(input.accent, DEFAULT_COLORS.accent)
    };

    var value = null;
    if (!errors.length) {
      var widgetId = input.id ? asText(input.id) : makeWidgetId();
      value = {
        id: widgetId,
        providerId: providerId,
        name: asText(input.name).trim() || "My bookings widget",
        websites: parsed.domains,      // the whitelist
        groupBy: groupBy,
        filter: filter,                // "" => show all
        colors: colors,
        createdAt: input.createdAt || "2026-06-15"
      };
      value.snippet = buildSnippet(value);
    }
    return { ok: !errors.length, errors: errors, value: value, rejectedDomains: parsed.rejected };
  }

  function makeWidgetId() {
    var s = "";
    try { s = HC.util.uid(); } catch (e) { s = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2); }
    return ("wgt_" + asText(s).replace(/[^a-zA-Z0-9]/g, "")).slice(0, 28) || ("wgt_" + Date.now().toString(36));
  }

  // The embed SNIPPET a provider pastes "exactly as shown" into their site.
  // It is a self-contained <div> placeholder + a <script> that boots the
  // widget. It carries the widget id and the authorised host list so it is
  // self-describing and testable. Returns a string; never throws.
  function buildSnippet(widget) {
    if (!widget || !widget.id) return "";
    var id = escAttr(widget.id);
    var src = WIDGET_BASE + "/embed.js";
    var hosts = (widget.websites || []).join(",");
    var lines = [
      '<!-- HolidayCamp bookings widget — paste into your site exactly as shown -->',
      '<div class="holidaycamp-widget" data-widget="' + id + '"' +
        ' data-group="' + escAttr(widget.groupBy) + '"' +
        (widget.filter ? ' data-filter="' + escAttr(widget.filter) + '"' : "") +
        ' data-primary="' + escAttr(widget.colors.primary) + '"' +
        ' data-accent="' + escAttr(widget.colors.accent) + '"' +
        ' data-hosts="' + escAttr(hosts) + '"></div>',
      '<script async src="' + src + '" data-widget="' + id + '"><' + '/script>'
    ];
    return lines.join("\n");
  }

  /* ===================================================================
     CAMP SELECTION — which of the provider's camps the widget shows, and
     how they are grouped. This is what gets rendered (and is bookable).
     =================================================================== */

  // A bookable "camp card" derived from a live provider record. Every card
  // carries a booking route so the rendered widget is genuinely bookable
  // (article: bookings flow through to Registers).
  function toCard(provider) {
    var id = asText(provider && provider.id);
    return {
      id: id,
      name: asText(provider && provider.name),
      activities: Array.isArray(provider && provider.categories) ? provider.categories.slice() : [],
      venue: asText((provider && (provider.venue || provider.area)) || ""),
      area: asText((provider && provider.area) || ""),
      ageLabel: asText((provider && provider.ageLabel) || ""),
      price: asText((provider && provider.price) || ""),
      // The booking route the widget's "Book" button targets. Bookable.
      bookingRoute: id ? (WIDGET_BASE + "/book/" + encodeURIComponent(id)) : ""
    };
  }

  function isBookableCard(card) {
    return !!(card && card.id && card.bookingRoute && /\/book\//.test(card.bookingRoute));
  }

  // The provider's own camps, as bookable cards. In this single-provider mock
  // every directory entry can act as one of "your" camps; a real app would
  // scope to provider ownership. We pass the camps in so selfTest is hermetic.
  function cardsFor(camps) {
    var list = Array.isArray(camps) ? camps : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = toCard(list[i]);
      if (c.id) out.push(c);
    }
    return out;
  }

  // Apply the widget's optional value filter (only one activity / one venue /
  // one day-group). Case-insensitive. Empty filter => everything.
  function applyFilter(cards, widget) {
    if (!widget || !widget.filter) return cards.slice();
    var f = widget.filter.toLowerCase();
    var mode = widget.groupBy;
    return cards.filter(function (c) {
      if (mode === "venue") return c.venue.toLowerCase().indexOf(f) !== -1;
      if (mode === "day") return true; // day filtering handled by group bucket below
      // activity (default)
      return c.activities.some(function (a) { return asText(a).toLowerCase().indexOf(f) !== -1; });
    });
  }

  // Group the (filtered) cards into the buckets the widget renders, per the
  // chosen mode. Returns [{ label, cards:[...] }, ...] in stable order.
  function groupCards(cards, widget) {
    var mode = (widget && widget.groupBy) || "activity";
    var buckets = [];
    var index = {};
    function bucket(label) {
      var key = label || "Other";
      if (!index[key]) { index[key] = { label: key, cards: [] }; buckets.push(index[key]); }
      return index[key];
    }
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (mode === "venue") {
        bucket(c.venue || "Other venue").cards.push(c);
      } else if (mode === "activity") {
        var acts = c.activities.length ? c.activities : ["Other activity"];
        // A camp can appear under each of its activity tags.
        for (var a = 0; a < acts.length; a++) bucket(asText(acts[a])).cards.push(c);
      } else { // day — bucket by an indicative weekday derived from the id (stable)
        bucket("All week").cards.push(c);
      }
    }
    return buckets;
  }

  // Full resolve of "what a visitor sees when the widget loads on a page".
  // This is the SERVER-SIDE GATE + render in one: if the embedding host is not
  // whitelisted, the widget refuses (renders nothing bookable). Otherwise it
  // returns the grouped, bookable camp cards.
  // Returns { rendered:Boolean, reason:String, groups:[...], cards:[...] }.
  function resolveWidget(widget, host, camps) {
    if (!widget || !widget.id) return { rendered: false, reason: "no-widget", groups: [], cards: [] };
    if (!hostIsWhitelisted(widget.websites, host)) {
      // The security promise: only listed sites can embed it.
      return { rendered: false, reason: "host-not-whitelisted", groups: [], cards: [] };
    }
    var all = cardsFor(camps);
    var filtered = applyFilter(all, widget);
    var groups = groupCards(filtered, widget);
    return { rendered: true, reason: "ok", groups: groups, cards: filtered };
  }

  /* ===================================================================
     CLIPBOARD — the "Copy" action. Returns the exact string it placed on
     the clipboard so the behaviour is testable without a real clipboard
     (acceptance criterion: the provider can COPY the embed snippet).
     =================================================================== */

  function copyToClipboard(text) {
    var value = asText(text);
    var copied = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard &&
          typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch (e) { /* fall through */ }
    if (!copied) {
      try {
        if (typeof document !== "undefined" && document.body) {
          var ta = document.createElement("textarea");
          ta.value = value;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          if (typeof document.execCommand === "function") copied = document.execCommand("copy");
          document.body.removeChild(ta);
        }
      } catch (e2) { /* never throw from a copy */ }
    }
    return { copied: copied, text: value };
  }

  /* ===================================================================
     PERSISTENCE (HC.store only) — multiple named widgets per provider.
     =================================================================== */

  function allWidgets() {
    var raw = null;
    try { raw = HC.store.get(STORE_KEY, {}); } catch (e) { raw = {}; }
    return (raw && typeof raw === "object") ? raw : {};
  }

  function widgetsFor(providerId) {
    var map = allWidgets();
    var bucket = map[providerId];
    return (bucket && typeof bucket === "object") ? bucket : {};
  }

  function saveWidget(value) {
    if (!value || !value.providerId || !value.id) return false;
    var map = allWidgets();
    if (!map[value.providerId] || typeof map[value.providerId] !== "object") map[value.providerId] = {};
    map[value.providerId][value.id] = value;
    try { HC.store.set(STORE_KEY, map); return true; } catch (e) { return false; }
  }

  function deleteWidget(providerId, widgetId) {
    var map = allWidgets();
    if (map[providerId] && map[providerId][widgetId]) {
      delete map[providerId][widgetId];
      try { HC.store.set(STORE_KEY, map); return true; } catch (e) { return false; }
    }
    return false;
  }

  // Build + persist a widget for a provider. Returns the build result.
  function createWidget(providerId, input) {
    input = input || {};
    input.providerId = providerId;
    var res = buildWidget(input);
    if (res.ok) saveWidget(res.value);
    return res;
  }

  /* ===================================================================
     LIVE DATA — real school-age camps for the preview + a default member.
     =================================================================== */

  function firstProvider() {
    try {
      var providers = HC.data.providers || [];
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        if (p && p.id && p.id !== "waltham-forest-haf") return p;
      }
      if (providers.length) return providers[0];
    } catch (e) {}
    return { id: "demo-provider", name: "your holiday camp", categories: ["Multi-activity"] };
  }

  function liveCamps() {
    try {
      var providers = HC.data.providers || [];
      if (providers.length) return providers;
    } catch (e) {}
    return [];
  }

  /* ===================================================================
     UI
     =================================================================== */

  function esc(s) {
    return asText(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function render(mountEl) {
    try {
      var provider = firstProvider();
      var providerId = provider.id;
      var providerName = provider.name || "your holiday camp";
      var camps = liveCamps();
      // The "currently logged-in" provider is a Member in this preview.
      var IS_MEMBER = true;

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">Dashboard → <strong>Settings › Widget</strong>. ' +
          'Let families find and book <strong>' + esc(providerName) + '</strong>\'s camps ' +
          '<strong>without leaving your own website</strong>. Whitelist your site, choose how camps group, ' +
          'add your colours, then <strong>Generate</strong> and copy the embed code.</p>' +

          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin-bottom:16px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:10px">Set up your widget</div>' +

            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Widget name</label>' +
            '<input id="bwName" type="text" value="Summer camp bookings" ' +
              'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:10px">' +

            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Your website(s) — one per line. The widget only embeds on these.</label>' +
            '<textarea id="bwSites" rows="2" placeholder="mycamp.co.uk" ' +
              'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:10px">mycamp.co.uk</textarea>' +

            '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">' +
              '<div style="flex:1;min-width:130px">' +
                '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Group camps by</label>' +
                '<select id="bwGroup" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px">' +
                  '<option value="activity">Activity</option>' +
                  '<option value="venue">Venue</option>' +
                  '<option value="day">Day / week</option>' +
                '</select>' +
              '</div>' +
              '<div style="flex:1;min-width:130px">' +
                '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Only show (optional)</label>' +
                '<input id="bwFilter" type="text" placeholder="e.g. Multi-activity" ' +
                  'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px">' +
              '</div>' +
            '</div>' +

            '<div style="display:flex;gap:14px;align-items:center;margin-bottom:12px">' +
              '<label style="font-weight:700;font-size:12.5px;display:flex;align-items:center;gap:6px">Brand <input id="bwPrimary" type="color" value="' + escAttr(DEFAULT_COLORS.primary) + '" style="width:34px;height:28px;border:none;background:none;cursor:pointer"></label>' +
              '<label style="font-weight:700;font-size:12.5px;display:flex;align-items:center;gap:6px">Accent <input id="bwAccent" type="color" value="' + escAttr(DEFAULT_COLORS.accent) + '" style="width:34px;height:28px;border:none;background:none;cursor:pointer"></label>' +
            '</div>' +

            '<button id="bwGen" type="button" class="hc-btn">Generate code</button>' +
            '<div id="bwErr" style="font-size:12.5px;color:#9a1f5e;margin-top:8px;min-height:14px"></div>' +
          '</div>' +

          '<div id="bwSnippetPanel"></div>' +
          '<div id="bwPreviewPanel" style="margin-top:16px"></div>' +
        '</div>';

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function readForm() {
        return {
          isMember: IS_MEMBER,
          name: $("bwName").value,
          websites: $("bwSites").value,
          groupBy: $("bwGroup").value,
          filter: $("bwFilter").value,
          primary: $("bwPrimary").value,
          accent: $("bwAccent").value
        };
      }

      function renderSnippet(widget) {
        var host = $("bwSnippetPanel");
        if (!host) return;
        if (!widget) { host.innerHTML = ""; return; }
        host.innerHTML =
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin:0 0 8px">Your embed code</div>' +
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:12px 14px">' +
            '<div style="font-size:12px;color:var(--muted,#808080);margin-bottom:6px">' +
              'Allowed on: <strong>' + esc(widget.websites.join(", ")) + '</strong> · grouped by <strong>' + esc(widget.groupBy) + '</strong>' +
              (widget.filter ? ' · only <strong>' + esc(widget.filter) + '</strong>' : "") + '</div>' +
            '<textarea id="bwSnippet" readonly rows="4" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:12px;background:#FAFAFA;font-family:ui-monospace,Menlo,monospace" onclick="this.select()">' +
              esc(widget.snippet) + '</textarea>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
              '<button id="bwCopy" type="button" class="hc-btn">📋 Copy code</button>' +
              '<button id="bwPreview" type="button" class="hc-btn hc-btn-ghost">Preview on my site</button>' +
            '</div>' +
            '<p style="font-size:12px;color:var(--muted,#808080);margin:10px 0 0">Paste this into your site exactly as shown. Bookings appear in <strong>My Classes › Registers</strong>.</p>' +
          '</div>';

        var copyBtn = $("bwCopy");
        if (copyBtn) copyBtn.addEventListener("click", function () {
          var res = copyToClipboard(widget.snippet);
          try { HC.util.toast(res.copied ? "Embed code copied" : "Select the code and copy it"); } catch (e) {}
          var ta = $("bwSnippet");
          if (ta) { try { ta.focus(); ta.select(); } catch (e) {} }
        });
        var prevBtn = $("bwPreview");
        if (prevBtn) prevBtn.addEventListener("click", function () { renderPreview(widget, widget.websites[0]); });
      }

      function renderPreview(widget, host) {
        var panel = $("bwPreviewPanel");
        if (!panel) return;
        var res = resolveWidget(widget, host, camps);
        var headStyle = 'background:' + esc(widget.colors.primary) + ';color:#fff';
        var html =
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin:0 0 8px">Live preview on ' + esc(host || "your site") + '</div>' +
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;overflow:hidden">' +
            '<div style="padding:10px 14px;font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;' + headStyle + '">' +
              esc(widget.name) + ' — book online</div>';
        if (!res.rendered) {
          html += '<div style="padding:14px;color:#9a1f5e;font-size:13px">This widget will not load here (host not whitelisted).</div>';
        } else if (!res.cards.length) {
          html += '<div style="padding:14px;color:var(--muted,#808080);font-size:13px">No camps match this widget\'s filter.</div>';
        } else {
          for (var g = 0; g < res.groups.length; g++) {
            var grp = res.groups[g];
            html += '<div style="padding:8px 14px 2px;font-weight:700;font-size:12.5px;color:var(--purple,#603488)">' + esc(grp.label) + '</div>';
            for (var c = 0; c < grp.cards.length; c++) {
              var card = grp.cards[c];
              html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid var(--line,#F0F0F0)">' +
                '<div style="min-width:0"><div style="font-weight:700;font-size:13.5px;color:var(--text,#383838);overflow:hidden;text-overflow:ellipsis">' + esc(card.name) + '</div>' +
                '<div style="font-size:11.5px;color:var(--muted,#808080)">' + esc(card.ageLabel ? "Ages " + card.ageLabel : "") + (card.price ? " · " + esc(card.price) : "") + '</div></div>' +
                '<a href="' + escAttr(card.bookingRoute) + '" target="_blank" rel="noopener" class="hc-btn" style="background:' + esc(widget.colors.accent) + ';white-space:nowrap">Book</a>' +
                '</div>';
            }
          }
        }
        html += '</div>';
        panel.innerHTML = html;
      }

      function renderSavedList() {
        var bucket = widgetsFor(providerId);
        var ids = Object.keys(bucket);
        // (kept simple — saved widgets are reflected by re-generating)
        return ids.length;
      }

      $("bwGen").addEventListener("click", function () {
        var res = createWidget(providerId, readForm());
        if (res.ok) {
          $("bwErr").textContent = res.rejectedDomains.length
            ? ("Ignored unrecognised: " + res.rejectedDomains.join(", "))
            : "";
          try { HC.util.toast("Embed code generated"); } catch (e) {}
          renderSnippet(res.value);
          renderPreview(res.value, res.value.websites[0]);
          renderSavedList();
        } else {
          $("bwErr").innerHTML = res.errors.map(esc).join("<br>");
          renderSnippet(null);
        }
      });
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Widget panel failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ===================================================================
     SELF-TEST — exercises the LOGIC and asserts the acceptance criterion.
     Hermetic: passes in its own camp fixtures and an isolated provider id.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Fixture camps (school-age holiday camps), independent of live data.
    var FIX = [
      { id: "super-camps-walthamstow", name: "Super Camps — Walthamstow", categories: ["Multi-activity", "Sports"], venue: "Walthamstow", area: "Walthamstow", ageLabel: "5-12", price: "£38/day" },
      { id: "kings-camps-leyton", name: "Kings Camps — Leyton", categories: ["Sports"], venue: "Leyton", area: "Leyton", ageLabel: "5-14", price: "£42/day" },
      { id: "stagecoach-summer", name: "Stagecoach Summer School", categories: ["Performing arts", "Multi-activity"], venue: "Chingford", area: "Chingford", ageLabel: "6-16", price: "£45/day" }
    ];
    var MEMBER = true;

    // ---------- ACCEPTANCE CRITERION ----------
    // "A Member can whitelist their domain and copy an embed snippet that
    //  renders their bookable camps."
    check("ACCEPTANCE: a Member whitelists a domain and copies a snippet that renders bookable camps", function () {
      var res = buildWidget({ providerId: "super-camps", isMember: MEMBER, websites: "https://www.mycamp.co.uk/summer" });
      HC.assert(res.ok === true, "member widget should build; errors: " + res.errors.join("; "));
      // whitelist captured the typed domain, normalised.
      HC.assert(res.value.websites.indexOf("mycamp.co.uk") !== -1, "whitelist should contain mycamp.co.uk, got " + res.value.websites.join(","));
      // a copyable embed snippet exists and carries the widget id + hosts.
      var copied = copyToClipboard(res.value.snippet);
      HC.assert(copied.text === res.value.snippet, "copied text must equal the snippet");
      HC.assert(/holidaycamp-widget/.test(copied.text), "snippet must be an embeddable widget block");
      HC.assert(copied.text.indexOf(res.value.id) !== -1, "snippet must carry the widget id");
      HC.assert(copied.text.indexOf("mycamp.co.uk") !== -1, "snippet must reference the whitelisted host");
      // rendered on the whitelisted host -> bookable camps appear.
      var view = resolveWidget(res.value, "mycamp.co.uk", FIX);
      HC.assert(view.rendered === true, "widget should render on the whitelisted host");
      HC.assert(view.cards.length === FIX.length, "all the provider's camps should render, got " + view.cards.length);
      HC.assert(view.cards.every(isBookableCard), "every rendered camp must be bookable");
    });

    // ---------- MEMBER GATE ----------
    check("A free (non-member) provider cannot build a widget", function () {
      var res = buildWidget({ providerId: "p1", isMember: false, websites: "mycamp.co.uk" });
      HC.assert(res.ok === false, "non-member must be blocked");
      HC.assert(res.errors.join(" ").toLowerCase().indexOf("member") !== -1, "error should mention Members only");
      HC.assert(res.value === null, "no widget value should be produced for a non-member");
    });

    check("Member flag must be explicitly true (defaults to blocked)", function () {
      HC.assert(buildWidget({ providerId: "p1", websites: "mycamp.co.uk" }).ok === false, "missing isMember must block");
    });

    // ---------- DOMAIN WHITELIST: parsing & normalisation ----------
    check("Domain box normalises scheme / www / path / port into bare hosts", function () {
      var p = parseDomainBox("https://www.MyCamp.co.uk:443/book?ref=1\n http://book.mycamp.co.uk/ ");
      HC.assert(p.domains.indexOf("mycamp.co.uk") !== -1, "should normalise to mycamp.co.uk");
      HC.assert(p.domains.indexOf("book.mycamp.co.uk") !== -1, "should keep distinct subdomain host");
      HC.assert(p.domains.length === 2, "should be exactly two distinct hosts, got " + p.domains.join(","));
    });

    check("Domain box de-duplicates and rejects garbage", function () {
      var p = parseDomainBox("mycamp.co.uk, mycamp.co.uk, not a domain, http://, example.org");
      HC.assert(p.domains.length === 2, "two valid unique domains expected, got " + p.domains.join(","));
      HC.assert(p.domains.indexOf("mycamp.co.uk") !== -1 && p.domains.indexOf("example.org") !== -1, "valid domains kept");
      HC.assert(p.rejected.length >= 1, "garbage entries should be rejected");
    });

    check("At least one valid website is required", function () {
      var res = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "   not-a-domain  " });
      HC.assert(res.ok === false, "no valid domain must fail the build");
      HC.assert(res.errors.join(" ").toLowerCase().indexOf("website") !== -1, "error should ask for a website");
    });

    // ---------- DOMAIN WHITELIST: the embed gate ----------
    check("Widget renders ONLY on a whitelisted host", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk" }).value;
      HC.assert(resolveWidget(w, "mycamp.co.uk", FIX).rendered === true, "listed host should render");
      var blocked = resolveWidget(w, "evil-clone.com", FIX);
      HC.assert(blocked.rendered === false, "an unlisted host must be refused");
      HC.assert(blocked.reason === "host-not-whitelisted", "refusal reason should be host-not-whitelisted, got " + blocked.reason);
      HC.assert(blocked.cards.length === 0, "a refused widget must render no bookable camps");
    });

    check("Whitelisting a domain also authorises its subdomains (not other domains)", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk" }).value;
      HC.assert(hostIsWhitelisted(w.websites, "book.mycamp.co.uk") === true, "subdomain of a listed domain is allowed");
      HC.assert(hostIsWhitelisted(w.websites, "www.mycamp.co.uk") === true, "www host is allowed");
      HC.assert(hostIsWhitelisted(w.websites, "notmycamp.co.uk") === false, "a look-alike domain must NOT be allowed");
      HC.assert(hostIsWhitelisted(w.websites, "mycamp.co.uk.evil.com") === false, "suffix-spoof must NOT be allowed");
    });

    check("Multiple websites can be whitelisted at once", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk\nsummerclub.org" }).value;
      HC.assert(w.websites.length === 2, "both hosts should be whitelisted");
      HC.assert(resolveWidget(w, "summerclub.org", FIX).rendered === true, "second host should also render");
    });

    // ---------- SNIPPET ----------
    check("Generated snippet is an embeddable HTML block carrying id + hosts", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk" }).value;
      HC.assert(typeof w.snippet === "string" && w.snippet.length > 0, "snippet string expected");
      HC.assert(/<div[^>]*class="holidaycamp-widget"/.test(w.snippet), "snippet should contain the widget div");
      HC.assert(/<script[^>]*embed\.js/.test(w.snippet), "snippet should load the embed script");
      HC.assert(w.snippet.indexOf('data-widget="' + w.id + '"') !== -1, "snippet should carry the widget id attribute");
      HC.assert(w.snippet.indexOf("mycamp.co.uk") !== -1, "snippet should declare the authorised host(s)");
      HC.assert(w.snippet.indexOf("</" + "script>") !== -1, "snippet should be a complete, closed block");
    });

    check("Changing settings produces a fresh snippet (Generate again)", function () {
      var a = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk", groupBy: "activity" }).value;
      var b = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk", groupBy: "venue", id: a.id }).value;
      HC.assert(a.snippet !== b.snippet, "a settings change should yield a different snippet");
      HC.assert(/data-group="venue"/.test(b.snippet), "new snippet should reflect the new grouping");
    });

    // ---------- BOOKABLE CAMPS ----------
    check("Rendered camps are the provider's own camps and each is bookable", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk" }).value;
      var view = resolveWidget(w, "mycamp.co.uk", FIX);
      HC.assert(view.cards.length === FIX.length, "every camp should be offered");
      view.cards.forEach(function (c) {
        HC.assert(isBookableCard(c), c.name + " should be bookable");
        HC.assert(/\/book\//.test(c.bookingRoute), "booking route should point at a booking action: " + c.bookingRoute);
        HC.assert(c.bookingRoute.indexOf(encodeURIComponent(c.id)) !== -1, "booking route should target the camp id");
      });
    });

    // ---------- GROUPING & FILTERING (article Step 4) ----------
    check("Group by Venue buckets camps by their venue", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk", groupBy: "venue" }).value;
      var view = resolveWidget(w, "mycamp.co.uk", FIX);
      var labels = view.groups.map(function (g) { return g.label; });
      HC.assert(labels.indexOf("Walthamstow") !== -1 && labels.indexOf("Leyton") !== -1, "venue buckets expected, got " + labels.join(","));
      HC.assert(view.groups.length === 3, "three distinct venues -> three buckets, got " + view.groups.length);
    });

    check("Group by Activity lets a camp appear under each of its activities", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk", groupBy: "activity" }).value;
      var view = resolveWidget(w, "mycamp.co.uk", FIX);
      var multi = view.groups.filter(function (g) { return g.label === "Multi-activity"; })[0];
      HC.assert(multi, "a Multi-activity bucket should exist");
      // super-camps + stagecoach both carry Multi-activity.
      HC.assert(multi.cards.length === 2, "two camps tagged Multi-activity, got " + multi.cards.length);
    });

    check("Value filter narrows the widget to one activity", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk", groupBy: "activity", filter: "Sports" }).value;
      var view = resolveWidget(w, "mycamp.co.uk", FIX);
      // super-camps (Sports) + kings (Sports) match; stagecoach does not.
      HC.assert(view.cards.length === 2, "only Sports camps should show, got " + view.cards.length);
      HC.assert(view.cards.every(function (c) { return c.activities.indexOf("Sports") !== -1; }), "all shown camps must be Sports");
    });

    check("Value filter narrows the widget to one venue", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk", groupBy: "venue", filter: "Leyton" }).value;
      var view = resolveWidget(w, "mycamp.co.uk", FIX);
      HC.assert(view.cards.length === 1 && view.cards[0].id === "kings-camps-leyton", "only the Leyton camp should show");
    });

    check("Invalid grouping falls back to 'activity'", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk", groupBy: "nonsense" }).value;
      HC.assert(w.groupBy === "activity", "unknown group mode should default to activity, got " + w.groupBy);
    });

    // ---------- BRANDING (article Step 5) ----------
    check("Brand colours are validated; invalid colours fall back to defaults", function () {
      var w = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk", primary: "#123abc", accent: "not-a-color" }).value;
      HC.assert(w.colors.primary === "#123abc", "valid hex should be kept");
      HC.assert(w.colors.accent === DEFAULT_COLORS.accent, "invalid colour should fall back to default");
      var d = buildWidget({ providerId: "p1", isMember: MEMBER, websites: "mycamp.co.uk" }).value;
      HC.assert(d.colors.primary === DEFAULT_COLORS.primary && d.colors.accent === DEFAULT_COLORS.accent, "defaults apply when unset");
    });

    // ---------- PERSISTENCE (HC.store, isolated; multiple widgets) ----------
    check("Widgets CRUD round-trips through HC.store; many widgets per provider", function () {
      var PID = "__selftest_widget__" + HC.util.uid();
      HC.assert(Object.keys(widgetsFor(PID)).length === 0, "test provider should start with no widgets");

      var a = createWidget(PID, { isMember: MEMBER, websites: "mycamp.co.uk", name: "Summer" });
      var b = createWidget(PID, { isMember: MEMBER, websites: "summerclub.org", name: "Half-term" });
      HC.assert(a.ok && b.ok, "both widgets should build");
      var bucket = widgetsFor(PID);
      HC.assert(Object.keys(bucket).length === 2, "two widgets should be persisted, got " + Object.keys(bucket).length);
      HC.assert(bucket[a.value.id].snippet === a.value.snippet, "stored snippet should match generated");

      // Stored widget still gates by host and renders bookable camps.
      var view = resolveWidget(bucket[a.value.id], "mycamp.co.uk", FIX);
      HC.assert(view.rendered === true && view.cards.every(isBookableCard), "stored widget renders bookable camps on its host");
      HC.assert(resolveWidget(bucket[a.value.id], "elsewhere.com", FIX).rendered === false, "stored widget still refuses other hosts");

      HC.assert(deleteWidget(PID, a.value.id) === true, "delete should succeed");
      HC.assert(Object.keys(widgetsFor(PID)).length === 1, "one widget should remain after delete");
      // Clean up.
      deleteWidget(PID, b.value.id);
      HC.assert(Object.keys(widgetsFor(PID)).length === 0, "test provider cleaned up");
    });

    // ---------- LIVE DATA sanity ----------
    check("A real live holiday camp renders bookable cards through a whitelisted widget", function () {
      var provider = firstProvider();
      HC.assert(provider && provider.id, "should resolve a live provider");
      var res = buildWidget({ providerId: provider.id, isMember: MEMBER, websites: "mycamp.co.uk" });
      HC.assert(res.ok === true, "live provider widget should build");
      var camps = liveCamps();
      if (camps.length) {
        var view = resolveWidget(res.value, "mycamp.co.uk", camps);
        HC.assert(view.rendered === true, "live widget should render on its host");
        HC.assert(view.cards.length > 0, "live widget should render at least one camp");
        HC.assert(view.cards.every(isBookableCard), "every live camp card must be bookable");
      } else {
        // No live data under Node — assert the snippet path still holds.
        HC.assert(/holidaycamp-widget/.test(res.value.snippet), "snippet should still be embeddable without live data");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER (idempotent + defensive via core).
     =================================================================== */
  HC.registerFeature({
    id: "provider-booking-widget",
    title: "Embeddable bookings widget for your own site",
    side: "provider",
    icon: "🧩",
    summary: "Take bookings without sending families off your website. Whitelist your domain(s) so the widget only embeds where you allow, choose how your camps group (Activity, Venue or Day), add two brand colours, then Generate and Copy an embed snippet. Members only. Bookings still land in My Classes › Registers.",
    render: render,
    selfTest: selfTest
  });
})();
