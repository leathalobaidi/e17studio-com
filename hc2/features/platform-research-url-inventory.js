/* HolidayCamp feature — platform-research-url-inventory
 *
 * Searchable evidence map for the local Happity / support Firecrawl exports.
 *
 * The generated data file contains URL metadata only: no article bodies, no
 * private/internal account data, and no copied marketing pages. This lets the
 * prototype prove research coverage while keeping HolidayCamp's implementation
 * original and school-age holiday-camp focused.
 */
(function () {
  "use strict";

  if (!window.HC || typeof HC.registerFeature !== "function") return;

  function index() {
    var idx = window.HC_RESEARCH_INDEX || {};
    return {
      totals: idx.totals || { links: 0, support: 0, public: 0 },
      links: Array.isArray(idx.links) ? idx.links : []
    };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function matches(link, q) {
    if (!q) return true;
    var hay = [
      link.label,
      link.url,
      link.source,
      link.side,
      link.kind,
      (link.tags || []).join(" ")
    ].join(" ").toLowerCase();
    return hay.indexOf(q.toLowerCase()) !== -1;
  }

  function countsBy(field, links) {
    var out = {};
    links.forEach(function (l) {
      var k = l[field] || "unknown";
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }

  function renderRows(links, q) {
    var filtered = links.filter(function (l) { return matches(l, q); }).slice(0, 40);
    if (!filtered.length) return '<p style="color:var(--muted,#808080)">No URLs match that search.</p>';
    return filtered.map(function (l) {
      return '<div class="hcri-row">' +
        '<strong>' + escapeHtml(l.label || l.url) + "</strong>" +
        '<div class="hcri-meta">' + escapeHtml([l.source, l.side, l.kind].join(" · ")) +
          " · " + escapeHtml((l.tags || []).join(", ")) + "</div>" +
        '<a href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener">' + escapeHtml(l.url) + "</a>" +
      "</div>";
    }).join("");
  }

  function render(mountEl) {
    var idx = index();
    var bySource = countsBy("source", idx.links);
    var bySide = countsBy("side", idx.links);
    mountEl.innerHTML =
      '<div class="hcri">' +
        '<div class="hcri-stats">' +
          stat("Total URLs", idx.totals.links || idx.links.length, "Every public/support URL from the local exports") +
          stat("Support", idx.totals.support || bySource.support || 0, "How-to and logged-in workflow evidence") +
          stat("Public", idx.totals.public || bySource.public || 0, "SEO, venue, schedule and category route evidence") +
        "</div>" +
        '<div class="hcri-stats hcri-small">' +
          stat("Parent", bySide.parent || 0, "Demand-side routes") +
          stat("Provider", bySide.provider || 0, "Supply-side operations") +
          stat("Platform", bySide.platform || 0, "SEO, growth and marketplace routes") +
        "</div>" +
        '<label class="hcri-search"><span>Search evidence URLs</span><input id="hcriQuery" placeholder="booking, register, widget, venue, newsletter..." /></label>' +
        '<div id="hcriRows" class="hcri-list">' + renderRows(idx.links, "") + "</div>" +
      "</div>";
    injectStyles();
    var q = mountEl.querySelector("#hcriQuery");
    var rows = mountEl.querySelector("#hcriRows");
    if (q && rows) {
      q.addEventListener("input", function () {
        rows.innerHTML = renderRows(idx.links, q.value.trim());
      });
    }
  }

  function stat(label, value, note) {
    return '<div class="hcri-stat"><div class="hcri-k">' + escapeHtml(label) + '</div><div class="hcri-v">' +
      escapeHtml(value) + '</div><p>' + escapeHtml(note) + "</p></div>";
  }

  function injectStyles() {
    if (document.getElementById("hcri-styles")) return;
    var css =
      ".hcri{display:grid;gap:14px}.hcri-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}" +
      ".hcri-stat{border:1px solid var(--line,#e6e6e6);border-radius:8px;background:#fff;padding:14px}" +
      ".hcri-k{font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:12px;text-transform:uppercase;letter-spacing:.4px}" +
      ".hcri-v{font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--ink,#1a1a1a);font-size:26px;line-height:1;margin-top:4px}" +
      ".hcri-stat p{font-size:12.5px;color:var(--muted,#808080);margin:7px 0 0}" +
      ".hcri-search span{display:block;font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:13px;margin-bottom:5px}" +
      ".hcri-search input{width:100%;font:inherit;border:1.5px solid var(--purple-tint,#F0E8F4);border-radius:8px;padding:10px 12px}" +
      ".hcri-list{display:grid;gap:8px;max-height:420px;overflow:auto}.hcri-row{border:1px solid var(--line,#e6e6e6);border-radius:8px;padding:10px;background:#fff;font-size:13px}" +
      ".hcri-row strong{display:block;font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488)}.hcri-meta{color:var(--muted,#808080);font-size:12px;margin:2px 0 4px}.hcri-row a{word-break:break-word}" +
      "@media(max-width:720px){.hcri-stats{grid-template-columns:1fr}}";
    document.head.appendChild(HC.util.el("style", { id: "hcri-styles" }, css));
  }

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }
    var idx = index();
    check("Generated URL inventory is loaded", function () {
      HC.assert(idx.links.length >= 5000, "expected at least 5000 URLs, got " + idx.links.length);
    });
    check("Support and public sources are both present", function () {
      HC.assert(idx.links.some(function (l) { return l.source === "support"; }), "support source missing");
      HC.assert(idx.links.some(function (l) { return l.source === "public"; }), "public source missing");
    });
    check("Booking/register/widget evidence is searchable", function () {
      var bookingHits = idx.links.filter(function (l) { return matches(l, "booking"); });
      var widgetHits = idx.links.filter(function (l) { return matches(l, "widget"); });
      HC.assert(bookingHits.length > 0, "expected booking URL evidence");
      HC.assert(widgetHits.length > 0, "expected widget URL evidence");
    });
    return { pass: pass, fail: fail, log: log };
  }

  HC.registerFeature({
    id: "platform-research-url-inventory",
    title: "Research URL inventory",
    side: "platform",
    icon: "🧭",
    summary: "Search the 5,198 public/support URLs imported from the local Firecrawl evidence bundle.",
    render: render,
    selfTest: selfTest
  });
})();
