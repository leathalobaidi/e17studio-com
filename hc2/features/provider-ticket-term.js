/* HolidayCamp feature — provider-ticket-term
 *
 * Term tickets + automatic pro-rata calculator  (provider side)
 *
 * Replicates Happity's Term Ticket feature (support articles 10248958 +
 * 5837263). Evidence, verbatim from article 10248958:
 *   - "Term Tickets: Term tickets book a customer into all remaining available
 *      dates in a term."                                       <-- ACCEPTANCE
 *   - "The Happity system features an Automatic Pro-Rata Calculator, which
 *      allows customers to join midway through a term by automatically
 *      recalculating the total price. Simply enter the cost per single session,
 *      and the system handles the maths for you."              <-- ACCEPTANCE
 *   - "When there is only one date remaining in a term, the term ticket will
 *      deactivate." (also article 5837263: "If there is only one date left in
 *      the term, then parents will not be able to buy a term ticket and will
 *      need to buy a single ticket instead.")
 * Article 10248958 also distinguishes FULL-TERM vs HALF-TERM tickets:
 *   - "you can offer two separate half-terms" / "book for all the sessions
 *      (e.g. for the whole Summer term)".
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A "term" here is a
 * HOLIDAY-CAMP SEASON: the ordered list of camp DAYS a provider runs across the
 * summer holiday (built from the live planner weeks — each confirmed week
 * expands to its weekdays). The provider sets ONE price-per-session; the system:
 *   - sells a TERM TICKET that books ALL remaining session dates from the day a
 *     family joins, and
 *   - AUTO-PRICES a mid-term joiner pro-rata = pricePerSession × remaining
 *     sessions (never charging for camp days that have already passed).
 * Full term = the whole season; half term = first/second half only (Happity's
 * full/half split). The single-date-left deactivation rule is enforced.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   "A term ticket books all remaining term dates; mid-term joiners are
 *    auto-priced pro-rata."
 *   Verified by: buildTerm() ordering the season's dates; quoteTermTicket()
 *   returning EVERY remaining date from the join date (start joiner gets all N;
 *   mid joiner gets the tail), pricing each quote at pricePerSession × count;
 *   and the one-date-left rule deactivating the term ticket.
 *
 * Self-contained, defensive, plain browser JS. No imports/exports. Persists
 * only via HC.store. Calls HC.registerFeature at top level.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-ticket-term: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;
  var STORE_KEY = "provider_term_tickets"; // persisted per-provider term ticket config

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* ============================================================
     pure date helpers (DOM-free, UTC to avoid TZ drift)
     ============================================================ */

  function parseISO(iso) {
    if (typeof iso !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    // reject calendar overflow (e.g. 2026-02-31 rolling into March)
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

  function addDays(iso, n) {
    var dt = parseISO(iso);
    if (!dt) return null;
    dt.setUTCDate(dt.getUTCDate() + n);
    return toISO(dt);
  }

  // Pretty label e.g. "Mon 27 Jul".
  function pretty(iso) {
    var dt = parseISO(iso);
    if (!dt) return String(iso);
    return DOW[dt.getUTCDay()] + " " + dt.getUTCDate() + " " + MON[dt.getUTCMonth()];
  }

  function isWeekday(iso) {
    var dt = parseISO(iso);
    if (!dt) return false;
    var d = dt.getUTCDay();
    return d >= 1 && d <= 5; // Mon–Fri
  }

  /* ============================================================
     money helper — pence-safe (avoid float drift on £xx.xx maths)
     ============================================================ */

  // Round a GBP amount to whole pence. £48.30 × 3 etc. stays exact.
  function gbp(n) {
    var num = Number(n);
    if (!isFinite(num) || num < 0) return 0;
    return Math.round(num * 100) / 100;
  }

  /* ============================================================
     build a TERM (ordered list of camp session dates)
     ============================================================
     A term is built from a list of week objects shaped like the live planner
     weeks: { mon: "YYYY-MM-DD", days: Number }. Each week expands to its
     weekday session dates (Mon..Mon+days-1, weekdays only). Dates are returned
     unique + sorted ascending. This is the camp-season equivalent of Happity's
     "remaining available dates in a term".
  */
  function buildTerm(weeks) {
    var out = [];
    var seen = {};
    if (!Array.isArray(weeks)) return out;
    for (var i = 0; i < weeks.length; i++) {
      var w = weeks[i];
      if (!w || typeof w !== "object") continue;
      var mon = w.mon;
      if (!parseISO(mon)) continue;
      var span = Number(w.days);
      if (!isFinite(span) || span < 1) span = 5;
      span = Math.min(Math.floor(span), 7); // never run away
      for (var k = 0; k < span; k++) {
        var iso = addDays(mon, k);
        if (!iso) continue;
        if (!isWeekday(iso)) continue;     // holiday camps run weekdays
        if (seen[iso]) continue;
        seen[iso] = true;
        out.push(iso);
      }
    }
    out.sort();
    return out;
  }

  // Split a term into halves (Happity full-term vs half-term). Returns
  // { full, first, second } each an array of ISO dates. Odd counts put the
  // extra session in the FIRST half (camps front-load the summer).
  function splitTerm(dates) {
    var full = Array.isArray(dates) ? dates.slice() : [];
    var n = full.length;
    var cut = Math.ceil(n / 2);
    return { full: full, first: full.slice(0, cut), second: full.slice(cut) };
  }

  // Resolve which date-set a scope refers to.
  function scopeDates(term, scope) {
    var parts = splitTerm(term);
    if (scope === "first") return parts.first;
    if (scope === "second") return parts.second;
    return parts.full;
  }

  /* ============================================================
     THE ACCEPTANCE LOGIC — term ticket booking + pro-rata quote
     ============================================================
     Given the term's ordered dates, a price-per-session, and the date a family
     wants to JOIN, return a quote that:
       - books EVERY remaining date on/after the join date (Happity: "all
         remaining available dates in a term"), and
       - is priced pro-rata = pricePerSession × number of remaining dates
         (Happity's Automatic Pro-Rata Calculator).
     If only ONE date remains on/after the join date, the term ticket
     DEACTIVATES (active:false) — the family must buy a single/day ticket
     (Happity's one-date-left rule). Zero remaining => also inactive.
  */
  function quoteTermTicket(dates, pricePerSession, joinISO) {
    var price = Number(pricePerSession);
    if (!isFinite(price) || price < 0) price = 0;

    var all = Array.isArray(dates) ? dates.filter(function (d) { return !!parseISO(d); }) : [];
    all = all.slice().sort();

    // Default join = the first session (book the WHOLE term).
    var join = parseISO(joinISO) ? joinISO : (all[0] || null);

    var remaining = all.filter(function (d) {
      return join === null ? false : d >= join;
    });

    var count = remaining.length;
    var fullCount = all.length;
    // One-date-left rule: a term ticket needs >= 2 remaining sessions.
    var active = count >= 2;
    var total = active ? gbp(price * count) : 0;
    var fullPrice = gbp(price * fullCount);

    return {
      active: active,
      pricePerSession: gbp(price),
      joinDate: join,
      remainingDates: remaining,        // EXACTLY the dates this ticket books
      remainingCount: count,
      totalSessions: fullCount,
      total: total,                     // pro-rata total for a joiner
      fullTermTotal: fullPrice,         // what a start-of-term booker pays
      saving: gbp(fullPrice - total),   // what the joiner saves vs full term
      reason: active ? "term-ticket"
        : (count === 1 ? "one-date-left" : "no-dates-left")
    };
  }

  /* ============================================================
     persistence (HC.store only) — per-provider term ticket config
     ============================================================ */

  function loadAll() {
    var raw = HC.store.get(STORE_KEY, {});
    return (raw && typeof raw === "object") ? raw : {};
  }
  function saveAll(map) { HC.store.set(STORE_KEY, map || {}); }

  function getConfig(providerId) {
    var all = loadAll();
    var c = all[providerId];
    if (!c || typeof c !== "object") return null;
    return c;
  }

  // Save a term-ticket config: { pricePerSession, scope:'full'|'first'|'second' }.
  // Returns { ok, error?, config? }. Defensive against junk.
  function saveConfig(providerId, cfg) {
    if (!providerId || typeof providerId !== "string") {
      return { ok: false, error: "provider id required" };
    }
    if (!cfg || typeof cfg !== "object") {
      return { ok: false, error: "config required" };
    }
    var price = Number(cfg.pricePerSession);
    if (!isFinite(price) || price < 0) {
      return { ok: false, error: "price per session must be a non-negative number" };
    }
    var scope = (cfg.scope === "first" || cfg.scope === "second") ? cfg.scope : "full";
    var clean = { pricePerSession: gbp(price), scope: scope, savedAt: Date.now() };
    var all = loadAll();
    all[providerId] = clean;
    saveAll(all);
    return { ok: true, config: clean };
  }

  function clearConfig(providerId) {
    var all = loadAll();
    if (all[providerId]) { delete all[providerId]; saveAll(all); }
  }

  /* ============================================================
     bridge to live data — derive a provider's term from the planner
     ============================================================ */

  function plannerWeeks() {
    var p = HC.data.planner;
    return (p && Array.isArray(p.weeks)) ? p.weeks : [];
  }

  // Map a provider's confirmed week IDs to the planner week objects.
  function weeksForProvider(providerId) {
    var planner = HC.data.planner;
    var byId = (planner && planner.byId) || {};
    var allWeeks = plannerWeeks();
    var rec = byId[providerId];
    var ids = (rec && Array.isArray(rec.weeks)) ? rec.weeks : [];
    var chosen = allWeeks.filter(function (w) { return ids.indexOf(w.id) !== -1; });
    return chosen;
  }

  // Best-effort default price-per-session for a provider from live data.
  function defaultPrice(providerId) {
    var byId = (HC.data.planner && HC.data.planner.byId) || {};
    var rec = byId[providerId];
    var day = rec && rec.price && Number(rec.price.day);
    return isFinite(day) && day > 0 ? gbp(day) : 40; // sensible camp default
  }

  /* ============================================================
     render() — provider UI
     ============================================================ */

  function render(mountEl) {
    if (!mountEl) return;
    try {
      mountEl.innerHTML = "";

      // Pick a real provider that has confirmed weeks, else first provider.
      var providers = HC.data.providers || [];
      var withWeeks = providers.filter(function (p) {
        return weeksForProvider(p.id || p.slug).length >= 2;
      });
      var demo = withWeeks[0] || providers[0] || { id: "demo-camp", name: "Demo Holiday Camp" };
      var pid = demo.id || demo.slug || "demo-camp";

      var weeks = weeksForProvider(pid);
      var term = buildTerm(weeks);
      if (term.length < 2) {
        // Fallback synthetic season so the UI always has something to show.
        term = buildTerm([
          { mon: "2026-07-27", days: 5 },
          { mon: "2026-08-03", days: 5 },
          { mon: "2026-08-10", days: 5 }
        ]);
      }

      var saved = getConfig(pid);
      var startPrice = saved ? saved.pricePerSession : defaultPrice(pid);
      var startScope = saved ? saved.scope : "full";

      var css = HC.util.el("style", null,
        ".tt-wrap{font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838);font-size:14px}" +
        ".tt-wrap h4{font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);margin:16px 0 6px;font-size:15px}" +
        ".tt-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:8px 0}" +
        ".tt-field{display:flex;flex-direction:column;gap:3px}" +
        ".tt-field label{font-size:12px;font-weight:700;color:var(--muted,#808080)}" +
        ".tt-field input,.tt-field select{font:inherit;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;min-width:150px}" +
        ".tt-note{font-size:12.5px;color:var(--muted,#808080);margin:4px 0}" +
        ".tt-quote{border:1.5px solid var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px;margin-top:12px;background:#FBF8FD}" +
        ".tt-big{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:22px}" +
        ".tt-dates{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}" +
        ".tt-chip{font-size:12px;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);border-radius:999px;padding:3px 9px}" +
        ".tt-chip.past{background:#EEE;color:#999;text-decoration:line-through}" +
        ".tt-warn{background:var(--pink-tint,#FCE8F0);color:#9a1f5e;border-radius:10px;padding:10px 12px;font-size:13px;margin-top:10px}" +
        ".tt-save{font-size:12.5px;color:#2f7d4f;font-weight:700;margin-top:8px;min-height:18px}");
      mountEl.appendChild(css);

      var wrap = HC.util.el("div", { class: "tt-wrap" });
      wrap.innerHTML =
        '<p>A <strong>term ticket</strong> books a family into <strong>all remaining camp days</strong> in the ' +
        'season in one purchase. Set <strong>one price per session</strong> below — the ' +
        '<strong>automatic pro-rata calculator</strong> charges a mid-season joiner only for the days they have ' +
        'left, never for days already gone.</p>' +
        '<p class="tt-note">Provider: <strong>' + escapeHtml(demo.name || pid) + '</strong> · ' +
        term.length + ' camp days this season (built from the live planner).</p>';
      mountEl.appendChild(wrap);

      // Controls
      var controls = HC.util.el("div");
      controls.innerHTML =
        '<div class="tt-row">' +
          '<div class="tt-field"><label for="ttPrice">Price per session (£)</label>' +
            '<input id="ttPrice" type="number" min="0" step="0.01" value="' + startPrice + '"></div>' +
          '<div class="tt-field"><label for="ttScope">Term scope</label>' +
            '<select id="ttScope">' +
              '<option value="full">Full term (whole season)</option>' +
              '<option value="first">First half-term</option>' +
              '<option value="second">Second half-term</option>' +
            '</select></div>' +
          '<div class="tt-field"><label for="ttJoin">Family joins on</label>' +
            '<select id="ttJoin"></select></div>' +
        '</div>' +
        '<div class="tt-row">' +
          '<button class="hc-btn" id="ttSaveBtn" type="button">Save term ticket</button>' +
        '</div>' +
        '<div class="tt-save" id="ttSaveMsg"></div>' +
        '<div id="ttQuote"></div>';
      mountEl.appendChild(controls);

      var $price = controls.querySelector("#ttPrice");
      var $scope = controls.querySelector("#ttScope");
      var $join = controls.querySelector("#ttJoin");
      var $quote = controls.querySelector("#ttQuote");
      var $saveMsg = controls.querySelector("#ttSaveMsg");

      if ($scope) $scope.value = startScope;

      function activeDates() { return scopeDates(term, $scope ? $scope.value : "full"); }

      function refreshJoinOptions() {
        if (!$join) return;
        var ds = activeDates();
        var prev = $join.value;
        $join.innerHTML = ds.map(function (d, i) {
          return '<option value="' + d + '">' +
            (i === 0 ? "Start — " : "") + pretty(d) + "</option>";
        }).join("");
        // keep selection if still valid
        if (ds.indexOf(prev) !== -1) $join.value = prev;
      }

      function refreshQuote() {
        var ds = activeDates();
        var price = $price ? $price.value : startPrice;
        var join = $join && $join.value ? $join.value : (ds[0] || null);
        var q = quoteTermTicket(ds, price, join);

        var dateChips = ds.map(function (d) {
          var past = q.joinDate && d < q.joinDate;
          return '<span class="tt-chip' + (past ? " past" : "") + '">' + pretty(d) + "</span>";
        }).join("");

        var html =
          '<div class="tt-quote">' +
            (q.active
              ? '<div class="tt-big">' + HC.util.money(q.total) + '</div>' +
                '<div class="tt-note">' + q.remainingCount + ' of ' + q.totalSessions +
                  ' camp days · ' + HC.util.money(q.pricePerSession) + '/session' +
                  (q.saving > 0
                    ? ' · joiner saves ' + HC.util.money(q.saving) + ' vs full ' + HC.util.money(q.fullTermTotal)
                    : '') + '</div>'
              : '') +
            '<div class="tt-dates">' + dateChips + '</div>' +
            (!q.active
              ? '<div class="tt-warn">' +
                  (q.reason === "one-date-left"
                    ? 'Only one date left from this join date — the term ticket deactivates. Sell a single day ticket for the final session instead.'
                    : 'No remaining dates from this join date — nothing to book.') +
                '</div>'
              : '') +
          '</div>';
        if ($quote) $quote.innerHTML = html;
      }

      function onChange() { refreshJoinOptions(); refreshQuote(); }

      if ($price) $price.addEventListener("input", refreshQuote);
      if ($scope) $scope.addEventListener("change", onChange);
      if ($join) $join.addEventListener("change", refreshQuote);

      var $saveBtn = controls.querySelector("#ttSaveBtn");
      if ($saveBtn) {
        $saveBtn.addEventListener("click", function () {
          var res = saveConfig(pid, {
            pricePerSession: $price ? $price.value : startPrice,
            scope: $scope ? $scope.value : "full"
          });
          if (res.ok) {
            if ($saveMsg) $saveMsg.textContent = "Saved — term ticket live at " +
              HC.util.money(res.config.pricePerSession) + "/session (" + res.config.scope + ").";
            HC.util.toast("Term ticket saved");
          } else if ($saveMsg) {
            $saveMsg.textContent = "Could not save: " + res.error;
          }
        });
      }

      refreshJoinOptions();
      refreshQuote();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Term ticket preview failed: ' +
          escapeHtml(e && e.message ? e.message : String(e)) + "</p>";
      } catch (_) { /* swallow */ }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ============================================================
     selfTest() — exercises the LOGIC and asserts acceptance
     ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A clean 3-week synthetic season: Mon 27 Jul, Mon 3 Aug, Mon 10 Aug,
    // each Mon–Fri = 15 weekday sessions.
    var weeks = [
      { mon: "2026-07-27", days: 5 },
      { mon: "2026-08-03", days: 5 },
      { mon: "2026-08-10", days: 5 }
    ];

    // ===== buildTerm enumerates the season correctly =====
    check("buildTerm yields 15 ordered weekday sessions for a 3-week season", function () {
      var t = buildTerm(weeks);
      HC.assert(t.length === 15, "expected 15 sessions, got " + t.length);
      HC.assert(t[0] === "2026-07-27", "first session should be Mon 27 Jul, got " + t[0]);
      HC.assert(t[14] === "2026-08-14", "last session should be Fri 14 Aug, got " + t[14]);
      // strictly ascending + all weekdays
      for (var i = 1; i < t.length; i++) {
        HC.assert(t[i] > t[i - 1], "dates must be strictly ascending at " + i);
      }
      for (var j = 0; j < t.length; j++) {
        HC.assert(isWeekday(t[j]), t[j] + " should be a weekday (no weekend camp days)");
      }
    });

    var term = buildTerm(weeks);

    // ===== ACCEPTANCE 1: a term ticket from the start books ALL dates =====
    check("ACCEPTANCE: start-of-term ticket books ALL remaining dates", function () {
      var q = quoteTermTicket(term, 40, term[0]);
      HC.assert(q.active === true, "term ticket should be active at the start");
      HC.assert(q.remainingCount === term.length,
        "should book all " + term.length + " dates, booked " + q.remainingCount);
      // the booked set is EXACTLY the term, in order
      HC.assert(q.remainingDates.length === term.length, "remainingDates length mismatch");
      for (var i = 0; i < term.length; i++) {
        HC.assert(q.remainingDates[i] === term[i], "date mismatch at " + i);
      }
      // priced at pricePerSession × N
      HC.assert(q.total === gbp(40 * term.length),
        "full-term total should be 40 × " + term.length + " = " + (40 * term.length) + ", got " + q.total);
    });

    // ===== ACCEPTANCE 1b: default (no join date) books the WHOLE term =====
    check("ACCEPTANCE: omitting join date books the whole term", function () {
      var q = quoteTermTicket(term, 40, null);
      HC.assert(q.joinDate === term[0], "default join should be the first session");
      HC.assert(q.remainingCount === term.length, "default booking should cover the whole term");
    });

    // ===== ACCEPTANCE 2: mid-term joiner is auto-priced PRO-RATA =====
    check("ACCEPTANCE: mid-term joiner books only remaining dates, pro-rata priced", function () {
      // Join on the Mon of week 2 (2026-08-03). 10 sessions remain (weeks 2+3).
      var join = "2026-08-03";
      var q = quoteTermTicket(term, 40, join);
      HC.assert(q.active === true, "mid-term ticket should still be active (10 dates remain)");
      HC.assert(q.remainingCount === 10, "expected 10 remaining sessions, got " + q.remainingCount);
      // every booked date is on/after the join date — never a past date
      for (var i = 0; i < q.remainingDates.length; i++) {
        HC.assert(q.remainingDates[i] >= join,
          "joiner must not be booked onto past date " + q.remainingDates[i]);
      }
      HC.assert(q.remainingDates[0] === join, "first booked date should be the join date");
      // pro-rata price = 40 × 10 = 400, strictly less than the full-term 600
      HC.assert(q.total === gbp(40 * 10), "pro-rata total should be 400, got " + q.total);
      HC.assert(q.total < q.fullTermTotal, "joiner must pay less than a full-term booker");
      HC.assert(q.saving === gbp(q.fullTermTotal - q.total),
        "saving should reconcile (" + q.fullTermTotal + " - " + q.total + ")");
    });

    // ===== ACCEPTANCE 2b: a LATE joiner pays even less (monotonic pro-rata) =====
    check("ACCEPTANCE: later join date => fewer dates => lower pro-rata price", function () {
      var early = quoteTermTicket(term, 40, "2026-07-29"); // Wed wk1
      var late = quoteTermTicket(term, 40, "2026-08-06");  // Thu wk2
      HC.assert(late.remainingCount < early.remainingCount,
        "later joiner should have fewer remaining dates");
      HC.assert(late.total < early.total,
        "later joiner should pay a lower pro-rata total");
      // and the price is always exactly per-session × count
      HC.assert(early.total === gbp(40 * early.remainingCount), "early total must be linear in count");
      HC.assert(late.total === gbp(40 * late.remainingCount), "late total must be linear in count");
    });

    // ===== ACCEPTANCE 2c: non-camp-day join snaps forward to the next session =====
    check("Joining on a weekend snaps to the next real camp day", function () {
      // Sat 1 Aug is between wk1 and wk2; remaining = all of wk2 + wk3 = 10.
      var q = quoteTermTicket(term, 40, "2026-08-01");
      HC.assert(q.remainingCount === 10, "weekend join should pick up next 10 sessions, got " + q.remainingCount);
      HC.assert(q.remainingDates[0] === "2026-08-03", "next session after Sat 1 Aug should be Mon 3 Aug");
    });

    // ===== fractional / real price stays pence-exact (£48.30 case) =====
    check("Pro-rata maths is pence-exact for a real fee (£48.30 × 3)", function () {
      var threeDays = ["2026-08-10", "2026-08-11", "2026-08-12"];
      var q = quoteTermTicket(threeDays, 48.30, "2026-08-10");
      HC.assert(q.total === 144.9, "48.30 × 3 should be exactly 144.9, got " + q.total);
    });

    // ===== one-date-left rule deactivates the term ticket =====
    check("Term ticket DEACTIVATES when only one date remains", function () {
      // Join on the very last session: only 1 date >= join.
      var last = term[term.length - 1];
      var q = quoteTermTicket(term, 40, last);
      HC.assert(q.active === false, "single remaining date must deactivate the term ticket");
      HC.assert(q.reason === "one-date-left", "reason should be one-date-left, got " + q.reason);
      HC.assert(q.total === 0, "deactivated ticket has no term price");
    });

    check("A two-date tail is still bookable as a term ticket", function () {
      var twoLeft = quoteTermTicket(term, 40, term[term.length - 2]);
      HC.assert(twoLeft.active === true, "two remaining dates should still allow a term ticket");
      HC.assert(twoLeft.remainingCount === 2, "expected exactly 2 remaining, got " + twoLeft.remainingCount);
      HC.assert(twoLeft.total === gbp(80), "two-date tail at £40 = £80, got " + twoLeft.total);
    });

    check("Joining after the term ends books nothing (no negative price)", function () {
      var q = quoteTermTicket(term, 40, "2026-09-01");
      HC.assert(q.active === false, "no dates after term end");
      HC.assert(q.remainingCount === 0, "expected 0 remaining");
      HC.assert(q.reason === "no-dates-left", "reason should be no-dates-left");
      HC.assert(q.total === 0, "no booking => no price");
    });

    // ===== full vs half term scopes (Happity full/half split) =====
    check("Half-term scopes partition the full term without overlap or gaps", function () {
      var parts = splitTerm(term);
      HC.assert(parts.full.length === 15, "full should be 15");
      HC.assert(parts.first.length + parts.second.length === parts.full.length,
        "halves must sum to the full term");
      // no overlap
      for (var i = 0; i < parts.second.length; i++) {
        HC.assert(parts.first.indexOf(parts.second[i]) === -1,
          "halves must not overlap on " + parts.second[i]);
      }
      // a first-half term ticket only books first-half dates
      var q = quoteTermTicket(parts.first, 40, parts.first[0]);
      HC.assert(q.remainingCount === parts.first.length, "first-half ticket books all first-half dates");
      HC.assert(q.remainingDates[q.remainingDates.length - 1] <= parts.first[parts.first.length - 1],
        "first-half ticket must not reach into the second half");
    });

    // ===== persistence via HC.store (round-trip + validation) =====
    var TP = "selftest-term-ticket-provider";
    check("saveConfig persists via HC.store and round-trips", function () {
      clearConfig(TP);
      var res = saveConfig(TP, { pricePerSession: 42.5, scope: "first" });
      HC.assert(res.ok === true, "valid config should save");
      var back = getConfig(TP);
      HC.assert(back && back.pricePerSession === 42.5, "price should persist as 42.5");
      HC.assert(back.scope === "first", "scope should persist as first");
    });

    check("saveConfig rejects junk and never persists it", function () {
      clearConfig(TP);
      var bad = [null, undefined, {}, { pricePerSession: -1 }, { pricePerSession: "abc" }, 7, "x"];
      for (var i = 0; i < bad.length; i++) {
        var r = saveConfig(TP, bad[i]);
        HC.assert(r.ok === false, "junk config #" + i + " must be rejected");
      }
      HC.assert(getConfig(TP) === null, "rejected configs must not persist");
    });

    // ===== defensive: garbage inputs to the calculator never throw =====
    check("quoteTermTicket tolerates garbage without throwing", function () {
      var junk = [null, undefined, 42, "x", {}, [null, "", "not-a-date"]];
      for (var i = 0; i < junk.length; i++) {
        var q = quoteTermTicket(junk[i], junk[i], junk[i]);
        HC.assert(q && typeof q === "object", "should always return a quote object for input #" + i);
        HC.assert(q.active === false, "garbage input should yield an inactive quote");
        HC.assert(q.total === 0, "garbage input should price at 0");
      }
    });

    // ===== integration with live planner data (if present) =====
    check("Live planner data builds a real multi-day term for a provider", function () {
      var providers = HC.data.providers || [];
      var found = null;
      for (var i = 0; i < providers.length; i++) {
        var pid = providers[i].id || providers[i].slug;
        var t = buildTerm(weeksForProvider(pid));
        if (t.length >= 2) { found = { pid: pid, term: t }; break; }
      }
      // Only assert if the live data is loaded (node --check / harness without
      // app.js won't have it). Treat absence as a pass-through, not a failure.
      if (!found) {
        HC.assert(providers.length === 0,
          "providers loaded but none had a 2+ day term — data shape changed");
        return;
      }
      var q = quoteTermTicket(found.term, defaultPrice(found.pid), found.term[0]);
      HC.assert(q.active === true, "a real provider term should produce an active ticket");
      HC.assert(q.remainingCount === found.term.length,
        "live term ticket should book every confirmed camp day");
      HC.assert(q.total === gbp(q.pricePerSession * found.term.length),
        "live term total must equal price-per-session × days");
    });

    clearConfig(TP);
    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
     register
     ============================================================ */

  HC.registerFeature({
    id: "provider-ticket-term",
    title: "Term tickets + pro-rata calculator",
    side: "provider",
    icon: "🎫",
    summary: "Sell one 'whole-season' term ticket that books a family into every remaining camp day at once. Set a single price-per-session and the automatic pro-rata calculator charges mid-season joiners only for the days they have left.",
    render: render,
    selfTest: selfTest
  });
})();
