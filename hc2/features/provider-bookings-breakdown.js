/* HolidayCamp feature — provider-bookings-breakdown
 *
 * Bookings/payments breakdown + export  (PROVIDER side)
 *
 * Replicates Happity's "breakdown of my bookings" + sales/data export.
 * Evidence (support articles):
 *   - 8264831 "Where can I see a breakdown of my bookings?":
 *       "Exporting a breakdown of your bookings and payments is simple to do!
 *        Your Stripe dashboard provides you with the tools you need... you will
 *        see a selection of different payments such as: All / Succeeded /
 *        Refunded / Uncaptured / Failed. Above each is a button to export this
 *        data, this data will export as a[n] excel spreadsheet."
 *   - 5342227 "How can I access my sales, marketing & customer data on Happity?":
 *       Sales report "shows - The revenue for each class... The ticket types
 *        purchased and individual spend... How the booking was made (Stripe or
 *        manual)... The Booking date and time." and customers can "export all
 *        your customers' contact details to a CSV file" via "Export to CSV".
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a holiday-camp provider opens a
 * bookings & payments report for their camps. Each row is one paid (or manual)
 * place: customer, camp, week, ticket type, amount, Stripe fee, net, payment
 * method (Stripe / manual) and a Stripe-style payment status. The provider can
 * filter by status (All / Succeeded / Refunded / Uncaptured / Failed), see
 * reconciled summary totals (gross, refunds, fees, net payout), and EXPORT the
 * filtered breakdown as a CSV / Stripe-style spreadsheet export.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Provider can VIEW and EXPORT a bookings/payments report (CSV / Stripe export).
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-bookings-breakdown: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_bookings_breakdown_state";

  /* ---------------- domain constants ---------------- */

  // Stripe-style payment statuses, exactly as Happity surfaces them (evidence 8264831).
  var STATUS = {
    SUCCEEDED: "succeeded",
    REFUNDED: "refunded",
    UNCAPTURED: "uncaptured",
    FAILED: "failed"
  };
  var STATUS_ORDER = [STATUS.SUCCEEDED, STATUS.REFUNDED, STATUS.UNCAPTURED, STATUS.FAILED];

  // The filter tabs the provider can pick — "all" plus each Stripe status.
  var FILTERS = ["all"].concat(STATUS_ORDER);

  // Payment methods a booking can be taken through (evidence 5342227: "Stripe or manual").
  var METHOD = { STRIPE: "stripe", MANUAL: "manual" };

  // Stripe per-transaction fee Happity quotes elsewhere in the corpus: 1.5% + 20p.
  var STRIPE_FEE_PCT = 0.015;
  var STRIPE_FEE_FIXED_P = 20; // pence

  // Human labels for the status filter chips.
  var STATUS_LABEL = {
    all: "All",
    succeeded: "Succeeded",
    refunded: "Refunded",
    uncaptured: "Uncaptured",
    failed: "Failed"
  };

  /* ---------------- small safe helpers ---------------- */

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  function round2(n) {
    var num = Number(n);
    if (!isFinite(num)) return 0;
    return Math.round(num * 100) / 100;
  }

  function toNumber(n) {
    var num = Number(n);
    return isFinite(num) ? num : 0;
  }

  function money(n) {
    try { return HC.util.money(round2(n)); } catch (e) { return "£" + round2(n).toFixed(2); }
  }

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Parse a "£35", "£12.50", "From £8" style price string into a number of pounds.
  function parsePrice(str) {
    if (typeof str === "number" && isFinite(str)) return str;
    if (typeof str !== "string") return 0;
    var m = str.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : 0;
  }

  /* ---------------- Stripe fee maths ----------------
   * Mirrors the connect feature: gross stays, fee = 1.5% + 20p, net = gross - fee.
   * Returns pounds, rounded to 2dp. Junk amounts -> zero fee (never throws). */
  function stripeFee(amountPounds) {
    var gross = toNumber(amountPounds);
    if (gross <= 0) return { gross: round2(Math.max(0, gross)), fee: 0, net: round2(Math.max(0, gross)) };
    var feeP = gross * 100 * STRIPE_FEE_PCT + STRIPE_FEE_FIXED_P; // in pence
    var fee = round2(feeP / 100);
    return { gross: round2(gross), fee: fee, net: round2(gross - fee) };
  }

  /* ---------------- mock booking dataset ----------------
   *
   * A booking row models one place sold for a holiday camp:
   *   {
   *     id, providerId, campName, week, ticket, customer, childName,
   *     method: METHOD.*, status: STATUS.*, bookedAt: ISO,
   *     gross: Number (pounds), fee: Number, net: Number,
   *     refunded: Number (pounds refunded; >0 only when status === refunded)
   *   }
   *
   * Deterministic so the report + selfTest are reproducible. */

  var SAMPLE_CHILDREN = ["Ava", "Noah", "Mia", "Leo", "Isla", "Theo", "Freya", "Jack", "Nia", "Oscar", "Ruby", "Finn"];
  var SAMPLE_PARENTS = ["Sarah Webb", "Tom Ellis", "Priya Shah", "James Cole", "Maria Ortiz", "Dan Powell",
    "Aisha Khan", "Greg Lyons", "Hannah Reid", "Omar Aziz", "Beth Carr", "Will Hart"];
  var SAMPLE_WEEKS = ["Wk1 21 Jul", "Wk2 28 Jul", "Wk3 4 Aug", "Wk4 11 Aug", "Wk5 18 Aug", "Wk6 25 Aug"];
  var TICKET_TYPES = ["Full day", "Half day (AM)", "Half day (PM)", "Sibling place", "Early drop-off"];

  function pickSeedProvider() {
    var ps = providers();
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (p && /£|from £/i.test(String(p.price || ""))) return p;
    }
    if (ps.length) return ps[0];
    return { id: "demo-camp", name: "Demo Holiday Camp", price: "£35" };
  }

  // Deterministic pseudo-random from a seed (so a given seed always builds the same rows).
  function seededRand(seed) {
    var s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return function () {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  // Build N booking rows for a provider, deterministically from a seed.
  function buildBookings(provider, count, seed) {
    var rows = [];
    var p = provider || pickSeedProvider();
    var basePrice = parsePrice(p && p.price) || 35;
    var rand = seededRand(toNumber(seed) || 12345);
    var n = Math.max(0, toNumber(count) || 0);
    for (var i = 0; i < n; i++) {
      var ticket = TICKET_TYPES[Math.floor(rand() * TICKET_TYPES.length)];
      // Half days cost ~60% of a full day; sibling place gets a small discount.
      var mult = ticket.indexOf("Half day") === 0 ? 0.6 : (ticket === "Sibling place" ? 0.85 : 1);
      var gross = round2(Math.max(5, basePrice * mult));
      // Status mix: mostly succeeded, some refunded/uncaptured/failed.
      var roll = rand();
      var status, method;
      if (roll < 0.7) { status = STATUS.SUCCEEDED; }
      else if (roll < 0.85) { status = STATUS.REFUNDED; }
      else if (roll < 0.93) { status = STATUS.UNCAPTURED; }
      else { status = STATUS.FAILED; }
      // ~20% of succeeded/refunded rows were taken manually (e.g. pay-on-door),
      // the rest via Stripe (evidence 5342227 distinguishes Stripe vs manual).
      method = rand() < 0.2 ? METHOD.MANUAL : METHOD.STRIPE;

      var fees = stripeFee(gross);
      var fee = method === METHOD.STRIPE ? fees.fee : 0; // manual takings carry no Stripe fee
      var net, refunded = 0;
      if (status === STATUS.SUCCEEDED) {
        net = round2(gross - fee);
      } else if (status === STATUS.REFUNDED) {
        refunded = gross;          // full refund returned to the parent
        net = round2(0 - fee);     // Stripe fee may not be returned -> small negative net
        if (method === METHOD.MANUAL) net = 0;
      } else {
        // Uncaptured (authorised, not taken) and Failed bring in no money.
        gross = status === STATUS.UNCAPTURED ? gross : gross; // gross is the attempted amount
        fee = 0;
        net = 0;
      }

      var dayOffset = i; // spread bookings across recent days, deterministic
      var bookedAt;
      try {
        bookedAt = new Date(Date.UTC(2026, 5, 1 + (dayOffset % 28), 9 + (i % 8), (i * 7) % 60)).toISOString();
      } catch (e) {
        bookedAt = nowIso();
      }

      rows.push({
        id: "bk_" + (i + 1) + "_" + safeUid().slice(-6),
        providerId: (p && p.id) || "demo-camp",
        campName: (p && p.name) || "Holiday Camp",
        week: SAMPLE_WEEKS[i % SAMPLE_WEEKS.length],
        ticket: ticket,
        customer: SAMPLE_PARENTS[i % SAMPLE_PARENTS.length],
        childName: SAMPLE_CHILDREN[i % SAMPLE_CHILDREN.length],
        method: method,
        status: status,
        bookedAt: bookedAt,
        gross: round2(gross),
        fee: round2(fee),
        net: round2(net),
        refunded: round2(refunded)
      });
    }
    return rows;
  }

  /* ---------------- pure report logic (testable, DOM-free) ---------------- */

  // Filter rows by a status filter ("all" or a STATUS.* value).
  function filterByStatus(rows, filter) {
    var list = Array.isArray(rows) ? rows : [];
    if (!filter || filter === "all") return list.slice();
    return list.filter(function (r) { return r && r.status === filter; });
  }

  // Count rows per status (plus "all"), e.g. for the filter chip badges.
  function statusCounts(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var counts = { all: list.length };
    for (var i = 0; i < STATUS_ORDER.length; i++) counts[STATUS_ORDER[i]] = 0;
    for (var j = 0; j < list.length; j++) {
      var st = list[j] && list[j].status;
      if (Object.prototype.hasOwnProperty.call(counts, st)) counts[st] += 1;
    }
    return counts;
  }

  // Reconciled summary totals for a set of rows — the heart of the "breakdown".
  // gross   = sum of amounts on SUCCEEDED + REFUNDED rows (money that was taken)
  // refunds = sum of refunded amounts
  // fees    = sum of Stripe fees actually charged
  // net     = sum of net (what the provider keeps / their payout)
  function summarise(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var s = { count: list.length, gross: 0, refunds: 0, fees: 0, net: 0, stripeCount: 0, manualCount: 0 };
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      if (r.status === STATUS.SUCCEEDED || r.status === STATUS.REFUNDED) {
        s.gross += toNumber(r.gross);
      }
      s.refunds += toNumber(r.refunded);
      s.fees += toNumber(r.fee);
      s.net += toNumber(r.net);
      if (r.method === METHOD.STRIPE) s.stripeCount += 1;
      else if (r.method === METHOD.MANUAL) s.manualCount += 1;
    }
    s.gross = round2(s.gross);
    s.refunds = round2(s.refunds);
    s.fees = round2(s.fees);
    s.net = round2(s.net);
    return s;
  }

  /* ---------------- CSV / Stripe export ----------------
   * Produces a Stripe-style spreadsheet export (CSV) of the breakdown.
   * Columns mirror what Happity's sales report shows (evidence 5342227):
   * revenue, ticket type & individual spend, how booked (Stripe/manual),
   * booking date & time — plus the Stripe status & fee reconciliation. */

  var CSV_COLUMNS = [
    { key: "id", label: "Booking ID" },
    { key: "bookedAt", label: "Booking Date & Time" },
    { key: "campName", label: "Camp" },
    { key: "week", label: "Week" },
    { key: "ticket", label: "Ticket Type" },
    { key: "customer", label: "Customer" },
    { key: "childName", label: "Child" },
    { key: "method", label: "Payment Method" },
    { key: "status", label: "Payment Status" },
    { key: "gross", label: "Amount (£)" },
    { key: "fee", label: "Stripe Fee (£)" },
    { key: "refunded", label: "Refunded (£)" },
    { key: "net", label: "Net (£)" }
  ];

  // RFC-4180-ish CSV field escaping: wrap in quotes if it has comma/quote/newline.
  function csvField(value) {
    var s = (value === null || value === undefined) ? "" : String(value);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // Build the CSV text for a set of rows. Always includes a header row.
  function toCsv(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var lines = [];
    lines.push(CSV_COLUMNS.map(function (c) { return csvField(c.label); }).join(","));
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      lines.push(CSV_COLUMNS.map(function (c) {
        var v = r[c.key];
        // Numeric money columns get 2dp; keep raw otherwise.
        if (c.key === "gross" || c.key === "fee" || c.key === "net" || c.key === "refunded") {
          v = round2(toNumber(v)).toFixed(2);
        }
        return csvField(v);
      }).join(","));
    }
    return lines.join("\r\n");
  }

  // Build a filename for the export, scoped to provider + filter + date.
  function exportFilename(providerId, filter) {
    var pid = String(providerId || "provider").replace(/[^a-z0-9_-]/gi, "-");
    var f = filter && filter !== "all" ? "-" + filter : "";
    var d = nowIso().slice(0, 10);
    return "holidaycamp-bookings-" + pid + f + "-" + d + ".csv";
  }

  // The export "action": returns the artefact (filename + mime + csv + rowCount).
  // In the browser it also triggers a download; in tests it just returns the data.
  function buildExport(rows, providerId, filter) {
    var list = Array.isArray(rows) ? rows : [];
    var csv = toCsv(list);
    return {
      filename: exportFilename(providerId, filter),
      mime: "text/csv",
      csv: csv,
      // dataRows excludes the header line.
      rowCount: csv.split(/\r\n|\n/).length - 1
    };
  }

  // Trigger an actual file download in the browser (no-op-safe in non-DOM env).
  function downloadCsv(artefact) {
    try {
      if (!artefact || typeof artefact.csv !== "string") return false;
      if (typeof document === "undefined" || typeof Blob === "undefined") return false;
      var blob = new Blob([artefact.csv], { type: (artefact.mime || "text/csv") + ";charset=utf-8;" });
      var url = (window.URL || window.webkitURL).createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = artefact.filename || "bookings.csv";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { document.body.removeChild(a); (window.URL || window.webkitURL).revokeObjectURL(url); } catch (e) {}
      }, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- persistence (last export receipt) ---------------- */

  function recordExport(providerId, filter, artefact) {
    try {
      var state = HC.store.get(STORE_KEY, null) || { exports: [] };
      if (!Array.isArray(state.exports)) state.exports = [];
      state.exports.unshift({
        at: nowIso(),
        providerId: providerId,
        filter: filter,
        filename: artefact && artefact.filename,
        rowCount: artefact && artefact.rowCount
      });
      state.exports = state.exports.slice(0, 20);
      HC.store.set(STORE_KEY, state);
      return state;
    } catch (e) {
      return null;
    }
  }

  /* ---------------- render (UI) ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtDate(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || "");
      return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) + " " +
        d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return String(iso || ""); }
  }

  function statusPill(status) {
    var colour = {
      succeeded: "#2f7d4f", refunded: "#9a6a00", uncaptured: "#5a5a5a", failed: "#9a1f5e"
    }[status] || "#5a5a5a";
    var bg = {
      succeeded: "#E1F0E4", refunded: "#FBF0D8", uncaptured: "#ECECEC", failed: "#FCE8F0"
    }[status] || "#ECECEC";
    return '<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:' +
      bg + ";color:" + colour + '">' + esc(STATUS_LABEL[status] || status) + "</span>";
  }

  function render(mountEl) {
    if (!mountEl) return;
    var provider, allRows;
    try {
      provider = pickSeedProvider();
      // 28 sample bookings for the demo report.
      allRows = buildBookings(provider, 28, 4242);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Could not build the bookings report: ' + esc(e && e.message) + "</p>";
      return;
    }

    var state = { filter: "all", rows: allRows, provider: provider };

    function draw() {
      var counts = statusCounts(state.rows);
      var shown = filterByStatus(state.rows, state.filter);
      var sum = summarise(shown);

      var chips = FILTERS.map(function (f) {
        var active = state.filter === f;
        return '<button type="button" data-bk-filter="' + esc(f) + '" ' +
          'style="cursor:pointer;border:1.5px solid ' + (active ? "#603488" : "#E6E6E6") + ';' +
          "background:" + (active ? "#603488" : "#fff") + ";color:" + (active ? "#fff" : "#383838") + ";" +
          'font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12.5px;padding:6px 12px;border-radius:999px">' +
          esc(STATUS_LABEL[f] || f) + " · " + (counts[f] || 0) + "</button>";
      }).join(" ");

      var summaryCards =
        summaryCard("Bookings shown", String(sum.count)) +
        summaryCard("Gross taken", money(sum.gross)) +
        summaryCard("Refunds", money(sum.refunds)) +
        summaryCard("Stripe fees", money(sum.fees)) +
        summaryCard("Net payout", money(sum.net));

      var rowsHtml = shown.map(function (r) {
        return "<tr>" +
          '<td style="padding:7px 8px;white-space:nowrap;color:#808080;font-size:12px">' + esc(fmtDate(r.bookedAt)) + "</td>" +
          '<td style="padding:7px 8px">' + esc(r.week) + "</td>" +
          '<td style="padding:7px 8px">' + esc(r.ticket) + "</td>" +
          '<td style="padding:7px 8px">' + esc(r.customer) + "</td>" +
          '<td style="padding:7px 8px;text-transform:capitalize">' + esc(r.method) + "</td>" +
          '<td style="padding:7px 8px">' + statusPill(r.status) + "</td>" +
          '<td style="padding:7px 8px;text-align:right;white-space:nowrap">' + money(r.gross) + "</td>" +
          '<td style="padding:7px 8px;text-align:right;white-space:nowrap;color:#808080">' + money(r.fee) + "</td>" +
          '<td style="padding:7px 8px;text-align:right;white-space:nowrap;font-weight:700">' + money(r.net) + "</td>" +
        "</tr>";
      }).join("");
      if (!shown.length) {
        rowsHtml = '<tr><td colspan="9" style="padding:18px;text-align:center;color:#808080">No bookings for this filter.</td></tr>';
      }

      mountEl.innerHTML =
        '<p style="font-size:14px;color:#383838;margin:0 0 12px">' +
          "Bookings &amp; payments breakdown for <strong>" + esc(state.provider.name) + "</strong>. " +
          "Filter by Stripe payment status, then export the breakdown as a CSV / Stripe-style spreadsheet — " +
          "following the same marketplace pattern.</p>" +
        '<div style="display:flex;flex-wrap:wrap;gap:7px;margin:0 0 14px">' + chips + "</div>" +
        '<div style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px">' + summaryCards + "</div>" +
        '<div style="display:flex;gap:8px;margin:0 0 12px">' +
          '<button type="button" class="hc-btn" data-bk-export="csv">⬇ Export breakdown (CSV)</button>' +
          '<button type="button" class="hc-btn hc-btn-ghost" data-bk-export="preview">Preview export</button>' +
        "</div>" +
        '<div style="overflow-x:auto;border:1px solid #E6E6E6;border-radius:12px">' +
          '<table style="border-collapse:collapse;width:100%;font-size:13px;font-family:\'Nunito Sans\',system-ui,sans-serif">' +
            '<thead><tr style="background:#F7F4FA;text-align:left">' +
              th("Date") + th("Week") + th("Ticket") + th("Customer") + th("Method") + th("Status") +
              th("Amount", "right") + th("Fee", "right") + th("Net", "right") +
            "</tr></thead>" +
            "<tbody>" + rowsHtml + "</tbody>" +
          "</table>" +
        "</div>";

      // wire filter chips
      mountEl.querySelectorAll("[data-bk-filter]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          state.filter = btn.getAttribute("data-bk-filter");
          draw();
        });
      });
      // wire export buttons
      mountEl.querySelectorAll("[data-bk-export]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var mode = btn.getAttribute("data-bk-export");
          var rows = filterByStatus(state.rows, state.filter);
          var artefact = buildExport(rows, state.provider.id, state.filter);
          recordExport(state.provider.id, state.filter, artefact);
          if (mode === "preview") {
            showPreview(artefact);
          } else {
            var ok = downloadCsv(artefact);
            try { HC.util.toast(ok ? ("Exported " + artefact.rowCount + " bookings → " + artefact.filename) : "Export ready (" + artefact.rowCount + " rows)"); } catch (e) {}
          }
        });
      });
    }

    draw();
  }

  function th(label, align) {
    return '<th style="padding:9px 8px;font-family:Quicksand,system-ui,sans-serif;color:#603488;font-size:12px;' +
      "text-align:" + (align === "right" ? "right" : "left") + '">' + esc(label) + "</th>";
  }

  function summaryCard(label, value) {
    return '<div style="flex:1 1 120px;min-width:110px;border:1.5px solid #E6E6E6;border-radius:14px;padding:10px 12px;background:#fff">' +
      '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#808080;font-weight:700">' + esc(label) + "</div>" +
      '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:18px;color:#603488;margin-top:2px">' + esc(value) + "</div>" +
    "</div>";
  }

  function showPreview(artefact) {
    try {
      var preview = String(artefact.csv || "").split(/\r\n|\n/).slice(0, 9).join("\n");
      HC.util.modal(
        '<h2>⬇ Export preview</h2>' +
        '<p style="color:#808080;font-size:13px;margin:0 0 10px">' + esc(artefact.filename) +
          " · " + artefact.rowCount + " data rows (showing first 8)</p>" +
        '<pre style="background:#F7F4FA;border:1px solid #E6E6E6;border-radius:10px;padding:12px;overflow-x:auto;' +
          'font-size:11.5px;line-height:1.6;white-space:pre">' + esc(preview) + "</pre>"
      );
    } catch (e) { /* defensive */ }
  }

  /* ---------------- self-test (exercises the LOGIC) ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var seed = pickSeedProvider();
    var rows = buildBookings(seed, 40, 777); // deterministic dataset

    // 1. Dataset is well-formed and drawn from the live holiday-camp directory.
    check("Bookings dataset builds from a live holiday-camp provider", function () {
      HC.assert(Array.isArray(rows) && rows.length === 40, "expected 40 rows, got " + (rows && rows.length));
      HC.assert(seed && typeof seed.id === "string" && seed.id.length, "seed provider has an id");
      var ps = providers();
      if (ps.length) {
        HC.assert(ps.some(function (p) { return p && p.id === seed.id; }), "seed is a real directory provider");
      }
      // Every row carries the school-age camp framing fields.
      rows.forEach(function (r) {
        HC.assert(r.campName && r.week && r.ticket && r.customer, "row has camp/week/ticket/customer");
        HC.assert(STATUS_ORDER.indexOf(r.status) !== -1, "row has a valid Stripe status: " + r.status);
        HC.assert(r.method === METHOD.STRIPE || r.method === METHOD.MANUAL, "row method is stripe|manual");
      });
    });

    // 2. Stripe-style status filter (All / Succeeded / Refunded / Uncaptured / Failed) — evidence 8264831.
    check("Status filter splits rows into the Stripe statuses", function () {
      var counts = statusCounts(rows);
      HC.assert(counts.all === rows.length, "'all' count equals total rows");
      var sumParts = STATUS_ORDER.reduce(function (a, s) { return a + counts[s]; }, 0);
      HC.assert(sumParts === rows.length, "status counts partition every row (" + sumParts + " vs " + rows.length + ")");
      // Each filter returns only rows of that status.
      STATUS_ORDER.forEach(function (s) {
        var only = filterByStatus(rows, s);
        HC.assert(only.length === counts[s], "filter '" + s + "' returns " + counts[s] + " rows");
        HC.assert(only.every(function (r) { return r.status === s; }), "filter '" + s + "' returns only '" + s + "' rows");
      });
      HC.assert(filterByStatus(rows, "all").length === rows.length, "'all' filter returns every row");
    });

    // 3. The breakdown summary reconciles gross / refunds / fees / net.
    check("Summary reconciles gross, refunds, fees and net payout", function () {
      var s = summarise(rows);
      HC.assert(s.count === rows.length, "summary counts all rows");
      HC.assert(s.gross >= 0 && s.fees >= 0 && s.refunds >= 0, "totals are non-negative");
      // gross only counts succeeded + refunded rows.
      var manualGross = rows.filter(function (r) { return r.status === STATUS.SUCCEEDED || r.status === STATUS.REFUNDED; })
        .reduce(function (a, r) { return a + r.gross; }, 0);
      HC.assert(Math.abs(s.gross - round2(manualGross)) < 0.01, "gross matches succeeded+refunded amounts");
      // net is the sum of per-row net.
      var manualNet = rows.reduce(function (a, r) { return a + r.net; }, 0);
      HC.assert(Math.abs(s.net - round2(manualNet)) < 0.01, "net is the sum of row nets");
      // stripe + manual counts partition the rows.
      HC.assert(s.stripeCount + s.manualCount === rows.length, "every row is stripe or manual");
    });

    // 4. Stripe fee maths: 1.5% + 20p, and manual takings carry no Stripe fee.
    check("Stripe fee is 1.5% + 20p; manual takings have no fee", function () {
      var f10 = stripeFee(10);
      HC.assert(Math.abs(f10.fee - 0.35) < 0.001, "£10 fee is 35p, got " + f10.fee);
      HC.assert(Math.abs(f10.net - 9.65) < 0.001, "£10 net is £9.65, got " + f10.net);
      HC.assert(stripeFee(0).fee === 0 && stripeFee("x").fee === 0 && stripeFee(-4).fee === 0, "junk -> zero fee, no throw");
      // every manual row has zero Stripe fee.
      rows.filter(function (r) { return r.method === METHOD.MANUAL; }).forEach(function (r) {
        HC.assert(r.fee === 0, "manual booking carries no Stripe fee");
      });
      // every succeeded Stripe row keeps net = gross - fee.
      rows.filter(function (r) { return r.method === METHOD.STRIPE && r.status === STATUS.SUCCEEDED; }).forEach(function (r) {
        HC.assert(Math.abs(r.net - round2(r.gross - r.fee)) < 0.01, "succeeded stripe net = gross - fee");
      });
    });

    // 5. ACCEPTANCE CRITERION — provider can VIEW and EXPORT the report (CSV / Stripe export).
    check("ACCEPTANCE: export produces a valid CSV breakdown of bookings & payments", function () {
      var artefact = buildExport(rows, seed.id, "all");
      HC.assert(artefact && typeof artefact.csv === "string" && artefact.csv.length > 0, "export yields a non-empty CSV");
      HC.assert(artefact.mime === "text/csv", "export mime is text/csv");
      HC.assert(/\.csv$/.test(artefact.filename), "export filename ends in .csv: " + artefact.filename);
      var lines = artefact.csv.split(/\r\n/);
      HC.assert(lines.length === rows.length + 1, "CSV has header + one line per booking (" + lines.length + " vs " + (rows.length + 1) + ")");
      HC.assert(artefact.rowCount === rows.length, "rowCount excludes the header (" + artefact.rowCount + ")");
      // Header carries the Happity-style columns (revenue, ticket/spend, how booked, date) — evidence 5342227.
      var header = lines[0];
      ["Payment Status", "Payment Method", "Amount", "Stripe Fee", "Net", "Ticket Type", "Booking Date & Time"]
        .forEach(function (col) {
          HC.assert(header.indexOf(col) !== -1, "CSV header includes '" + col + "'");
        });
      // A data line round-trips the first booking's key fields.
      HC.assert(lines[1].indexOf(rows[0].customer) !== -1, "first data row contains the customer name");
    });

    // 6. Filtered export only contains rows of the chosen status (export of the breakdown).
    check("ACCEPTANCE: a filtered export exports only that status's bookings", function () {
      var succeeded = filterByStatus(rows, STATUS.SUCCEEDED);
      var artefact = buildExport(succeeded, seed.id, STATUS.SUCCEEDED);
      HC.assert(artefact.rowCount === succeeded.length, "succeeded export row count matches filter");
      HC.assert(/-succeeded-/.test(artefact.filename), "filename is scoped to the status filter: " + artefact.filename);
      // No 'failed' or 'refunded' status string should leak into a succeeded-only export body.
      var body = artefact.csv.split(/\r\n/).slice(1).join("\n");
      HC.assert(body.indexOf("failed") === -1 || succeeded.length === 0, "no failed rows in succeeded export");
      // An empty filter still exports a valid (header-only) CSV.
      var emptyArtefact = buildExport([], seed.id, STATUS.FAILED);
      HC.assert(emptyArtefact.rowCount === 0 && /Booking ID/.test(emptyArtefact.csv), "empty export is still a valid header-only CSV");
    });

    // 7. CSV escaping is safe against commas/quotes in customer names.
    check("CSV escaping quotes fields with commas/quotes", function () {
      var tricky = [{
        id: "bk_x", bookedAt: "2026-06-01T09:00:00.000Z", campName: 'Camp "Fun", Ltd',
        week: "Wk1", ticket: "Full day", customer: "Smith, John", childName: "Ava",
        method: METHOD.STRIPE, status: STATUS.SUCCEEDED, gross: 35, fee: 0.73, refunded: 0, net: 34.27
      }];
      var csv = toCsv(tricky);
      HC.assert(csv.indexOf('"Smith, John"') !== -1, "comma name is quoted");
      HC.assert(csv.indexOf('"Camp ""Fun"", Ltd"') !== -1, "embedded quotes are doubled");
      // Parse-count: the data row must still have the right number of columns once split safely.
      var dataLine = csv.split(/\r\n/)[1];
      HC.assert(dataLine.indexOf("35.00") !== -1 && dataLine.indexOf("34.27") !== -1, "money formatted to 2dp");
    });

    // 8. Determinism — the same seed rebuilds an identical export (reproducible reconciliation).
    check("Report is deterministic for a given seed", function () {
      var a = buildExport(buildBookings(seed, 12, 99), seed.id, "all");
      var b = buildExport(buildBookings(seed, 12, 99), seed.id, "all");
      // Booking ids embed a random suffix, so compare the stable status/amount columns instead.
      function statusCol(csv) {
        return csv.split(/\r\n/).slice(1).map(function (l) {
          var parts = l.split(",");
          return parts.slice(7).join(","); // method/status/amount/... stable region
        }).join("|");
      }
      HC.assert(statusCol(a.csv) === statusCol(b.csv), "same seed -> same statuses & amounts");
    });

    // 9. Export receipts persist via HC.store (namespaced, not raw localStorage).
    check("Export receipts persist via HC.store", function () {
      // Clean slate for this key.
      try { HC.store.set(STORE_KEY, { exports: [] }); } catch (e) {}
      var artefact = buildExport(rows, seed.id, "all");
      var state = recordExport(seed.id, "all", artefact);
      HC.assert(state && Array.isArray(state.exports) && state.exports.length >= 1, "an export receipt is recorded");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.exports[0] && got.exports[0].filename === artefact.filename, "receipt round-trips through the store");
      HC.assert(got.exports[0].rowCount === rows.length, "receipt records the exported row count");
      // tidy up
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // 10. Defensive — junk inputs never throw and degrade sanely.
    check("Defensive against junk inputs", function () {
      HC.assert(filterByStatus(null, "all").length === 0, "null rows -> empty filter, no throw");
      HC.assert(filterByStatus(undefined, "succeeded").length === 0, "undefined rows -> empty, no throw");
      var s = summarise(null);
      HC.assert(s.count === 0 && s.gross === 0 && s.net === 0, "summary of null is all-zero");
      var empty = buildExport(null, undefined, undefined);
      HC.assert(/Booking ID/.test(empty.csv) && empty.rowCount === 0, "export of null -> header-only CSV");
      HC.assert(statusCounts(null).all === 0, "statusCounts(null).all === 0");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-bookings-breakdown",
    title: "Bookings & payments breakdown + export",
    side: "provider",
    icon: "📊",
    summary: "Just like Happity: view a breakdown of your camp bookings & payments, filter by Stripe status " +
      "(All / Succeeded / Refunded / Uncaptured / Failed), reconcile gross, refunds, fees and net payout, then " +
      "export the breakdown as a CSV / Stripe-style spreadsheet.",
    render: render,
    selfTest: selfTest
  });
})();
