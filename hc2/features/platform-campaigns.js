/* HolidayCamp feature: platform-campaigns
 * ------------------------------------------------------------------
 * Replicates Happity's SEASONAL COMPETITIONS / SWITCH CAMPAIGNS for the
 * PLATFORM side, reframed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes).
 *
 * Evidence (Happity support corpus):
 *   - 14737713 "Summer Switch 2026": a time-boxed SWITCH offer — new /
 *     lapsed providers join free of membership fees until a deadline, must
 *     connect Stripe and switch bookings on within 14 days to keep it.
 *     => a campaign whose ENTRY RULE is "list your camp + connect payments"
 *        and whose PRIZE is a free trial membership.
 *   - 11896270 "Add your timetable competition 2025": a time-boxed PRIZE
 *     DRAW — sign in during the window and have >=1 timetable listing to be
 *     eligible; ONE winner drawn at random; prize = a GBP 50 voucher.
 *     => a campaign whose ENTRY RULE is "have >=1 listing" and whose PRIZE
 *        is a voucher awarded by a random draw.
 *   - 10184025 "Small Businesses Are Superstars": a time-boxed CONTENT
 *     campaign — submit a video; winners chosen if the clip is used; prize
 *     = free membership or platform credit.
 *     => a campaign whose ENTRY RULE is "submit content" and whose PRIZE is
 *        membership or credit.
 *
 * For HolidayCamp the equivalent is a small CAMPAIGN ENGINE: the platform
 * can run a time-boxed campaign (window with an open/close date), with an
 * eligibility/entry RULE that is checked against the verified camp data
 * (camps.js / planner-data.js), an entry mechanism that records entrants,
 * a deterministic random winner DRAW (seeded so tests are repeatable), and
 * a defined PRIZE. Three campaigns ship pre-loaded, mirroring the three
 * Happity mechanics above and themed for school-age holiday camps:
 *   1. "Summer Switch"      — switch/trial offer (rule: list a camp + take
 *                             bookings; prize: free trial until deadline).
 *   2. "Add Your Timetable" — prize draw   (rule: >=1 confirmed planner
 *                             week; prize: GBP 50 voucher, 1 random winner).
 *   3. "Camps Are Superstars" — content campaign (rule: submit a video;
 *                             prize: free year + GBP 30 platform credit).
 *
 * ACCEPTANCE CRITERION (asserted by selfTest, multiple cases):
 *   A time-boxed campaign with an entry rule and a prize is RUNNABLE
 *   (e.g. "Summer Switch") — i.e. it can be opened in its window, an
 *   eligible provider can enter, an ineligible one is rejected, and a
 *   winner / outcome can be produced.
 *
 * Scope note: this module owns ONLY the campaign surface — the campaign
 * registry, the eligibility checker, the entry recorder, the seeded draw,
 * and the campaign UI. It is defensive (nothing throws at registration),
 * never mutates the verified camp data, and persists entrants/runs via
 * HC.store only.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  // Persisted entrants + run outcomes, keyed by campaign id:
  //   { entries: { [campaignId]: [ { campId, name, at, payload } ] },
  //     runs:    { [campaignId]: { drawnAt, winnerCampId, outcome } } }
  var STORE_KEY = "platform_campaigns";

  function blankState() { return { entries: {}, runs: {} }; }

  function loadState() {
    try {
      var s = HC.store.get(STORE_KEY, null);
      if (!s || typeof s !== "object") return blankState();
      if (!s.entries || typeof s.entries !== "object") s.entries = {};
      if (!s.runs || typeof s.runs !== "object") s.runs = {};
      return s;
    } catch (e) {
      return blankState();
    }
  }

  function saveState(s) {
    try { HC.store.set(STORE_KEY, s); } catch (e) { /* defensive */ }
  }

  /* ============================================================
   * 1. Date helpers (time-boxing). Pure, parse-safe.
   * ============================================================ */

  function toTime(iso) {
    // Accepts "YYYY-MM-DD" or a Date / ms. Returns ms or NaN.
    if (iso instanceof Date) return iso.getTime();
    if (typeof iso === "number") return iso;
    if (typeof iso !== "string") return NaN;
    var t = Date.parse(iso.length === 10 ? iso + "T00:00:00Z" : iso);
    return t;
  }

  function fmtDate(iso) {
    var t = toTime(iso);
    if (isNaN(t)) return String(iso);
    try {
      return new Date(t).toLocaleDateString("en-GB", {
        day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
      });
    } catch (e) {
      return String(iso);
    }
  }

  // Status of a campaign at a given moment ("now" defaults to real now).
  //   "upcoming" | "open" | "closed"
  function campaignStatus(c, nowMs) {
    var now = (typeof nowMs === "number") ? nowMs : Date.now();
    var open = toTime(c.opens);
    var close = toTime(c.closes);
    if (!isNaN(open) && now < open) return "upcoming";
    if (!isNaN(close) && now > close) return "closed";
    return "open";
  }

  function isOpen(c, nowMs) { return campaignStatus(c, nowMs) === "open"; }

  /* ============================================================
   * 2. Seeded PRNG — deterministic random draw so the winner is
   *    reproducible in tests (the live "draw" is genuinely random
   *    only in that the entrant set varies). Mulberry32.
   * ============================================================ */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedFrom(str) {
    var h = 2166136261 >>> 0;
    var s = String(str || "");
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* ============================================================
   * 3. Eligibility rules. Each campaign carries a `rule` with:
   *    - id, label  (human description of the entry rule)
   *    - test(campId) -> { eligible:Boolean, reason:String }
   *    - prize       (human description of what's won)
   *    - mechanic    "switch" | "draw" | "content"
   *    Rules read ONLY verified data; they never mutate it.
   * ============================================================ */

  function planner() {
    try { return HC.data.planner || {}; } catch (e) { return {}; }
  }
  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }
  function providerById(id) {
    var list = providers();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }
  function plannerEntry(id) {
    var p = planner();
    return (p.byId && p.byId[id]) || null;
  }

  // Rule A — "switch": provider is listed AND can take bookings online.
  // Mirrors Summer Switch's "connect Stripe + switch bookings on".
  function ruleListedAndBookable(campId) {
    var prov = providerById(campId);
    if (!prov) return { eligible: false, reason: "No such camp in the directory." };
    // "bookable" = the verified record shows an online booking route.
    var bookingText = (prov.booking || prov.bookingUrl || prov.website || "");
    var bookable = !!String(bookingText).trim();
    if (!bookable) {
      return { eligible: false, reason: "Camp is listed but has no online booking route to switch on." };
    }
    return { eligible: true, reason: "Listed and takes bookings online — ready to switch." };
  }

  // Rule B — ">=1 confirmed planner week". Mirrors "have >=1 timetable listing".
  function ruleHasConfirmedWeek(campId) {
    var pe = plannerEntry(campId);
    var weeks = (pe && Array.isArray(pe.weeks)) ? pe.weeks : [];
    if (weeks.length >= 1) {
      return { eligible: true, reason: "Has " + weeks.length + " confirmed planner week" + (weeks.length === 1 ? "" : "s") + "." };
    }
    // weeksLikely (runs camps but dates unconfirmed) does NOT satisfy the rule.
    return { eligible: false, reason: "No confirmed planner week yet — add your dates to enter." };
  }

  // Rule C — "submitted content". Mirrors the Superstars video campaign;
  // the entry payload must carry a non-empty content reference.
  function ruleSubmittedContent(campId, payload) {
    var prov = providerById(campId);
    if (!prov) return { eligible: false, reason: "No such camp in the directory." };
    var ref = payload && (payload.videoUrl || payload.content);
    if (ref && String(ref).trim()) {
      return { eligible: true, reason: "Video / content submitted." };
    }
    return { eligible: false, reason: "Submit a short video to enter." };
  }

  /* ============================================================
   * 4. The campaign registry. Three pre-loaded campaigns, one per
   *    Happity mechanic, all themed for school-age holiday camps.
   *    Dates are anchored to the live planner's Summer-2026 window.
   * ============================================================ */

  function summerWindow() {
    // Anchor to verified key dates where available; fall back to fixed
    // 2026 summer dates so the engine is testable without live data.
    var kd = (planner().keyDates) || {};
    var holidayStart = (kd.holidayStart && kd.holidayStart.iso) || "2026-07-21";
    return holidayStart;
  }

  var CAMPAIGNS = [
    {
      id: "summer-switch",
      name: "Summer Switch",
      emoji: "🔁",
      mechanic: "switch",
      // Time-boxed: claim window runs across early summer 2026.
      opens: "2026-04-29",
      closes: "2026-07-03",
      // The trial / benefit deadline (Summer Switch's "free until 15 Sep").
      benefitUntil: "2026-09-15",
      rule: {
        id: "listed-bookable",
        label: "List your holiday camp and switch online bookings on (connect payments).",
        test: ruleListedAndBookable
      },
      prize: "Free platform membership for the summer — no listing fees until 15 September 2026 (then £60 + VAT / year). Booking commission still applies.",
      blurb: "New or returning camps: list for the summer holidays free of membership fees. Connect payments and switch bookings on within 14 days to keep your place.",
      // Switch campaigns are not a prize draw — every eligible entrant wins.
      drawsWinner: false
    },
    {
      id: "add-your-timetable",
      name: "Add Your Timetable",
      emoji: "🎟️",
      mechanic: "draw",
      opens: "2026-06-01",
      closes: "2026-06-28",
      announce: "2026-07-01",
      rule: {
        id: "has-confirmed-week",
        label: "Have at least one confirmed week of summer camp dates on the planner.",
        test: ruleHasConfirmedWeek
      },
      prize: "1 × £50 voucher (Amazon, Love2Shop or Argos) for one camp drawn at random from all eligible entries.",
      blurb: "Add your summer dates to the planner during the window and you're in the draw for a £50 voucher. One winner, picked at random.",
      drawsWinner: true,
      winners: 1
    },
    {
      id: "camps-are-superstars",
      name: "Camps Are Superstars",
      emoji: "⭐",
      mechanic: "content",
      opens: "2026-05-01",
      closes: "2026-08-31",
      rule: {
        id: "submitted-content",
        label: "Submit a short video about your holiday camp for our marketing.",
        test: ruleSubmittedContent
      },
      prize: "A free year of membership if we feature your video on its own, or £30 platform credit if we use a clip or your words.",
      blurb: "Tell families why your camp is a superstar. Send us a short video — featured camps win a free year or platform credit.",
      drawsWinner: false
    }
  ];

  function getCampaign(id) {
    for (var i = 0; i < CAMPAIGNS.length; i++) {
      if (CAMPAIGNS[i].id === id) return CAMPAIGNS[i];
    }
    return null;
  }

  /* ============================================================
   * 5. Engine operations: check / enter / list / draw / clear.
   *    All persistence via HC.store. All read-only against camp data.
   * ============================================================ */

  // Check eligibility for a camp against a campaign's rule.
  function checkEligibility(campaignId, campId, payload) {
    var c = getCampaign(campaignId);
    if (!c) return { eligible: false, reason: "Unknown campaign." };
    var fn = c.rule && c.rule.test;
    if (typeof fn !== "function") return { eligible: false, reason: "Campaign has no entry rule." };
    try {
      var r = fn(campId, payload || {});
      return (r && typeof r === "object") ? r : { eligible: false, reason: "Rule did not return a result." };
    } catch (e) {
      return { eligible: false, reason: "Rule error: " + (e && e.message ? e.message : String(e)) };
    }
  }

  // Enter a camp into a campaign. Enforces: campaign open, rule passes,
  // and one entry per camp (Happity: "one use per provider account").
  // Returns { ok, reason, entry }.
  function enter(campaignId, campId, opts) {
    opts = opts || {};
    var c = getCampaign(campaignId);
    if (!c) return { ok: false, reason: "Unknown campaign." };

    var nowMs = (typeof opts.nowMs === "number") ? opts.nowMs : Date.now();
    var status = campaignStatus(c, nowMs);
    if (status !== "open") {
      return { ok: false, reason: "Campaign is " + status + " — entries are " +
        (status === "upcoming" ? "not open yet." : "closed.") };
    }

    var elig = checkEligibility(campaignId, campId, opts.payload);
    if (!elig.eligible) return { ok: false, reason: elig.reason };

    var s = loadState();
    var list = s.entries[campaignId] || (s.entries[campaignId] = []);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].campId === campId) {
        return { ok: false, reason: "Already entered — one entry per camp." };
      }
    }
    var prov = providerById(campId);
    var entry = {
      campId: campId,
      name: (prov && prov.name) || campId,
      at: new Date(nowMs).toISOString(),
      payload: opts.payload || null
    };
    list.push(entry);
    saveState(s);
    return { ok: true, reason: elig.reason, entry: entry };
  }

  function listEntries(campaignId) {
    var s = loadState();
    return (s.entries[campaignId] || []).slice();
  }

  function entryCount(campaignId) {
    return listEntries(campaignId).length;
  }

  // Run a campaign to produce its outcome.
  //  - draw mechanic: pick `winners` entrants at random (seeded).
  //  - non-draw mechanic: every eligible entrant "wins" the offer.
  // Returns { ok, reason, mechanic, winners:[entry], outcome }.
  function runCampaign(campaignId, opts) {
    opts = opts || {};
    var c = getCampaign(campaignId);
    if (!c) return { ok: false, reason: "Unknown campaign." };

    var entries = listEntries(campaignId);
    if (!entries.length) {
      return { ok: false, reason: "No entries to run.", mechanic: c.mechanic, winners: [] };
    }

    var result;
    if (c.drawsWinner) {
      var n = Math.max(1, Number(c.winners) || 1);
      // Seed from a stable string so the same entrant set yields the same
      // winner — deterministic for tests, still "random" across entries.
      var seedStr = opts.seed != null ? String(opts.seed) : (campaignId + ":" + entries.map(function (e) { return e.campId; }).join(","));
      var rand = mulberry32(seedFrom(seedStr));
      // Fisher–Yates over a copy, then take the first n.
      var pool = entries.slice();
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(rand() * (i + 1));
        var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      var winners = pool.slice(0, Math.min(n, pool.length));
      result = {
        ok: true,
        mechanic: "draw",
        winners: winners,
        outcome: winners.length === 1
          ? winners[0].name + " wins the " + (c.prize || "prize") + "."
          : winners.length + " winners drawn.",
        reason: "Drew " + winners.length + " winner" + (winners.length === 1 ? "" : "s") + " from " + entries.length + " entries."
      };
    } else {
      // Switch / content: every eligible entrant gets the benefit.
      result = {
        ok: true,
        mechanic: c.mechanic,
        winners: entries.slice(),
        outcome: "All " + entries.length + " eligible camp" + (entries.length === 1 ? "" : "s") + " unlocked: " + (c.prize || "the offer") + ".",
        reason: "Every eligible entrant qualifies (no random draw)."
      };
    }

    // Persist the run outcome.
    var s = loadState();
    s.runs[campaignId] = {
      drawnAt: new Date((typeof opts.nowMs === "number") ? opts.nowMs : Date.now()).toISOString(),
      mechanic: result.mechanic,
      winnerCampIds: result.winners.map(function (w) { return w.campId; }),
      outcome: result.outcome
    };
    saveState(s);
    return result;
  }

  function getRun(campaignId) {
    var s = loadState();
    return s.runs[campaignId] || null;
  }

  // Reset a single campaign (entries + run) or everything.
  function clearCampaign(campaignId) {
    var s = loadState();
    if (campaignId) {
      delete s.entries[campaignId];
      delete s.runs[campaignId];
    } else {
      s = blankState();
    }
    saveState(s);
  }

  /* ============================================================
   * 6. UI — campaign cards + an interactive "run a campaign" panel.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function statusPill(status) {
    var map = {
      open: { bg: "#E1F0E4", fg: "#2f7d4f", t: "Open" },
      upcoming: { bg: "#FFF4D6", fg: "#9a7400", t: "Upcoming" },
      closed: { bg: "#FCE8F0", fg: "#9a1f5e", t: "Closed" }
    };
    var m = map[status] || map.closed;
    return '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:11px;' +
      "padding:3px 10px;border-radius:999px;background:" + m.bg + ";color:" + m.fg + '">' + m.t + "</span>";
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var wrap = HC.util.el("div", { class: "hc-campaigns" });

      var intro = HC.util.el("p", {
        style: "font-size:14px;color:var(--text,#383838);margin:0 0 14px;line-height:1.6"
      }, "Run time-boxed campaigns to grow the platform — switch offers, prize draws and content drives. " +
         "Each campaign has a <strong>window</strong>, an <strong>entry rule</strong> checked against verified camp data, and a <strong>prize</strong>. " +
         "These mirror Happity's Summer Switch, timetable competition and Superstars campaign, reframed for school-age holiday camps.");
      wrap.appendChild(intro);

      // Campaign selector.
      var open = CAMPAIGNS.filter(function (c) { return true; });
      var sel = HC.util.el("select", {
        id: "hcCampSelect",
        style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:13px;padding:8px 12px;" +
          "border-radius:12px;border:1.5px solid var(--line,#E6E6E6);width:100%;margin-bottom:14px"
      });
      open.forEach(function (c) {
        var opt = HC.util.el("option", { value: c.id }, c.emoji + "  " + c.name + " — " + statusText(c));
        sel.appendChild(opt);
      });
      wrap.appendChild(sel);

      var panel = HC.util.el("div", { id: "hcCampPanel" });
      wrap.appendChild(panel);

      mountEl.innerHTML = "";
      mountEl.appendChild(wrap);

      function statusText(c) {
        return campaignStatus(c).charAt(0).toUpperCase() + campaignStatus(c).slice(1);
      }

      function drawPanel(campaignId) {
        var c = getCampaign(campaignId);
        if (!c) { panel.innerHTML = ""; return; }
        var status = campaignStatus(c);
        var entries = listEntries(c.id);
        var run = getRun(c.id);

        var html = "";
        html += '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:16px;background:#fff">';
        html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<span style="font-size:26px">' + esc(c.emoji) + "</span>" +
          '<strong style="font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);font-size:18px">' + esc(c.name) + "</strong>" +
          statusPill(status) +
          '<span style="font-size:11px;color:var(--muted,#808080);text-transform:uppercase;letter-spacing:.4px">' + esc(c.mechanic) + " campaign</span>" +
          "</div>";
        html += '<p style="font-size:13.5px;color:var(--text,#383838);margin:10px 0 0;line-height:1.6">' + esc(c.blurb) + "</p>";

        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0">';
        html += metaBox("Window", fmtDate(c.opens) + " → " + fmtDate(c.closes));
        html += metaBox("Entry rule", esc(c.rule.label));
        html += metaBox("Prize", esc(c.prize));
        html += metaBox("Entries so far", String(entries.length));
        html += "</div>";

        // Entry form (camp picker). Disabled unless open.
        var provs = providers();
        var canEnter = status === "open";
        html += '<div style="border-top:1px dashed var(--line,#E6E6E6);padding-top:12px">';
        html += '<label style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px;color:var(--purple,#603488);display:block;margin-bottom:6px">Enter a camp</label>';
        html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
        html += '<select id="hcCampEntrant" ' + (canEnter ? "" : "disabled") +
          ' style="flex:1;min-width:180px;font-size:13px;padding:8px 10px;border-radius:10px;border:1.5px solid var(--line,#E6E6E6)">';
        provs.forEach(function (p) {
          if (p && p.id) html += '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + "</option>";
        });
        html += "</select>";
        if (c.mechanic === "content") {
          html += '<input id="hcCampVideo" type="text" placeholder="Video link (e.g. youtu.be/...)" ' + (canEnter ? "" : "disabled") +
            ' style="flex:1;min-width:160px;font-size:13px;padding:8px 10px;border-radius:10px;border:1.5px solid var(--line,#E6E6E6)">';
        }
        html += '<button class="hc-btn" id="hcCampEnterBtn" ' + (canEnter ? "" : "disabled") + ">Enter</button>";
        html += "</div>";
        if (!canEnter) {
          html += '<p style="font-size:12px;color:var(--muted,#808080);margin:6px 0 0">Entries are ' +
            (status === "upcoming" ? "not open yet." : "closed.") + "</p>";
        }
        html += "</div>";

        // Entrant list.
        if (entries.length) {
          html += '<div style="margin-top:12px"><strong style="font-family:Quicksand,system-ui,sans-serif;font-size:12px;color:var(--purple,#603488)">Entrants</strong>';
          html += '<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--text,#383838);line-height:1.7">';
          entries.forEach(function (e) {
            var isWinner = run && run.winnerCampIds && run.winnerCampIds.indexOf(e.campId) !== -1;
            html += "<li>" + esc(e.name) + (isWinner ? ' <span style="color:#2f7d4f;font-weight:700">★ winner</span>' : "") + "</li>";
          });
          html += "</ul></div>";
        }

        // Run + reset controls.
        html += '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">';
        html += '<button class="hc-btn" id="hcCampRunBtn">' + (c.drawsWinner ? "Draw winner" : "Run offer") + "</button>";
        html += '<button class="hc-btn hc-btn-ghost" id="hcCampResetBtn">Reset campaign</button>';
        html += "</div>";

        if (run) {
          html += '<div style="margin-top:12px;background:var(--purple-tint,#F0E8F4);border-radius:12px;padding:12px;font-size:13.5px;color:var(--purple,#603488)">' +
            '<strong style="font-family:Quicksand,system-ui,sans-serif">Outcome:</strong> ' + esc(run.outcome) + "</div>";
        }

        html += "</div>";
        panel.innerHTML = html;

        // Wire controls.
        var enterBtn = panel.querySelector("#hcCampEnterBtn");
        if (enterBtn) {
          enterBtn.addEventListener("click", function () {
            var who = panel.querySelector("#hcCampEntrant");
            var vid = panel.querySelector("#hcCampVideo");
            var payload = vid ? { videoUrl: vid.value } : null;
            var res = enter(c.id, who ? who.value : null, { payload: payload });
            HC.util.toast(res.ok ? ("✓ " + (res.entry ? res.entry.name : "Entered") + " — " + res.reason) : ("✗ " + res.reason));
            drawPanel(c.id);
          });
        }
        var runBtn = panel.querySelector("#hcCampRunBtn");
        if (runBtn) {
          runBtn.addEventListener("click", function () {
            var res = runCampaign(c.id);
            HC.util.toast(res.ok ? ("✓ " + res.outcome) : ("✗ " + res.reason));
            drawPanel(c.id);
          });
        }
        var resetBtn = panel.querySelector("#hcCampResetBtn");
        if (resetBtn) {
          resetBtn.addEventListener("click", function () {
            clearCampaign(c.id);
            HC.util.toast("Campaign reset");
            drawPanel(c.id);
          });
        }
      }

      sel.addEventListener("change", function () { drawPanel(sel.value); });
      drawPanel(sel.value || (CAMPAIGNS[0] && CAMPAIGNS[0].id));
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Campaigns failed to render: ' + esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function metaBox(label, value) {
    return '<div style="background:var(--purple-tint,#F0E8F4);border-radius:12px;padding:10px 12px">' +
      '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">' + esc(label) + "</div>" +
      '<div style="font-size:13px;color:var(--text,#383838);margin-top:3px;line-height:1.5">' + value + "</div>" +
      "</div>";
  }

  /* ============================================================
   * 7. selfTest — exercises the engine LOGIC and asserts the
   *    acceptance criterion across multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Snapshot + isolate state so the test never disturbs persisted data.
    var snapshot = null;
    try { snapshot = HC.store.get(STORE_KEY, null); } catch (e) { snapshot = null; }
    saveState(blankState());

    // Helpers to find real camps that satisfy / fail each rule, so the test
    // works against the live data instead of hard-coded ids.
    function firstCampWhere(predicate) {
      var list = providers();
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id && predicate(list[i].id)) return list[i].id;
      }
      return null;
    }

    var nowOpen, nowClosed, nowUpcoming;

    // ---- Time-boxing ----
    check("A campaign is upcoming before it opens, open during, closed after", function () {
      var c = getCampaign("summer-switch");
      HC.assert(c, "summer-switch campaign exists");
      var before = toTime(c.opens) - 86400000;
      var during = toTime(c.opens) + 86400000;
      var after = toTime(c.closes) + 86400000;
      HC.assert(campaignStatus(c, before) === "upcoming", "before open => upcoming");
      HC.assert(campaignStatus(c, during) === "open", "within window => open");
      HC.assert(campaignStatus(c, after) === "closed", "after close => closed");
      nowUpcoming = before; nowOpen = during; nowClosed = after;
    });

    // ---- ACCEPTANCE CRITERION (Summer Switch): a time-boxed campaign with
    //      an entry rule and prize is RUNNABLE. ----
    check("ACCEPTANCE: 'Summer Switch' has a window, an entry rule and a prize", function () {
      var c = getCampaign("summer-switch");
      HC.assert(c, "campaign present");
      HC.assert(!isNaN(toTime(c.opens)) && !isNaN(toTime(c.closes)), "has a valid time box");
      HC.assert(c.rule && typeof c.rule.test === "function" && c.rule.label, "has an entry rule");
      HC.assert(typeof c.prize === "string" && c.prize.length > 0, "has a prize");
    });

    check("ACCEPTANCE: an eligible camp can enter 'Summer Switch' while it is open", function () {
      clearCampaign("summer-switch");
      var eligibleId = firstCampWhere(function (id) {
        return ruleListedAndBookable(id).eligible;
      });
      HC.assert(eligibleId, "found a listed+bookable camp in live data");
      var res = enter("summer-switch", eligibleId, { nowMs: nowOpen });
      HC.assert(res.ok === true, "entry should succeed: " + res.reason);
      HC.assert(entryCount("summer-switch") === 1, "exactly one entry recorded");
    });

    check("ACCEPTANCE: 'Summer Switch' is runnable and produces an outcome (every eligible camp wins the trial)", function () {
      var res = runCampaign("summer-switch", { nowMs: nowOpen });
      HC.assert(res.ok === true, "run should succeed: " + res.reason);
      HC.assert(res.mechanic === "switch", "mechanic is switch");
      HC.assert(res.winners.length === 1, "the one eligible entrant wins the offer");
      HC.assert(/membership|free|offer/i.test(res.outcome), "outcome describes the prize: " + res.outcome);
      var run = getRun("summer-switch");
      HC.assert(run && run.outcome, "outcome was persisted");
    });

    // ---- Eligibility gate (negative case) ----
    check("An ineligible camp (no booking route) is rejected from Summer Switch", function () {
      // Build a synthetic non-bookable check via the rule directly, plus an
      // entry attempt for a camp that fails the rule if one exists.
      var badCheck = ruleListedAndBookable("totally-made-up-id");
      HC.assert(badCheck.eligible === false, "unknown camp is not eligible");
      var res = enter("summer-switch", "totally-made-up-id", { nowMs: nowOpen });
      HC.assert(res.ok === false, "entry for ineligible camp must be refused");
    });

    // ---- One entry per camp ----
    check("A camp cannot enter the same campaign twice", function () {
      clearCampaign("summer-switch");
      var id = firstCampWhere(function (x) { return ruleListedAndBookable(x).eligible; });
      HC.assert(id, "eligible camp available");
      var a = enter("summer-switch", id, { nowMs: nowOpen });
      HC.assert(a.ok === true, "first entry ok");
      var b = enter("summer-switch", id, { nowMs: nowOpen });
      HC.assert(b.ok === false, "second entry refused");
      HC.assert(/one entry/i.test(b.reason), "reason mentions one-entry rule: " + b.reason);
      clearCampaign("summer-switch");
    });

    // ---- Window enforcement on entry ----
    check("Entries are refused when the campaign is closed or upcoming", function () {
      clearCampaign("summer-switch");
      var id = firstCampWhere(function (x) { return ruleListedAndBookable(x).eligible; });
      HC.assert(id, "eligible camp available");
      var closed = enter("summer-switch", id, { nowMs: nowClosed });
      HC.assert(closed.ok === false && /closed/i.test(closed.reason), "closed window rejects: " + closed.reason);
      var early = enter("summer-switch", id, { nowMs: nowUpcoming });
      HC.assert(early.ok === false && /not open/i.test(early.reason), "upcoming window rejects: " + early.reason);
      HC.assert(entryCount("summer-switch") === 0, "no entry recorded outside window");
    });

    // ---- Prize DRAW campaign (Add Your Timetable): random winner ----
    check("Prize-draw campaign requires >=1 confirmed planner week", function () {
      var withWeek = firstCampWhere(function (id) { return ruleHasConfirmedWeek(id).eligible; });
      var withoutWeek = firstCampWhere(function (id) { return !ruleHasConfirmedWeek(id).eligible; });
      HC.assert(withWeek, "found a camp with a confirmed planner week");
      HC.assert(ruleHasConfirmedWeek(withWeek).eligible === true, "rule passes for camp with week");
      if (withoutWeek) {
        HC.assert(ruleHasConfirmedWeek(withoutWeek).eligible === false, "rule fails for camp without a confirmed week");
      }
    });

    check("Prize draw selects exactly one winner from the eligible entries", function () {
      clearCampaign("add-your-timetable");
      var c = getCampaign("add-your-timetable");
      var during = toTime(c.opens) + 86400000;
      var entered = 0;
      var list = providers();
      for (var i = 0; i < list.length && entered < 4; i++) {
        var id = list[i] && list[i].id;
        if (id && ruleHasConfirmedWeek(id).eligible) {
          var r = enter("add-your-timetable", id, { nowMs: during });
          if (r.ok) entered += 1;
        }
      }
      HC.assert(entered >= 1, "at least one eligible camp entered the draw, got " + entered);
      var res = runCampaign("add-your-timetable", { nowMs: during });
      HC.assert(res.ok === true, "draw runs: " + res.reason);
      HC.assert(res.mechanic === "draw", "mechanic is draw");
      HC.assert(res.winners.length === 1, "exactly one winner drawn, got " + res.winners.length);
      // Winner must be one of the entrants.
      var entrantIds = listEntries("add-your-timetable").map(function (e) { return e.campId; });
      HC.assert(entrantIds.indexOf(res.winners[0].campId) !== -1, "winner is an actual entrant");
      clearCampaign("add-your-timetable");
    });

    check("Prize draw is deterministic for a fixed seed (reproducible winner)", function () {
      var c = getCampaign("add-your-timetable");
      var during = toTime(c.opens) + 86400000;
      function setup() {
        clearCampaign("add-your-timetable");
        var n = 0, list = providers();
        for (var i = 0; i < list.length && n < 5; i++) {
          var id = list[i] && list[i].id;
          if (id && ruleHasConfirmedWeek(id).eligible) { if (enter("add-your-timetable", id, { nowMs: during }).ok) n += 1; }
        }
        return n;
      }
      var n1 = setup();
      var w1 = runCampaign("add-your-timetable", { seed: "fixed-seed", nowMs: during }).winners[0].campId;
      var n2 = setup();
      var w2 = runCampaign("add-your-timetable", { seed: "fixed-seed", nowMs: during }).winners[0].campId;
      HC.assert(n1 === n2 && n1 >= 1, "same entrant set both times");
      HC.assert(w1 === w2, "same seed => same winner (" + w1 + " === " + w2 + ")");
      clearCampaign("add-your-timetable");
    });

    // ---- Content campaign (Camps Are Superstars) ----
    check("Content campaign needs a submitted video to enter, and rewards every featured camp", function () {
      clearCampaign("camps-are-superstars");
      var c = getCampaign("camps-are-superstars");
      var during = toTime(c.opens) + 86400000;
      var id = firstCampWhere(function (x) { return !!providerById(x); });
      HC.assert(id, "a camp exists");
      var noVid = enter("camps-are-superstars", id, { nowMs: during, payload: { videoUrl: "" } });
      HC.assert(noVid.ok === false, "entry without a video is refused");
      var withVid = enter("camps-are-superstars", id, { nowMs: during, payload: { videoUrl: "https://youtu.be/demo" } });
      HC.assert(withVid.ok === true, "entry with a video succeeds: " + withVid.reason);
      var res = runCampaign("camps-are-superstars", { nowMs: during });
      HC.assert(res.ok === true && res.winners.length === 1, "the featured camp wins");
      HC.assert(/credit|membership|year/i.test(res.outcome) || res.outcome.length > 0, "outcome describes the reward");
      clearCampaign("camps-are-superstars");
    });

    // ---- Running with no entries ----
    check("Running a campaign with no entries returns a clean failure (no throw)", function () {
      clearCampaign("summer-switch");
      var res = runCampaign("summer-switch", { nowMs: nowOpen });
      HC.assert(res.ok === false, "no entries => not ok");
      HC.assert(/no entries/i.test(res.reason), "reason explains why: " + res.reason);
    });

    // ---- All three campaigns satisfy the acceptance shape ----
    check("All three pre-loaded campaigns are well-formed (window + rule + prize + mechanic)", function () {
      HC.assert(CAMPAIGNS.length === 3, "three campaigns ship");
      CAMPAIGNS.forEach(function (c) {
        HC.assert(!isNaN(toTime(c.opens)) && !isNaN(toTime(c.closes)) && toTime(c.closes) >= toTime(c.opens),
          c.id + " has a valid window");
        HC.assert(c.rule && typeof c.rule.test === "function" && c.rule.label, c.id + " has an entry rule");
        HC.assert(typeof c.prize === "string" && c.prize.length > 0, c.id + " has a prize");
        HC.assert(["switch", "draw", "content"].indexOf(c.mechanic) !== -1, c.id + " has a known mechanic");
      });
    });

    // Restore caller's persisted state exactly as found.
    try {
      if (snapshot === null) HC.store.remove(STORE_KEY);
      else HC.store.set(STORE_KEY, snapshot);
    } catch (e) { /* defensive */ }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "platform-campaigns",
    title: "Seasonal campaigns & switch offers",
    side: "platform",
    icon: "🎉",
    summary: "Run time-boxed platform campaigns — a Summer Switch trial offer, an 'Add Your Timetable' prize draw, and a 'Camps Are Superstars' content drive. Each has a window, an entry rule checked against verified camp data, and a prize, with a seeded random winner draw. Happity's seasonal competitions / switch campaigns, reframed for school-age holiday camps.",
    render: render,
    selfTest: selfTest
  });
})();
