/* HolidayCamp feature — provider-smart-term-tickets
 *
 * Smart Term Tickets — pre-sell the NEXT term while the CURRENT term is still
 * running.  (provider side)
 *
 * Replicates Happity's "Smart Term Tickets" pre-sale, evidenced by two support
 * articles:
 *
 *   5837263 ("How to use the Smart Term Tickets feature"), verbatim:
 *     - Sub-title: "Release your tickets for next term or hold a presale whilst
 *        still in the current term!"
 *     - "Customers will now be able to book ahead for a new term using pro-rated
 *        term tickets, BEFORE the current term has finished, making it easier to
 *        add and list new dates. The system will check which term they've
 *        selected and then reserve the correct set of classes for them."
 *     - "If you run your classes in terms, you can specify a start and end date
 *        for each new term, creating multiple terms ... securing those advanced
 *        bookings!"
 *     - "NB. If there is only one date left in the term, then parents will not be
 *        able to buy a term ticket and will need to buy a single ticket instead."
 *
 *   4518631 ("How to pre-sell your classes"), verbatim:
 *     - "Pre-sales are a perfect way to reward loyalty amongst your existing
 *        customers, and maximise sales for your classes BEFORE the new term
 *        begins."
 *     - "You might also choose to only sell block / term tickets in the pre-sale
 *        initially."
 *
 * A SIBLING feature, provider-term-scheduling.js, already covers the date-grid
 * ("specify a start and end date ... select the individual dates or click
 * 'select all'") mechanics.  THIS feature is the layer above it: defining a
 * sequence of consecutive terms, opening a PRE-SALE on the next term while the
 * current one is still live, and selling next-term term tickets ahead of time.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): a "term" here is a
 * holiday period — e.g. "Summer 2026" (current) and "Autumn half-term 2026"
 * (next).  Default seed dates come from the live Waltham Forest planner
 * (summer holiday starts 21 Jul 2026, back-to-school 2 Sep 2026).
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   "Next-term term tickets can be sold before the current term ends."
 *   We model a clock ("now"), a current term that is live, and a next term whose
 *   pre-sale window opens DURING the current term.  We assert that at a "now"
 *   strictly before the current term's end date, a parent CAN purchase a
 *   next-term term ticket (and that the sale is recorded against the next term,
 *   reserving its set of dates) — and conversely that pre-sale is refused before
 *   it opens, and that the Happity NB rule (a term needs >1 remaining date for a
 *   term ticket) is enforced.
 *
 * Self-contained, defensive, plain browser JS. No imports/exports. Persists only
 * via HC.store. Calls HC.registerFeature at top level.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-smart-term-tickets: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;
  var STORE_KEY = "provider_smart_term_tickets"; // persisted term sequence + sales

  var DAY = 86400000;
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* ===================== pure date helpers (DOM-free) ===================== */

  function parseISO(iso) {
    if (typeof iso !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return null;
    }
    return dt;
  }

  function toISO(dt) {
    if (!(dt instanceof Date) || isNaN(dt.getTime())) return null;
    var y = dt.getUTCFullYear();
    var mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    var d = String(dt.getUTCDate()).padStart(2, "0");
    return y + "-" + mo + "-" + d;
  }

  function addDays(dt, n) { return new Date(dt.getTime() + n * DAY); }

  // millis-at-UTC-midnight for an ISO string, or null
  function ms(iso) { var d = parseISO(iso); return d ? d.getTime() : null; }

  function prettyDate(iso) {
    var dt = parseISO(iso);
    if (!dt) return iso;
    return DOW[dt.getUTCDay()] + " " + dt.getUTCDate() + " " + MON[dt.getUTCMonth()];
  }

  // Enumerate weekday (Mon–Fri) dates in [startISO, endISO] inclusive. Holiday
  // camps run weekdays across the school holidays, so this is the candidate set
  // of camp dates inside a term. Defensive: bad/reversed ranges -> [].
  function weekdayDates(startISO, endISO) {
    var start = parseISO(startISO), end = parseISO(endISO);
    if (!start || !end || end.getTime() < start.getTime()) return [];
    var out = [], cur = start, guard = 0;
    while (cur.getTime() <= end.getTime()) {
      var dow = cur.getUTCDay();
      if (dow >= 1 && dow <= 5) out.push(toISO(cur));
      cur = addDays(cur, 1);
      if (++guard > 800) break; // ~2yr cap; a holiday period is never this long
    }
    return out;
  }

  /* ===================== term model ===================== */

  // A Term is a holiday period the provider sells tickets for.
  //   { id, name, start, end, dates:[iso], capacity,
  //     presaleOpens:isoOrNull }   presaleOpens = when advance booking begins.
  // When presaleOpens is null we fall back to the term's own start date (no
  // pre-sale — tickets only go live when the term begins).
  function makeTerm(opts) {
    var o = (opts && typeof opts === "object") ? opts : {};
    var start = parseISO(o.start) ? o.start : null;
    var end = parseISO(o.end) ? o.end : null;
    var dates = weekdayDates(start, end);
    return {
      id: o.id || safeUid("term"),
      name: asText(o.name) || "Untitled term",
      start: start,
      end: end,
      dates: dates,
      capacity: clampInt(o.capacity, 0, 999, 0),
      presaleOpens: parseISO(o.presaleOpens) ? o.presaleOpens : null
    };
  }

  // The effective date from which a term's tickets are buyable. If a pre-sale is
  // set, that's the pre-sale open date; otherwise the term's start.
  function saleOpensISO(term) {
    if (!term) return null;
    if (term.presaleOpens) return term.presaleOpens;
    return term.start;
  }

  // Has this term's (pre-)sale opened as of `nowISO`?  Inclusive of the open day.
  function saleIsOpen(term, nowISO) {
    var open = ms(saleOpensISO(term));
    var now = ms(nowISO);
    if (open === null || now === null) return false;
    return now >= open;
  }

  // Is `nowISO` strictly BEFORE this term ends? (i.e. the term is still running,
  // or hasn't started). Used to prove "before the current term ends".
  function isBeforeEnd(term, nowISO) {
    var end = term ? ms(term.end) : null;
    var now = ms(nowISO);
    if (end === null || now === null) return false;
    return now < end;
  }

  // Is the term currently LIVE/running as of now (start <= now < end)?
  function isLive(term, nowISO) {
    var s = term ? ms(term.start) : null;
    var e = term ? ms(term.end) : null;
    var now = ms(nowISO);
    if (s === null || e === null || now === null) return false;
    return now >= s && now < e;
  }

  // Dates in the term that are still in the future as of now (you can't sell a
  // ticket for a camp day that has already passed). Inclusive of "today".
  function remainingDates(term, nowISO) {
    var now = ms(nowISO);
    if (!term || now === null) return [];
    return term.dates.filter(function (iso) {
      var m = ms(iso);
      return m !== null && m >= now;
    });
  }

  // Happity NB rule, framed for camps: a TERM TICKET (whole-period pass) is only
  // sellable when MORE THAN ONE date remains in the term. 0–1 remaining dates =>
  // single day ticket only.
  function termTicketAvailable(term, nowISO) {
    return remainingDates(term, nowISO).length > 1;
  }

  /* ===================== pricing (pro-rated term tickets) ===================== */

  // Article: "pro-rated term tickets". A term ticket bought mid-term should be
  // priced only for the dates that remain. perDate = full term price / total
  // dates; pro-rated = perDate * remaining dates. Rounded to the penny.
  function proRatedTermPrice(term, fullTermPrice, nowISO) {
    var total = term ? term.dates.length : 0;
    if (total <= 0) return 0;
    var full = Number(fullTermPrice);
    if (!isFinite(full) || full < 0) full = 0;
    var remaining = remainingDates(term, nowISO).length;
    var perDate = full / total;
    return Math.round(perDate * remaining * 100) / 100;
  }

  /* ===================== the headline: pre-sell next term ===================== */

  // Build the canonical demo scenario: a CURRENT term that is live, and a NEXT
  // term whose pre-sale opens partway through the current one.  All dates are
  // ISO. This is the situation the Happity article describes.
  function buildScenario(over) {
    var o = over || {};
    var current = makeTerm({
      name: o.currentName || "Summer 2026",
      start: o.currentStart || "2026-07-21",
      end: o.currentEnd || "2026-08-28",
      capacity: o.capacity || 24
    });
    var next = makeTerm({
      name: o.nextName || "Autumn half-term 2026",
      start: o.nextStart || "2026-10-26",
      end: o.nextEnd || "2026-10-30",
      // Pre-sale for the next term opens DURING the current term by default.
      presaleOpens: o.nextPresaleOpens || "2026-08-10",
      capacity: o.capacity || 24
    });
    return { current: current, next: next };
  }

  // THE acceptance operation. A parent attempts to buy a TERM TICKET for the
  // NEXT term, at clock time `nowISO`, while the current term is still running.
  // Returns a structured outcome (never throws).
  //
  //   { ok, reason, term, ticketType, dates:[iso], price, soldAt, presale }
  //
  // ok=true means the sale went through; `presale=true` means it happened before
  // the *next* term has even started (a true advance booking).  We also flag
  // `beforeCurrentEnds` so callers can prove the acceptance criterion directly.
  function buyNextTermTicket(scenario, fullTermPrice, nowISO) {
    var out = {
      ok: false, reason: "", term: null, ticketType: null,
      dates: [], price: 0, soldAt: nowISO || null,
      presale: false, beforeCurrentEnds: false
    };
    try {
      if (!scenario || !scenario.next || !scenario.current) {
        out.reason = "No current/next term configured.";
        return out;
      }
      var next = scenario.next, current = scenario.current;
      out.term = next.name;

      if (ms(nowISO) === null) {
        out.reason = "Invalid sale date.";
        return out;
      }

      // 1. The next term's pre-sale must have opened.
      if (!saleIsOpen(next, nowISO)) {
        out.reason = "Pre-sale for " + next.name + " hasn't opened yet " +
          "(opens " + prettyDate(saleOpensISO(next)) + ").";
        return out;
      }

      // 2. There must be enough remaining dates to sell a TERM ticket (NB rule).
      var rem = remainingDates(next, nowISO);
      if (rem.length <= 1) {
        out.ticketType = rem.length === 1 ? "single" : null;
        out.reason = rem.length === 1
          ? "Only one date left in " + next.name + " — sell a single day ticket instead."
          : "No dates left in " + next.name + " to sell.";
        return out;
      }

      // 3. Sale succeeds — reserve the next term's remaining dates, pro-rated.
      out.ok = true;
      out.ticketType = "term";
      out.dates = rem.slice();
      out.price = proRatedTermPrice(next, fullTermPrice, nowISO);
      // presale === sold before the next term has even begun
      out.presale = ms(nowISO) < ms(next.start);
      // the acceptance flag: sold while the CURRENT term is still running
      out.beforeCurrentEnds = isBeforeEnd(current, nowISO) && isLive(current, nowISO);
      out.reason = "Booked a pro-rated term ticket for " + next.name +
        " (" + out.dates.length + " dates) — " + money(out.price) +
        (out.presale ? ", in advance of the term starting." : ".");
      return out;
    } catch (e) {
      out.ok = false;
      out.reason = "Could not complete the sale: " + (e && e.message ? e.message : String(e));
      return out;
    }
  }

  /* ===================== persistence (HC.store only) ===================== */

  function readState() {
    try {
      var s = HC.store.get(STORE_KEY, null);
      if (s && typeof s === "object") return s;
    } catch (e) { /* fall through */ }
    return { current: null, next: null, sales: [] };
  }
  function writeState(st) {
    try { return HC.store.set(STORE_KEY, st && typeof st === "object" ? st : {}); }
    catch (e) { return false; }
  }

  // Persist a recorded pre-sale (so a reload shows what's already been sold).
  function recordSale(outcome) {
    if (!outcome || !outcome.ok) return null;
    var st = readState();
    if (!Array.isArray(st.sales)) st.sales = [];
    var rec = {
      id: safeUid("sale"),
      term: outcome.term,
      ticketType: outcome.ticketType,
      dates: outcome.dates.slice(),
      price: outcome.price,
      soldAt: outcome.soldAt,
      presale: !!outcome.presale,
      at: Date.now()
    };
    st.sales.unshift(rec);
    if (st.sales.length > 50) st.sales = st.sales.slice(0, 50);
    writeState(st);
    return rec;
  }

  // How many places remain on the next term given recorded pre-sales. Each term
  // ticket sale takes one place across the whole period.
  function placesRemaining(term, sales) {
    var cap = term ? term.capacity : 0;
    var sold = 0;
    if (Array.isArray(sales)) {
      for (var i = 0; i < sales.length; i++) {
        if (sales[i] && sales[i].term === (term && term.name) && sales[i].ticketType === "term") sold += 1;
      }
    }
    return Math.max(0, cap - sold);
  }

  /* ===================== misc helpers ===================== */

  function asText(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  function clampInt(v, lo, hi, def) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return def;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function money(n) {
    try { return HC.util.money(n); }
    catch (e) {
      var num = Number(n);
      if (!isFinite(num)) return "£0";
      return "£" + (Number.isInteger(num) ? num : num.toFixed(2));
    }
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }

  /* ===================== seed from live planner data ===================== */

  // Seed the scenario from the live Waltham Forest planner where possible so the
  // demo opens on real 2026 dates rather than placeholders.
  function seededScenario() {
    try {
      var kd = (HC.data.planner && HC.data.planner.keyDates) || {};
      var summerStart = (kd.holidayStart && kd.holidayStart.iso) || "2026-07-21";
      var bankHol = (kd.bankHoliday && kd.bankHoliday.iso) || "2026-08-31";
      var back = (kd.backToSchool && kd.backToSchool.iso) || "2026-09-02";
      // Current term = summer up to the Friday before the bank holiday week.
      var bh = parseISO(bankHol);
      var currentEnd = bh ? toISO(addDays(bh, -3)) : "2026-08-28"; // Mon BH -3 = Fri
      // Pre-sale for the autumn term opens ~3 weeks into the summer holiday.
      var ss = parseISO(summerStart);
      var presale = ss ? toISO(addDays(ss, 21)) : "2026-08-11";
      // Next term = autumn half-term week (last full week of October 2026).
      return buildScenario({
        currentName: "Summer 2026",
        currentStart: summerStart,
        currentEnd: currentEnd,
        nextName: "Autumn half-term 2026",
        nextStart: "2026-10-26",
        nextEnd: "2026-10-30",
        nextPresaleOpens: presale,
        capacity: 24,
        _back: back
      });
    } catch (e) {
      return buildScenario({});
    }
  }

  /* ===================== UI ===================== */

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      var scenario = seededScenario();
      var fullTermPrice = 120; // illustrative full-term price for the next term

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 10px;line-height:1.5">' +
          "<strong>Release next term’s tickets early.</strong> Set up your next holiday period now and " +
          "open a <strong>pre-sale while the current camp is still running</strong> — families book ahead with a " +
          "<strong>pro-rated term ticket</strong> and you lock in those advance bookings before dates even go live.</p>");
      mountEl.appendChild(intro);

      // --- term cards (current vs next) ---
      var cards = el("div", {
        style: "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 14px"
      });
      cards.innerHTML =
        termCardHtml(scenario.current, "Current term", "live") +
        termCardHtml(scenario.next, "Next term", "presale");
      mountEl.appendChild(cards);

      // --- "today" clock control ---
      var clockBox = el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:13px 14px;background:#fff;margin:0 0 12px"
      });
      var defaultNow = scenario.next.presaleOpens || scenario.current.start || "2026-08-15";
      clockBox.innerHTML =
        '<label style="font-size:13px;font-weight:700;color:var(--purple,#603488)">Pretend today is&nbsp;' +
          '<input id="sttNow" type="date" value="' + esc(defaultNow) + '" ' +
            'style="margin-left:6px;padding:6px 8px;border:1px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px"></label>' +
        '<p id="sttClockNote" style="font-size:12.5px;color:var(--muted,#808080);margin:8px 0 0"></p>';
      mountEl.appendChild(clockBox);

      // --- buy button + outcome ---
      var actionRow = el("div", { style: "display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 12px" });
      actionRow.innerHTML =
        '<button class="hc-btn" id="sttBuy" type="button">Pre-buy next-term ticket</button>' +
        '<span id="sttPlaces" style="font-size:12.5px;color:var(--muted,#808080);font-weight:700"></span>';
      mountEl.appendChild(actionRow);

      var outcomeBox = el("div", { id: "sttOutcome",
        style: "border-radius:12px;padding:11px 13px;font-size:13px;line-height:1.5" });
      mountEl.appendChild(outcomeBox);

      // --- recorded pre-sales ---
      var salesBox = el("div", { id: "sttSales", style: "margin-top:14px" });
      mountEl.appendChild(salesBox);

      function nowVal() {
        var n = mountEl.querySelector("#sttNow");
        return n ? n.value : defaultNow;
      }

      function paintClockNote() {
        var note = mountEl.querySelector("#sttClockNote");
        if (!note) return;
        var nowISO = nowVal();
        var cur = scenario.current, nxt = scenario.next;
        var bits = [];
        bits.push(isLive(cur, nowISO)
          ? "✓ <strong>" + esc(cur.name) + "</strong> is running right now (ends " + esc(prettyDate(cur.end)) + ")."
          : "<strong>" + esc(cur.name) + "</strong> is " + (ms(nowISO) >= ms(cur.end) ? "over" : "not started yet") + ".");
        bits.push(saleIsOpen(nxt, nowISO)
          ? "✓ Pre-sale for <strong>" + esc(nxt.name) + "</strong> is OPEN."
          : "Pre-sale for <strong>" + esc(nxt.name) + "</strong> opens " + esc(prettyDate(saleOpensISO(nxt))) + ".");
        note.innerHTML = bits.join(" ");
      }

      function paintPlaces() {
        var span = mountEl.querySelector("#sttPlaces");
        if (!span) return;
        var st = readState();
        var left = placesRemaining(scenario.next, st.sales);
        span.textContent = left + " of " + scenario.next.capacity + " next-term places left";
      }

      function paintSales() {
        var box = mountEl.querySelector("#sttSales");
        if (!box) return;
        var st = readState();
        var sales = (st.sales || []).filter(function (s) { return s && s.term === scenario.next.name; });
        if (!sales.length) { box.innerHTML = ""; return; }
        var rows = sales.slice(0, 6).map(function (s) {
          return '<li style="font-size:12.5px;color:var(--text,#383838);margin:2px 0">' +
            (s.presale ? "🎟️ " : "🎫 ") + esc(s.ticketType === "term" ? "Term ticket" : "Day ticket") +
            " · " + esc(money(s.price)) + " · " + (s.dates ? s.dates.length : 0) + " dates · sold " +
            esc(prettyDate(s.soldAt)) + (s.presale ? " (advance)" : "") + "</li>";
        }).join("");
        box.innerHTML =
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
            'text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 6px">Pre-sales recorded</div>' +
          '<ul style="margin:0;padding-left:18px">' + rows + "</ul>";
      }

      function paintOutcome(outcome) {
        var box = mountEl.querySelector("#sttOutcome");
        if (!box) return;
        if (!outcome) { box.innerHTML = ""; box.setAttribute("style", "padding:0"); return; }
        var ok = outcome.ok;
        var bg = ok ? "#E1F0E4" : "#FFF4D6";
        var fg = ok ? "#2f7d4f" : "#8a6d00";
        box.setAttribute("style",
          "border-radius:12px;padding:11px 13px;font-size:13px;line-height:1.5;background:" + bg + ";color:" + fg);
        box.innerHTML = "<strong>" + (ok ? "✓ Advance booking confirmed" : "Can’t sell that yet") +
          "</strong><br>" + esc(outcome.reason);
      }

      var nowInput = mountEl.querySelector("#sttNow");
      if (nowInput) nowInput.addEventListener("change", function () {
        paintClockNote(); paintOutcome(null);
      });

      var buyBtn = mountEl.querySelector("#sttBuy");
      if (buyBtn) buyBtn.addEventListener("click", function () {
        var outcome = buyNextTermTicket(scenario, fullTermPrice, nowVal());
        paintOutcome(outcome);
        if (outcome.ok) {
          recordSale(outcome);
          paintPlaces();
          paintSales();
          try { HC.util.toast("Next-term ticket pre-sold"); } catch (e2) {}
        }
      });

      paintClockNote();
      paintPlaces();
      paintSales();
      paintOutcome(null);
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Smart term tickets failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  function termCardHtml(term, kicker, mode) {
    var dates = term ? term.dates.length : 0;
    var sub = mode === "presale"
      ? "Pre-sale opens " + esc(prettyDate(saleOpensISO(term)))
      : "Runs " + esc(prettyDate(term.start)) + " – " + esc(prettyDate(term.end));
    var accent = mode === "presale" ? "var(--magenta,#F82488)" : "var(--purple,#603488)";
    return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:13px 14px;background:#fff">' +
      '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;text-transform:uppercase;' +
        'letter-spacing:.5px;font-size:11px;color:' + accent + '">' + esc(kicker) + "</div>" +
      '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);' +
        'font-size:16px;margin:2px 0 2px">' + esc(term.name) + "</div>" +
      '<div style="font-size:12.5px;color:var(--muted,#808080)">' + sub + "</div>" +
      '<div style="font-size:12.5px;color:var(--text,#383838);margin-top:4px">' + dates + " camp dates · " +
        esc(String(term.capacity)) + " places</div>" +
      "</div>";
  }

  /* ===================== selfTest ===================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    /* ---- date plumbing ---- */

    check("weekdayDates lists Mon–Fri inside a window and is defensive", function () {
      var d = weekdayDates("2026-10-26", "2026-10-30"); // Mon–Fri autumn half-term
      HC.assert(d.length === 5, "expected 5 weekday dates, got " + d.length);
      HC.assert(d[0] === "2026-10-26" && d[4] === "2026-10-30", "wrong first/last date");
      HC.assert(weekdayDates("2026-10-30", "2026-10-26").length === 0, "reversed range -> []");
      HC.assert(weekdayDates(null, "x").length === 0, "garbage -> []");
    });

    check("remainingDates drops past dates relative to 'now'", function () {
      var term = makeTerm({ start: "2026-07-21", end: "2026-07-31" }); // 21..31 Jul weekdays
      var all = term.dates.length;
      HC.assert(all > 2, "fixture should have several dates");
      // 'now' = the 2nd weekday: only dates >= that remain
      var rem = remainingDates(term, term.dates[1]);
      HC.assert(rem.length === all - 1, "one past date should be dropped (" + rem.length + " vs " + (all - 1) + ")");
      HC.assert(rem[0] === term.dates[1], "first remaining date should be 'today'");
      // far-future 'now' -> nothing remains
      HC.assert(remainingDates(term, "2027-01-01").length === 0, "all dates past -> none remain");
    });

    /* ===== scenario plumbing: current term live, next term pre-saleable ===== */

    check("buildScenario gives a live current term and a future next term", function () {
      var sc = buildScenario({});
      HC.assert(sc.current && sc.next, "scenario should have both terms");
      HC.assert(ms(sc.current.start) < ms(sc.current.end), "current term has a valid span");
      HC.assert(ms(sc.next.start) > ms(sc.current.start), "next term starts after current");
      HC.assert(sc.next.presaleOpens, "next term should have a pre-sale open date");
      // crucially, the pre-sale opens BEFORE the current term ends
      HC.assert(ms(sc.next.presaleOpens) < ms(sc.current.end),
        "next-term pre-sale must open before the current term ends");
    });

    check("saleIsOpen / isLive / isBeforeEnd behave around the boundaries", function () {
      var sc = buildScenario({});
      var presale = sc.next.presaleOpens; // 2026-08-10
      var dayBefore = "2026-08-09";
      HC.assert(saleIsOpen(sc.next, presale) === true, "pre-sale open on the open day (inclusive)");
      HC.assert(saleIsOpen(sc.next, dayBefore) === false, "pre-sale not open the day before");
      HC.assert(isLive(sc.current, presale) === true, "current term is live on the pre-sale open day");
      HC.assert(isBeforeEnd(sc.current, presale) === true, "pre-sale day is before the current term ends");
      HC.assert(isLive(sc.current, sc.current.end) === false, "term is not live on its end day (exclusive)");
    });

    /* ===== ACCEPTANCE CRITERION =====
       "Next-term term tickets can be sold before the current term ends." */

    check("ACCEPTANCE: a next-term term ticket sells while the current term is still running", function () {
      var sc = buildScenario({});
      // 'now' = 15 Aug 2026: AFTER the next-term pre-sale opens (10 Aug), and
      // BEFORE the current Summer term ends (28 Aug) — and current term is live.
      var nowISO = "2026-08-15";
      HC.assert(isLive(sc.current, nowISO), "fixture: current term must be live at this 'now'");
      HC.assert(ms(nowISO) < ms(sc.current.end), "fixture: 'now' must be before the current term ends");
      var out = buyNextTermTicket(sc, 120, nowISO);
      HC.assert(out.ok === true, "the next-term term ticket should sell: " + out.reason);
      HC.assert(out.ticketType === "term", "it should be a TERM ticket, got " + out.ticketType);
      HC.assert(out.beforeCurrentEnds === true,
        "the sale must be flagged as happening before the current term ends");
      HC.assert(out.presale === true, "it should be an advance/pre-sale (next term not yet started)");
      HC.assert(out.dates.length === sc.next.dates.length,
        "the sale should reserve the next term's full set of dates (" +
        out.dates.length + " vs " + sc.next.dates.length + ")");
    });

    check("ACCEPTANCE: the sale reserves the CORRECT set of classes (the next term's dates)", function () {
      var sc = buildScenario({});
      var out = buyNextTermTicket(sc, 120, "2026-08-15");
      HC.assert(out.ok === true, "sale should succeed");
      // every reserved date must belong to the NEXT term, none to the current one
      for (var i = 0; i < out.dates.length; i++) {
        HC.assert(sc.next.dates.indexOf(out.dates[i]) !== -1,
          out.dates[i] + " should be a next-term date");
        HC.assert(sc.current.dates.indexOf(out.dates[i]) === -1,
          out.dates[i] + " must NOT be a current-term date");
      }
    });

    check("ACCEPTANCE: pre-sale at the EARLIEST allowed moment (pre-sale open day) still works", function () {
      var sc = buildScenario({});
      var openDay = sc.next.presaleOpens; // 2026-08-10, well before current end (28 Aug)
      HC.assert(ms(openDay) < ms(sc.current.end), "open day is before the current term ends");
      var out = buyNextTermTicket(sc, 120, openDay);
      HC.assert(out.ok === true, "selling on the pre-sale open day should work: " + out.reason);
      HC.assert(out.beforeCurrentEnds === true, "still before the current term ends");
    });

    /* ===== negative cases: pre-sale gating ===== */

    check("Pre-sale is REFUSED before it opens", function () {
      var sc = buildScenario({});
      var tooEarly = "2026-08-05"; // before the 10 Aug pre-sale open
      HC.assert(saleIsOpen(sc.next, tooEarly) === false, "fixture: pre-sale not open yet");
      var out = buyNextTermTicket(sc, 120, tooEarly);
      HC.assert(out.ok === false, "must not sell before pre-sale opens");
      HC.assert(/hasn't opened/i.test(out.reason), "reason should explain the pre-sale isn't open");
    });

    check("A bad/missing 'now' is rejected without throwing", function () {
      var sc = buildScenario({});
      var out = buyNextTermTicket(sc, 120, "not-a-date");
      HC.assert(out.ok === false, "invalid date must not sell");
      var out2 = buyNextTermTicket(null, 120, "2026-08-15");
      HC.assert(out2.ok === false, "missing scenario must not sell");
    });

    /* ===== Happity NB rule: a term ticket needs >1 remaining date ===== */

    check("NB rule: with only ONE date left, a term ticket is refused (sell a single instead)", function () {
      // Next term has its pre-sale open, but 'now' is so late only one date remains.
      var sc = buildScenario({
        nextName: "Mini week", nextStart: "2026-09-07", nextEnd: "2026-09-11",
        nextPresaleOpens: "2026-08-01",
        currentStart: "2026-07-21", currentEnd: "2026-09-30"
      });
      HC.assert(sc.next.dates.length === 5, "fixture next term should have 5 dates");
      // 'now' = the LAST date of the next term -> exactly one remaining
      var lastDate = sc.next.dates[sc.next.dates.length - 1];
      HC.assert(remainingDates(sc.next, lastDate).length === 1, "exactly one date should remain");
      var out = buyNextTermTicket(sc, 120, lastDate);
      HC.assert(out.ok === false, "a term ticket needs more than one date");
      HC.assert(out.ticketType === "single", "should fall back to a single day ticket");
      HC.assert(/single/i.test(out.reason), "reason should mention a single ticket");
    });

    check("termTicketAvailable mirrors the NB rule (>1 remaining date)", function () {
      var term = makeTerm({ start: "2026-10-26", end: "2026-10-30" }); // 5 dates
      HC.assert(termTicketAvailable(term, "2026-10-26") === true, "5 remaining -> term ticket ok");
      HC.assert(termTicketAvailable(term, "2026-10-30") === false, "1 remaining -> no term ticket");
      HC.assert(termTicketAvailable(term, "2026-12-01") === false, "0 remaining -> no term ticket");
    });

    /* ===== pro-rated pricing ===== */

    check("proRatedTermPrice charges only for the dates that remain", function () {
      var term = makeTerm({ start: "2026-10-26", end: "2026-10-30" }); // 5 dates, £100 full
      HC.assert(proRatedTermPrice(term, 100, "2026-10-26") === 100, "full term -> full price");
      // from the 3rd date, 3 of 5 remain -> £60
      HC.assert(proRatedTermPrice(term, 100, term.dates[2]) === 60,
        "3 of 5 dates remaining should pro-rate to £60, got " + proRatedTermPrice(term, 100, term.dates[2]));
      HC.assert(proRatedTermPrice(term, 100, "2027-01-01") === 0, "no dates remaining -> £0");
      // defensive: garbage price -> 0
      HC.assert(proRatedTermPrice(term, "abc", "2026-10-26") === 0, "garbage price -> 0");
    });

    /* ===== capacity + persistence via HC.store (never raw localStorage) ===== */

    check("recordSale persists a pre-sale and placesRemaining decrements", function () {
      // isolate this test's data
      var snapshot = readState();
      writeState({ current: null, next: null, sales: [] });
      try {
        var sc = buildScenario({ capacity: 2 });
        var before = placesRemaining(sc.next, readState().sales);
        HC.assert(before === 2, "fixture next term should start with 2 places, got " + before);
        var out = buyNextTermTicket(sc, 120, "2026-08-15");
        HC.assert(out.ok === true, "sale should succeed");
        var rec = recordSale(out);
        HC.assert(rec && rec.term === sc.next.name, "recorded sale should carry the next-term name");
        HC.assert(rec.presale === true, "recorded sale should be flagged as a pre-sale");
        var after = placesRemaining(sc.next, readState().sales);
        HC.assert(after === before - 1, "a recorded term ticket should take one place (" + after + " vs " + (before - 1) + ")");
        // a non-ok outcome must NOT be recorded
        var none = recordSale({ ok: false });
        HC.assert(none === null, "a failed sale must not be persisted");
        HC.assert(readState().sales.length === 1, "only the successful sale should persist");
      } finally {
        writeState(snapshot); // restore so repeated runs stay stable
      }
    });

    /* ===== live planner seed ===== */

    check("seededScenario() builds from live planner dates and supports an advance sale", function () {
      var sc = seededScenario();
      HC.assert(sc && sc.current && sc.next, "seeded scenario should have both terms");
      HC.assert(ms(sc.next.presaleOpens) < ms(sc.current.end),
        "seeded pre-sale should open before the current term ends");
      // pick a 'now' on the pre-sale open day — should be a valid advance sale
      var out = buyNextTermTicket(sc, 120, sc.next.presaleOpens);
      HC.assert(out.ok === true, "seeded scenario should permit an advance term-ticket sale: " + out.reason);
      HC.assert(out.beforeCurrentEnds === true, "and it should be before the current term ends");
    });

    /* ===== defensive: garbage never throws ===== */

    check("makeTerm / buyNextTermTicket tolerate garbage without throwing", function () {
      var bad = [null, undefined, {}, 42, "", [], { start: "??", end: "??" }];
      for (var i = 0; i < bad.length; i++) {
        var t = makeTerm(bad[i]);
        HC.assert(t && Array.isArray(t.dates), "makeTerm must return a term with dates[] for input #" + i);
        var out = buyNextTermTicket({ current: t, next: t }, bad[i], "2026-08-15");
        HC.assert(out && out.ok === false, "garbage scenario should not sell (#" + i + ")");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================== register ===================== */

  HC.registerFeature({
    id: "provider-smart-term-tickets",
    title: "Smart Term Tickets (pre-sell next term)",
    side: "provider",
    icon: "🎟️",
    summary: "Release next term’s tickets early — open a pre-sale while the current camp is still running, so families book ahead with a pro-rated term ticket and you lock in advance bookings before dates go live.",
    render: render,
    selfTest: selfTest
  });
})();
