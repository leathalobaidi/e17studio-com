/* HolidayCamp feature — provider-customers-crm
 *
 * Customers list / CRM with marketing opt-in  (provider side)
 *
 * Replicates the Happity "Customers" tab + GDPR marketing-preferences view.
 * Evidence:
 *   - support article 5342227 ("How can I access my sales, marketing &
 *     customer data on Happity?") — "Customer reports … All your customer data
 *     in one place": the provider has a Customers tab that aggregates every
 *     person who has booked, with booking history, and a CSV download of the
 *     email list "ready for importing into your chosen email marketing tool".
 *   - support article 5972958 ("Can I see my customer's marketing
 *     preferences?") — "Click 'Customers' … and then 'Bookings'. From here you
 *     will be able to see a list of customers who have booked classes with you
 *     … On the last column you will see who has opted-in to marketing. This is
 *     a GDPR compliant marketing opt in. Those who have selected Yes can be
 *     contacted about marketing, though if they have selected no it is
 *     important to only contact them about the classes they have booked on to."
 *   - support article 4147919 ("How to build your customer email marketing
 *     list") — the opt-in box appears on the booking form, BUT "You must upload
 *     a Privacy Policy to your account for the opt-in to be displayed"; and the
 *     same customer booking multiple classes produces duplicate email rows that
 *     must be de-duplicated before mailing.
 *
 * Net behaviour (the acceptance criterion): a CUSTOMERS view lists every booked
 * customer, one row per customer, and a LAST COLUMN shows the GDPR marketing
 * opt-in (Yes / No). Only opted-in customers may be exported to a marketing
 * email list; everyone else can only be contacted about the class they booked.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). Bookings are made by
 * a PARENT (the customer / account holder) for one or more CHILDREN across the
 * Summer-2026 Waltham Forest camp weeks. The CRM rolls a parent's many bookings
 * up into a single customer row: total bookings, children booked, lifetime
 * spend, last-booked date, and their marketing consent. The provider can:
 *   - filter to opted-in customers,
 *   - search by name / email,
 *   - export a de-duplicated marketing CSV (opted-in only),
 *   - open a customer to see their full booking history.
 * The opt-in column only carries real consent values once a Privacy Policy is
 * on file (per article 4147919) — otherwise it shows "—" (not displayed).
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A Customers view lists booked customers with a GDPR marketing-opt-in
 *   column. We verify: the list has exactly one row per distinct booked
 *   customer (multi-booking parents are rolled up, not duplicated); every row
 *   exposes a marketing-opt-in value; the marketing export contains ONLY
 *   opted-in customers and is de-duplicated by email; opted-out customers are
 *   excluded from the export; and with no Privacy Policy on file the opt-in
 *   column is suppressed (shown as not-displayed) per Happity's rule.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-customers-crm: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Own store key — the CRM keeps its own bookings ledger so its logic + tests
  // are fully self-contained and never depend on any other feature having run.
  // Shape: {
  //   privacyPolicyUploaded: Boolean,
  //   bookings: [ { id, parentName, email, phone, childName, childAge,
  //                 campId, campName, weekLabel, date, amount,
  //                 marketingOptIn:Boolean, bookedAt } ]
  // }
  var STORE_KEY = "provider_customers_crm";

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  function normEmail(v) {
    return asText(v).trim().toLowerCase();
  }

  function isEmail(v) {
    var s = normEmail(v);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  function toNumber(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  // Normalise a raw booking into a defensive, fully-shaped record.
  function normaliseBooking(raw) {
    var b = (raw && typeof raw === "object") ? raw : {};
    return {
      id: asText(b.id) || safeUid("bk"),
      parentName: asText(b.parentName).trim() || "Unknown parent",
      email: normEmail(b.email),
      phone: asText(b.phone).trim(),
      childName: asText(b.childName).trim(),
      childAge: (b.childAge === 0 || b.childAge) ? toNumber(b.childAge) : null,
      campId: asText(b.campId).trim(),
      campName: asText(b.campName).trim() || "Holiday camp",
      weekLabel: asText(b.weekLabel).trim(),
      date: asText(b.date).trim(),
      amount: toNumber(b.amount),
      // tri-state consent: true / false / null(unknown). Coerce common shapes.
      marketingOptIn: coerceConsent(b.marketingOptIn),
      bookedAt: asText(b.bookedAt).trim() || asText(b.date).trim()
    };
  }

  // Consent can arrive as boolean, "yes"/"no", "true"/"false", 1/0, or missing.
  function coerceConsent(v) {
    if (v === true) return true;
    if (v === false) return false;
    if (v === 1) return true;
    if (v === 0) return false;
    var s = asText(v).trim().toLowerCase();
    if (s === "yes" || s === "true" || s === "y" || s === "opted-in" || s === "opt-in") return true;
    if (s === "no" || s === "false" || s === "n" || s === "opted-out" || s === "opt-out") return false;
    return null; // unknown
  }

  // Identity for rolling up a parent's many bookings into ONE customer.
  // Email is the canonical key (it's what mailing tools key on); fall back to
  // a normalised name when a booking has no email.
  function customerKey(b) {
    var e = normEmail(b.email);
    if (e) return "e:" + e;
    return "n:" + asText(b.parentName).trim().toLowerCase();
  }

  // The marketing opt-in as DISPLAYED in the Customers grid's last column.
  // Per article 4147919 the opt-in is only shown if a Privacy Policy is on
  // file; otherwise it is suppressed. Returns one of:
  //   "Yes" | "No" | "—" (unknown but policy present) | "not-displayed"
  function optInDisplay(consent, privacyPolicyUploaded) {
    if (!privacyPolicyUploaded) return "not-displayed";
    if (consent === true) return "Yes";
    if (consent === false) return "No";
    return "—";
  }

  // Roll the booking ledger up into one CUSTOMER row each. The last column is
  // the GDPR marketing opt-in. A customer counts as opted-in if ANY of their
  // bookings carries an explicit opt-in (a parent only consents once, but
  // bookings can be entered at different times — most-recent consent wins, and
  // an explicit value always beats "unknown").
  function buildCustomers(bookings, privacyPolicyUploaded) {
    var list = Array.isArray(bookings) ? bookings : [];
    var byKey = {};
    var order = [];

    for (var i = 0; i < list.length; i++) {
      var b = normaliseBooking(list[i]);
      var key = customerKey(b);
      if (!byKey[key]) {
        byKey[key] = {
          key: key,
          parentName: b.parentName,
          email: b.email,
          phone: b.phone,
          bookingCount: 0,
          children: [],          // distinct child names
          totalSpend: 0,
          firstBooked: b.bookedAt,
          lastBooked: b.bookedAt,
          _consent: null,        // resolved below
          _consentStamp: ""      // bookedAt of the booking that set _consent
        };
        order.push(key);
      }
      var c = byKey[key];
      c.bookingCount += 1;
      c.totalSpend += b.amount;
      if (b.childName && c.children.indexOf(b.childName) === -1) c.children.push(b.childName);
      if (b.phone && !c.phone) c.phone = b.phone;
      if (b.email && !c.email) c.email = b.email;
      if (b.bookedAt && b.bookedAt < c.firstBooked) c.firstBooked = b.bookedAt;
      if (b.bookedAt && b.bookedAt > c.lastBooked) c.lastBooked = b.bookedAt;

      // Resolve consent: explicit beats unknown; among explicit, latest wins.
      if (b.marketingOptIn !== null) {
        var stamp = b.bookedAt || "";
        if (c._consent === null || stamp >= c._consentStamp) {
          c._consent = b.marketingOptIn;
          c._consentStamp = stamp;
        }
      }
    }

    return order.map(function (k) {
      var c = byKey[k];
      var consent = c._consent; // true | false | null
      return {
        key: c.key,
        parentName: c.parentName,
        email: c.email,
        phone: c.phone,
        bookingCount: c.bookingCount,
        childCount: c.children.length,
        children: c.children.slice(),
        totalSpend: c.totalSpend,
        firstBooked: c.firstBooked,
        lastBooked: c.lastBooked,
        marketingOptIn: consent,                                  // tri-state
        optInLabel: optInDisplay(consent, privacyPolicyUploaded)  // last column
      };
    });
  }

  // Filter + search the customer list for the grid.
  // opts = { query:String, optedInOnly:Boolean }
  function filterCustomers(customers, opts) {
    var o = opts || {};
    var q = asText(o.query).trim().toLowerCase();
    var list = Array.isArray(customers) ? customers : [];
    return list.filter(function (c) {
      if (o.optedInOnly && c.marketingOptIn !== true) return false;
      if (!q) return true;
      var hay = (asText(c.parentName) + " " + asText(c.email) + " " +
        (c.children || []).join(" ")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  // Build the de-duplicated MARKETING email list. Per articles 5972958 + 4147919:
  //   - ONLY customers who selected Yes may be exported for marketing;
  //   - the list is de-duplicated by email (one parent booking many classes
  //     must not appear twice);
  //   - if no Privacy Policy is on file the opt-in is not collected, so the
  //     marketing list is empty.
  function buildMarketingList(customers, privacyPolicyUploaded) {
    if (!privacyPolicyUploaded) return [];
    var seen = {};
    var out = [];
    var list = Array.isArray(customers) ? customers : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.marketingOptIn !== true) continue;       // opted-out / unknown excluded
      var e = normEmail(c.email);
      if (!isEmail(e)) continue;                     // need a valid address
      if (seen[e]) continue;                         // de-dupe
      seen[e] = true;
      out.push({ name: c.parentName, email: e });
    }
    return out;
  }

  // Serialise the Customers grid to CSV (last column = Marketing opt-in).
  function customersToCsv(customers, privacyPolicyUploaded) {
    var rows = [];
    var header = ["Customer", "Email", "Phone", "Bookings", "Children", "Total spend", "Last booked", "Marketing opt-in"];
    rows.push(header.map(csvCell).join(","));
    var list = Array.isArray(customers) ? customers : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      rows.push([
        c.parentName,
        c.email,
        c.phone,
        c.bookingCount,
        c.childCount,
        money(c.totalSpend),
        c.lastBooked,
        optInDisplay(c.marketingOptIn, privacyPolicyUploaded)
      ].map(csvCell).join(","));
    }
    return rows.join("\r\n");
  }

  function csvCell(v) {
    var s = asText(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function money(n) {
    try { return HC.util.money(n); }
    catch (e) { return "£" + (Math.round(toNumber(n) * 100) / 100); }
  }

  /* ===================================================================
     SEED DATA — realistic school-age camp bookings, derived from live
     directory + planner data so the demo grid is grounded.
     =================================================================== */

  function liveCamps() {
    var ps = [];
    try { ps = HC.data.providers || []; } catch (e) { ps = []; }
    return ps;
  }

  function pickCampName(idx, fallback) {
    var ps = liveCamps();
    if (ps.length) {
      var p = ps[idx % ps.length];
      return { id: asText(p.id), name: asText(p.name) || fallback };
    }
    return { id: "", name: fallback };
  }

  function seedBookings() {
    // Two parents book multiple classes (to prove roll-up + de-dup), spanning
    // the live Summer-2026 weeks. Mix of opted-in, opted-out and unknown.
    var c0 = pickCampName(1, "Multi-Sports Camp");
    var c1 = pickCampName(2, "Forest Adventure Camp");
    var c2 = pickCampName(3, "Drama & Dance Week");
    var c3 = pickCampName(4, "Coding Club Camp");

    return [
      // Priya books TWO weeks for one child + a friend's child — same email.
      mk("Priya Shah", "priya.shah@example.com", "07700 900111", "Anaya", 7, c0, "Week 1 · Mon 20 Jul", "2026-07-20", 145, true, "2026-06-10"),
      mk("Priya Shah", "priya.shah@example.com", "07700 900111", "Anaya", 7, c1, "Week 3 · Mon 3 Aug", "2026-08-03", 160, true, "2026-06-11"),

      // Tom books for two children across one week — opted OUT.
      mk("Tom Bennett", "tom.bennett@example.com", "07700 900222", "Jack", 9, c0, "Week 2 · Mon 27 Jul", "2026-07-27", 150, false, "2026-06-09"),
      mk("Tom Bennett", "tom.bennett@example.com", "07700 900222", "Mia", 6, c0, "Week 2 · Mon 27 Jul", "2026-07-27", 150, false, "2026-06-09"),

      // Single opted-in bookings.
      mk("Sarah Okafor", "sarah.okafor@example.com", "07700 900333", "Kofi", 10, c2, "Week 4 · Mon 10 Aug", "2026-08-10", 120, true, "2026-06-12"),
      mk("Leila Ahmadi", "leila.ahmadi@example.com", "07700 900444", "Sami", 8, c3, "Week 5 · Mon 17 Aug", "2026-08-17", 175, true, "2026-06-13"),

      // Unknown consent (booked before policy / blank) — should show "—".
      mk("Daniel Cole", "daniel.cole@example.com", "07700 900555", "Evie", 5, c1, "Week 6 · Mon 24 Aug", "2026-08-24", 160, null, "2026-06-08")
    ];
  }

  function mk(parentName, email, phone, childName, childAge, camp, weekLabel, date, amount, optIn, bookedAt) {
    return {
      id: safeUid("bk"),
      parentName: parentName,
      email: email,
      phone: phone,
      childName: childName,
      childAge: childAge,
      campId: camp.id,
      campName: camp.name,
      weekLabel: weekLabel,
      date: date,
      amount: amount,
      marketingOptIn: optIn,
      bookedAt: bookedAt
    };
  }

  /* ===================================================================
     STATE (mock persistence via HC.store)
     =================================================================== */

  function loadState() {
    var s = null;
    try { s = HC.store.get(STORE_KEY, null); } catch (e) { s = null; }
    if (!s || typeof s !== "object" || !Array.isArray(s.bookings)) {
      s = { privacyPolicyUploaded: true, bookings: seedBookings() };
      saveState(s);
    }
    if (typeof s.privacyPolicyUploaded !== "boolean") s.privacyPolicyUploaded = true;
    return s;
  }

  function saveState(s) {
    try { HC.store.set(STORE_KEY, s); } catch (e) { /* defensive */ }
    return s;
  }

  /* ===================================================================
     RENDER (DOM)
     =================================================================== */

  function escapeHtml(str) {
    return asText(str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function optInBadge(label) {
    var bg = "#EFEFEF", fg = "#808080", txt = label;
    if (label === "Yes") { bg = "#E3F4EA"; fg = "#2f7d4f"; }
    else if (label === "No") { bg = "#FBE4EF"; fg = "#9a1f5e"; }
    else if (label === "not-displayed") { bg = "#FFF4D6"; fg = "#8a6d00"; txt = "Not shown"; }
    return '<span style="display:inline-block;font-weight:700;font-size:11.5px;padding:2px 9px;border-radius:999px;background:' +
      bg + ';color:' + fg + '">' + escapeHtml(txt) + "</span>";
  }

  function render(mountEl) {
    try {
      var state = loadState();

      function paint() {
        var customers = buildCustomers(state.bookings, state.privacyPolicyUploaded);
        var query = asText(mountEl.__hcQuery || "");
        var optedInOnly = !!mountEl.__hcOptedInOnly;
        var shown = filterCustomers(customers, { query: query, optedInOnly: optedInOnly });
        var marketingList = buildMarketingList(customers, state.privacyPolicyUploaded);

        var optedInCount = customers.filter(function (c) { return c.marketingOptIn === true; }).length;
        var optedOutCount = customers.filter(function (c) { return c.marketingOptIn === false; }).length;

        var rows = shown.map(function (c) {
          var kids = c.children.length ? c.children.join(", ") : "—";
          return '<tr data-key="' + escapeHtml(c.key) + '" style="border-top:1px solid var(--line,#E6E6E6)">' +
            '<td style="padding:9px 10px"><strong>' + escapeHtml(c.parentName) + "</strong><br>" +
              '<span style="color:var(--muted,#808080);font-size:12px">' + escapeHtml(c.email || "no email on file") + "</span></td>" +
            '<td style="padding:9px 10px;text-align:center">' + c.bookingCount + "</td>" +
            '<td style="padding:9px 10px;font-size:12.5px">' + escapeHtml(kids) + "</td>" +
            '<td style="padding:9px 10px;text-align:right;white-space:nowrap">' + escapeHtml(money(c.totalSpend)) + "</td>" +
            '<td style="padding:9px 10px;font-size:12.5px;white-space:nowrap">' + escapeHtml(c.lastBooked || "—") + "</td>" +
            // LAST COLUMN — the GDPR marketing opt-in (acceptance criterion)
            '<td style="padding:9px 10px;text-align:center">' + optInBadge(c.optInLabel) + "</td>" +
            "</tr>";
        }).join("");

        if (!shown.length) {
          rows = '<tr><td colspan="6" style="padding:18px;text-align:center;color:var(--muted,#808080)">No customers match your filter.</td></tr>';
        }

        var policyBanner = state.privacyPolicyUploaded ? "" :
          '<div style="background:#FFF4D6;border:1px solid #F0D480;border-radius:12px;padding:11px 14px;margin:0 0 14px;font-size:13px;color:#5c4a00">' +
            "⚠️ No Privacy Policy on file — the marketing opt-in box isn't shown to customers at booking, so the opt-in column is suppressed and the marketing export is empty. Upload a Privacy Policy to collect consent." +
          "</div>";

        mountEl.innerHTML =
          '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 12px">Every parent who has booked a camp, rolled up into one row. ' +
            "The last column is their <strong>GDPR marketing opt-in</strong>: only customers who said <em>Yes</em> may be emailed marketing — everyone else can only be contacted about the class they booked.</p>" +
          policyBanner +
          '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 12px">' +
            '<input id="hcCrmSearch" type="search" placeholder="Search name, email or child…" value="' + escapeHtml(query) + '" ' +
              'style="flex:1;min-width:180px;padding:9px 12px;border:1.5px solid var(--line,#E6E6E6);border-radius:999px;font-size:14px">' +
            '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text,#383838);cursor:pointer">' +
              '<input id="hcCrmOptedOnly" type="checkbox"' + (optedInOnly ? " checked" : "") + "> Opted-in only</label>" +
          "</div>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px;font-size:12.5px">' +
            statPill("Customers", customers.length, "#603488") +
            statPill("Opted in", optedInCount, "#2f7d4f") +
            statPill("Opted out", optedOutCount, "#9a1f5e") +
            statPill("Marketing list", marketingList.length, "#F82488") +
          "</div>" +
          '<div style="overflow-x:auto;border:1.5px solid var(--line,#E6E6E6);border-radius:14px">' +
            '<table style="width:100%;border-collapse:collapse;font-size:13.5px;min-width:560px">' +
              '<thead><tr style="background:var(--purple-tint,#F0E8F4);text-align:left">' +
                '<th style="padding:10px;font-family:Quicksand,system-ui,sans-serif">Customer</th>' +
                '<th style="padding:10px;text-align:center;font-family:Quicksand,system-ui,sans-serif">Bookings</th>' +
                '<th style="padding:10px;font-family:Quicksand,system-ui,sans-serif">Children</th>' +
                '<th style="padding:10px;text-align:right;font-family:Quicksand,system-ui,sans-serif">Spend</th>' +
                '<th style="padding:10px;font-family:Quicksand,system-ui,sans-serif">Last booked</th>' +
                '<th style="padding:10px;text-align:center;font-family:Quicksand,system-ui,sans-serif">Marketing opt-in</th>' +
              "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">' +
            '<button class="hc-btn" id="hcCrmExport">⬇ Export marketing CSV (' + marketingList.length + ")</button>" +
            '<button class="hc-btn hc-btn-ghost" id="hcCrmAllCsv">Export all customers CSV</button>' +
            '<button class="hc-btn hc-btn-ghost" id="hcCrmTogglePolicy">' +
              (state.privacyPolicyUploaded ? "Simulate: remove Privacy Policy" : "Simulate: upload Privacy Policy") + "</button>" +
          "</div>" +
          '<p style="font-size:11.5px;color:var(--muted,#808080);margin-top:10px">The marketing CSV is de-duplicated by email and contains opted-in customers only — ready to import into a tool like Mailerlite. Click any row to view that customer\'s booking history.</p>';

        // wire controls
        var search = mountEl.querySelector("#hcCrmSearch");
        if (search) search.addEventListener("input", function () {
          mountEl.__hcQuery = search.value;
          var pos = search.selectionStart;
          paint();
          var ns = mountEl.querySelector("#hcCrmSearch");
          if (ns) { ns.focus(); try { ns.setSelectionRange(pos, pos); } catch (e) {} }
        });
        var optedOnly = mountEl.querySelector("#hcCrmOptedOnly");
        if (optedOnly) optedOnly.addEventListener("change", function () {
          mountEl.__hcOptedInOnly = optedOnly.checked; paint();
        });
        var exportBtn = mountEl.querySelector("#hcCrmExport");
        if (exportBtn) exportBtn.addEventListener("click", function () {
          var list = buildMarketingList(customers, state.privacyPolicyUploaded);
          if (!list.length) { toast("No opted-in customers to export."); return; }
          downloadCsv("marketing-list.csv",
            "Name,Email\r\n" + list.map(function (r) { return csvCell(r.name) + "," + csvCell(r.email); }).join("\r\n"));
          toast("Exported " + list.length + " opted-in customer" + (list.length === 1 ? "" : "s") + ".");
        });
        var allCsvBtn = mountEl.querySelector("#hcCrmAllCsv");
        if (allCsvBtn) allCsvBtn.addEventListener("click", function () {
          downloadCsv("customers.csv", customersToCsv(customers, state.privacyPolicyUploaded));
          toast("Exported " + customers.length + " customers.");
        });
        var policyBtn = mountEl.querySelector("#hcCrmTogglePolicy");
        if (policyBtn) policyBtn.addEventListener("click", function () {
          state.privacyPolicyUploaded = !state.privacyPolicyUploaded;
          saveState(state);
          toast(state.privacyPolicyUploaded ? "Privacy Policy uploaded — opt-in now collected." : "Privacy Policy removed — opt-in suppressed.");
          paint();
        });
        // open a customer's booking history
        var tbody = mountEl.querySelector("tbody");
        if (tbody) tbody.addEventListener("click", function (e) {
          var tr = e.target.closest("tr[data-key]");
          if (!tr) return;
          openCustomer(tr.getAttribute("data-key"));
        });
      }

      function openCustomer(key) {
        try {
          var mine = (state.bookings || []).map(normaliseBooking).filter(function (b) {
            return customerKey(b) === key;
          });
          if (!mine.length) return;
          var name = mine[0].parentName;
          var historyRows = mine
            .slice()
            .sort(function (a, b) { return asText(a.date) < asText(b.date) ? -1 : 1; })
            .map(function (b) {
              return '<tr style="border-top:1px solid var(--line,#E6E6E6)">' +
                '<td style="padding:7px 9px">' + escapeHtml(b.campName) + "</td>" +
                '<td style="padding:7px 9px">' + escapeHtml(b.weekLabel || b.date) + "</td>" +
                '<td style="padding:7px 9px">' + escapeHtml(b.childName || "—") +
                  (b.childAge != null ? ' <span style="color:var(--muted,#808080)">(age ' + b.childAge + ")</span>" : "") + "</td>" +
                '<td style="padding:7px 9px;text-align:right">' + escapeHtml(money(b.amount)) + "</td>" +
                "</tr>";
            }).join("");
          var consent = buildCustomers(mine, state.privacyPolicyUploaded)[0];
          HC.util.modal(
            "<h2>" + escapeHtml(name) + "</h2>" +
            '<p style="color:var(--muted,#808080);margin:0 0 4px">' + escapeHtml(mine[0].email || "no email on file") +
              (mine[0].phone ? " · " + escapeHtml(mine[0].phone) : "") + "</p>" +
            '<p style="margin:0 0 14px">Marketing opt-in: ' + optInBadge(consent ? consent.optInLabel : "—") + "</p>" +
            '<h3 style="font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);font-size:15px;margin:0 0 6px">Booking history</h3>' +
            '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
              '<thead><tr style="text-align:left;color:var(--muted,#808080)">' +
                '<th style="padding:6px 9px">Camp</th><th style="padding:6px 9px">When</th>' +
                '<th style="padding:6px 9px">Child</th><th style="padding:6px 9px;text-align:right">Paid</th>' +
              "</tr></thead><tbody>" + historyRows + "</tbody></table>"
          );
        } catch (e) { /* defensive */ }
      }

      paint();
    } catch (err) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Customers CRM failed to load: ' +
        escapeHtml(err && err.message ? err.message : String(err)) + "</p>";
    }
  }

  function statPill(label, n, color) {
    return '<span style="display:inline-flex;align-items:center;gap:5px;background:#fff;border:1.5px solid var(--line,#E6E6E6);' +
      'border-radius:999px;padding:4px 11px"><strong style="color:' + color + '">' + escapeHtml(n) + "</strong> " +
      '<span style="color:var(--muted,#808080)">' + escapeHtml(label) + "</span></span>";
  }

  function toast(msg) { try { HC.util.toast(msg); } catch (e) {} }

  function downloadCsv(filename, csv) {
    try {
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    } catch (e) { /* defensive: download is best-effort in the mock */ }
  }

  /* ===================================================================
     SELF TEST — exercises the CRM LOGIC and asserts the acceptance
     criterion: a Customers view lists booked customers with a GDPR
     marketing-opt-in column.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A fixed ledger: 3 distinct parents.
    //  - Priya: 2 bookings, opted IN.
    //  - Tom:   2 bookings (2 children), opted OUT.
    //  - Sarah: 1 booking,  opted IN.
    //  - Noor:  1 booking,  consent UNKNOWN (null).
    var ledger = [
      bk("Priya Shah", "priya@example.com", "Anaya", 7, 145, true, "2026-06-10"),
      bk("Priya Shah", "priya@example.com", "Anaya", 7, 160, true, "2026-06-11"),
      bk("Tom Bennett", "tom@example.com", "Jack", 9, 150, false, "2026-06-09"),
      bk("Tom Bennett", "tom@example.com", "Mia", 6, 150, false, "2026-06-09"),
      bk("Sarah Okafor", "sarah@example.com", "Kofi", 10, 120, true, "2026-06-12"),
      bk("Noor Aziz", "noor@example.com", "Layla", 8, 130, null, "2026-06-08")
    ];

    function bk(parentName, email, childName, age, amount, optIn, bookedAt) {
      return {
        parentName: parentName, email: email, childName: childName, childAge: age,
        campName: "Multi-Sports Camp", weekLabel: "Week 1", date: "2026-07-20",
        amount: amount, marketingOptIn: optIn, bookedAt: bookedAt
      };
    }

    // --- ACCEPTANCE CRITERION: a Customers view lists booked customers with a
    //     GDPR marketing-opt-in column. ---
    var customers = buildCustomers(ledger, /*privacyPolicyUploaded*/ true);

    check("Customers view lists booked customers (non-empty)", function () {
      HC.assert(Array.isArray(customers) && customers.length > 0, "expected a non-empty customer list");
    });

    check("One row per DISTINCT customer (4 parents from 6 bookings)", function () {
      HC.assert(customers.length === 4, "expected 4 customers, got " + customers.length);
    });

    check("Multi-booking parent is rolled up, not duplicated", function () {
      var priya = customers.filter(function (c) { return c.parentName === "Priya Shah"; });
      HC.assert(priya.length === 1, "Priya should appear exactly once, got " + priya.length);
      HC.assert(priya[0].bookingCount === 2, "Priya should have 2 bookings, got " + priya[0].bookingCount);
    });

    check("EVERY row exposes a marketing-opt-in column value", function () {
      customers.forEach(function (c) {
        HC.assert(Object.prototype.hasOwnProperty.call(c, "marketingOptIn"), c.parentName + " missing marketingOptIn");
        HC.assert(typeof c.optInLabel === "string" && c.optInLabel.length > 0, c.parentName + " missing opt-in label");
        HC.assert(c.optInLabel === "Yes" || c.optInLabel === "No" || c.optInLabel === "—",
          c.parentName + " opt-in label should be Yes/No/— with policy on file, got " + c.optInLabel);
      });
    });

    check("Opted-in customers show 'Yes' in the last column", function () {
      var priya = customers.filter(function (c) { return c.parentName === "Priya Shah"; })[0];
      var sarah = customers.filter(function (c) { return c.parentName === "Sarah Okafor"; })[0];
      HC.assert(priya.optInLabel === "Yes" && priya.marketingOptIn === true, "Priya should be Yes");
      HC.assert(sarah.optInLabel === "Yes" && sarah.marketingOptIn === true, "Sarah should be Yes");
    });

    check("Opted-out customer shows 'No' in the last column", function () {
      var tom = customers.filter(function (c) { return c.parentName === "Tom Bennett"; })[0];
      HC.assert(tom.optInLabel === "No" && tom.marketingOptIn === false, "Tom should be No");
    });

    check("Unknown-consent customer shows '—' (with policy on file)", function () {
      var noor = customers.filter(function (c) { return c.parentName === "Noor Aziz"; })[0];
      HC.assert(noor.optInLabel === "—" && noor.marketingOptIn === null, "Noor should be unknown/—");
    });

    // --- Marketing export: opted-in ONLY, de-duplicated by email. ---
    var marketing = buildMarketingList(customers, true);

    check("Marketing list contains ONLY opted-in customers", function () {
      HC.assert(marketing.length === 2, "expected 2 opted-in (Priya, Sarah), got " + marketing.length);
      var emails = marketing.map(function (r) { return r.email; });
      HC.assert(emails.indexOf("tom@example.com") === -1, "opted-out Tom must NOT be in the marketing list");
      HC.assert(emails.indexOf("noor@example.com") === -1, "unknown-consent Noor must NOT be in the marketing list");
      HC.assert(emails.indexOf("priya@example.com") !== -1, "opted-in Priya must be in the marketing list");
    });

    check("Marketing list is de-duplicated by email", function () {
      var emails = marketing.map(function (r) { return r.email; });
      var uniq = {};
      emails.forEach(function (e) { uniq[e] = (uniq[e] || 0) + 1; });
      Object.keys(uniq).forEach(function (e) {
        HC.assert(uniq[e] === 1, "duplicate email in marketing list: " + e);
      });
    });

    // --- Privacy-Policy rule (article 4147919): no policy => opt-in not shown,
    //     marketing list empty. ---
    check("With NO Privacy Policy the opt-in column is suppressed", function () {
      var noPolicy = buildCustomers(ledger, /*privacyPolicyUploaded*/ false);
      noPolicy.forEach(function (c) {
        HC.assert(c.optInLabel === "not-displayed", c.parentName + " opt-in should be not-displayed without a policy");
      });
    });

    check("With NO Privacy Policy the marketing list is empty", function () {
      var noPolicy = buildCustomers(ledger, false);
      var ml = buildMarketingList(noPolicy, false);
      HC.assert(ml.length === 0, "marketing list should be empty without a policy, got " + ml.length);
    });

    // --- Roll-up arithmetic (lifetime value, children, last-booked). ---
    check("Lifetime spend sums a parent's bookings", function () {
      var priya = customers.filter(function (c) { return c.parentName === "Priya Shah"; })[0];
      HC.assert(priya.totalSpend === 305, "Priya spend should be 145+160=305, got " + priya.totalSpend);
    });

    check("Children are counted distinctly per parent", function () {
      var tom = customers.filter(function (c) { return c.parentName === "Tom Bennett"; })[0];
      HC.assert(tom.childCount === 2, "Tom has 2 children (Jack, Mia), got " + tom.childCount);
    });

    check("Most-recent explicit consent wins over earlier/unknown", function () {
      // Priya: both true; flip the LATER booking to false and expect No.
      var mixed = [
        bk("Zoe Hart", "zoe@example.com", "Ivy", 6, 100, true, "2026-06-01"),
        bk("Zoe Hart", "zoe@example.com", "Ivy", 6, 100, false, "2026-06-20")
      ];
      var z = buildCustomers(mixed, true)[0];
      HC.assert(z.marketingOptIn === false, "later opt-out should win, got " + z.marketingOptIn);
    });

    // --- CSV export carries the opt-in as the LAST column. ---
    check("Customers CSV last column header is 'Marketing opt-in'", function () {
      var csv = customersToCsv(customers, true);
      var header = csv.split("\r\n")[0].split(",");
      HC.assert(header[header.length - 1] === "Marketing opt-in",
        "last CSV column should be the opt-in, got '" + header[header.length - 1] + "'");
    });

    check("Customers CSV has one data row per customer", function () {
      var csv = customersToCsv(customers, true);
      var lines = csv.split("\r\n");
      HC.assert(lines.length === customers.length + 1, "expected " + (customers.length + 1) + " CSV lines, got " + lines.length);
    });

    // --- Filter + search behave. ---
    check("Filter 'opted-in only' keeps just the Yes customers", function () {
      var only = filterCustomers(customers, { optedInOnly: true });
      HC.assert(only.length === 2, "expected 2 opted-in, got " + only.length);
      only.forEach(function (c) { HC.assert(c.marketingOptIn === true, c.parentName + " should be opted-in"); });
    });

    check("Search matches by parent name", function () {
      var hit = filterCustomers(customers, { query: "tom" });
      HC.assert(hit.length === 1 && hit[0].parentName === "Tom Bennett", "search 'tom' should find Tom only");
    });

    check("Search matches by child name", function () {
      var hit = filterCustomers(customers, { query: "kofi" });
      HC.assert(hit.length === 1 && hit[0].parentName === "Sarah Okafor", "search 'kofi' should find Sarah");
    });

    // --- Defensive parsing: messy consent shapes + bad emails. ---
    check("Consent coercion handles yes/no/1/0/blank", function () {
      HC.assert(coerceConsent("Yes") === true, "'Yes' => true");
      HC.assert(coerceConsent("no") === false, "'no' => false");
      HC.assert(coerceConsent(1) === true, "1 => true");
      HC.assert(coerceConsent(0) === false, "0 => false");
      HC.assert(coerceConsent("") === null, "'' => null/unknown");
      HC.assert(coerceConsent(undefined) === null, "undefined => null/unknown");
    });

    check("Invalid emails are dropped from the marketing list", function () {
      var bad = [
        { parentName: "No Email", email: "", marketingOptIn: true, bookedAt: "2026-06-01" },
        { parentName: "Bad Email", email: "not-an-email", marketingOptIn: true, bookedAt: "2026-06-01" },
        { parentName: "Good", email: "good@example.com", marketingOptIn: true, bookedAt: "2026-06-01" }
      ];
      var cs = buildCustomers(bad, true);
      var ml = buildMarketingList(cs, true);
      HC.assert(ml.length === 1 && ml[0].email === "good@example.com", "only the valid email should export, got " + ml.length);
    });

    check("Empty ledger yields an empty (non-throwing) customer list", function () {
      var none = buildCustomers([], true);
      HC.assert(Array.isArray(none) && none.length === 0, "empty ledger should give empty list");
      HC.assert(buildMarketingList(none, true).length === 0, "empty ledger marketing list should be empty");
    });

    check("Garbage input does not throw (defensive)", function () {
      var c = buildCustomers([null, undefined, 42, "x", {}], true);
      HC.assert(Array.isArray(c), "buildCustomers should always return an array");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER
     =================================================================== */

  HC.registerFeature({
    id: "provider-customers-crm",
    title: "Customers (CRM) + marketing opt-in",
    side: "provider",
    icon: "👥",
    summary: "Your Customers tab: every booked parent rolled up into one row — bookings, children, lifetime spend — with a GDPR marketing-opt-in last column. Export a de-duplicated, opted-in-only marketing list.",
    render: render,
    selfTest: selfTest
  });
})();
