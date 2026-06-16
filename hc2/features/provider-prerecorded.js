/* HolidayCamp feature — provider-prerecorded
 *
 * List pre-recorded sessions  (provider side)
 *
 * Replicates the Happity "pre-recorded sessions" topic — but DIVERGES from it.
 * Evidence (support article 5827852, "Can I list my pre-recorded sessions on
 * Happity?"):
 *   "Unfortunately it is not possible to list pre-recorded sessions on Happity,
 *    as they do not work with the way we are set up. We list classes according
 *    to the time and day they are happening. Our mission is to end loneliness in
 *    new parents so in person or interactive sessions are at the heart of our
 *    mission."
 *
 * Happity is a LIVE-only timetable: it has no concept of on-demand content, so
 * it bounces this request. HolidayCamp serves SCHOOL-AGE families who want
 * rainy-day / at-home / can't-make-the-week content (a recorded craft class, a
 * coding tutorial, a holiday-themed PE session), so it DOES support an
 * on-demand catalogue. This module is the provider-side feature that lets a
 * provider LIST a pre-recorded session and SELL it.
 *
 * The acceptance criterion this module must satisfy:
 *   "A pre-recorded session can be listed and sold."
 *
 * A pre-recorded session is fundamentally different from a live camp ticket:
 *   - it is NOT tied to a date/time (no schedule, unlike Happity's model),
 *   - it has UNLIMITED capacity (a video can be sold any number of times),
 *   - "listing" = publishing it so parents can see/buy it,
 *   - "selling" = a purchase that grants on-demand ACCESS (a stream URL) rather
 *     than a seat on a given date.
 *
 * DOMAIN MODEL
 *   session = {
 *     id, type:'prerecorded', title, price, ageMin, ageMax, durationMins,
 *     mediaUrl,           // where the recording actually lives (required to list)
 *     accessDays,         // how long a buyer keeps access after purchase (0 = forever)
 *     status,             // 'draft' | 'listed' | 'unlisted'
 *     listedAt
 *   }
 *   A session can only be LISTED when it is "complete" (has a title, a media URL
 *   and a non-negative price). A session can only be SOLD when it is LISTED.
 *
 * ACCEPTANCE (asserted in selfTest):
 *   1. a complete pre-recorded session can be LISTED (status -> 'listed'),
 *   2. a LISTED session can be SOLD, and the sale grants on-demand access,
 *   3. an incomplete session (no media / no title) cannot be listed,
 *   4. a session that isn't listed cannot be sold,
 *   5. unlimited capacity — the same session sells repeatedly,
 *   6. unlisting removes it from the catalogue and stops further sales,
 *   7. access expiry is computed from accessDays,
 *   8. persistence round-trips the catalogue + sales via HC.store.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-prerecorded: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_SESSIONS = "provider_prerecorded_sessions"; // keyed by providerId -> [session]
  var STORE_SALES = "provider_prerecorded_sales";       // keyed by providerId -> [sale]

  var STATUS_DRAFT = "draft";
  var STATUS_LISTED = "listed";
  var STATUS_UNLISTED = "unlisted";

  var DAY_MS = 86400000;

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  function toMoneyOrNull(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = Number(v);
    if (!isFinite(n) || n < 0) return null;
    return n;
  }

  function toIntOrNull(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return Math.floor(n);
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  // A plausible-looking media URL (http/https). Pre-recorded content needs
  // somewhere for the recording to live; without it there is nothing to sell.
  function isValidMediaUrl(s) {
    var str = asText(s).trim();
    if (!str) return false;
    return /^https?:\/\/[^\s]+\.[^\s]+/i.test(str);
  }

  /* ---- session construction ------------------------------------------ */

  // Build a pre-recorded session. It starts as a DRAFT — listing is an
  // explicit step (mirrors "publishing" the recording into the catalogue).
  //   input: { title, price, mediaUrl, ageMin, ageMax, durationMins, accessDays }
  function makeSession(input) {
    var a = (input && typeof input === "object") ? input : {};

    var ageMin = toIntOrNull(a.ageMin);
    var ageMax = toIntOrNull(a.ageMax);
    if (ageMin !== null && ageMin < 0) ageMin = 0;
    if (ageMax !== null && ageMax < 0) ageMax = null;
    if (ageMin !== null && ageMax !== null && ageMax < ageMin) {
      var t = ageMin; ageMin = ageMax; ageMax = t; // tolerate swapped bounds
    }

    var accessDays = toIntOrNull(a.accessDays);
    if (accessDays === null || accessDays < 0) accessDays = 0; // 0 = lifetime access

    var dur = toIntOrNull(a.durationMins);
    if (dur !== null && dur < 0) dur = null;

    return {
      id: safeUid("rec"),
      type: "prerecorded",        // <-- on-demand, NOT a dated/live ticket
      title: asText(a.title).trim(),
      price: toMoneyOrNull(a.price),
      ageMin: ageMin,
      ageMax: ageMax,
      durationMins: dur,
      mediaUrl: asText(a.mediaUrl).trim(),
      accessDays: accessDays,     // days of access after purchase; 0 = forever
      capacity: Infinity,         // a recording can be sold any number of times
      status: STATUS_DRAFT,       // 'draft' until listed
      listedAt: null,
      createdAt: Date.now()
    };
  }

  // Is the session complete enough to be put in the catalogue? Needs a title,
  // a real media URL and a non-negative price (free = price 0 is allowed).
  function isListable(session) {
    if (!session || session.type !== "prerecorded") return false;
    if (!asText(session.title).trim()) return false;
    if (!isValidMediaUrl(session.mediaUrl)) return false;
    if (session.price === null || session.price < 0) return false;
    return true;
  }

  // Return the specific reason a session can't be listed (for UI / errors).
  function listingBlocker(session) {
    if (!session || session.type !== "prerecorded") return "Not a pre-recorded session.";
    if (!asText(session.title).trim()) return "Give the session a title before listing.";
    if (!isValidMediaUrl(session.mediaUrl)) return "Add a valid recording link (https://…) before listing.";
    if (session.price === null || session.price < 0) return "Set a price (£0 for free) before listing.";
    return null;
  }

  // LIST it — publish into the catalogue so parents can find and buy it.
  function listSession(session) {
    if (!session) return { ok: false, error: "No session." };
    var blocker = listingBlocker(session);
    if (blocker) return { ok: false, error: blocker };
    session.status = STATUS_LISTED;
    session.listedAt = Date.now();
    return { ok: true, session: session };
  }

  // UNLIST it — pull it from the catalogue. No new sales after this.
  function unlistSession(session) {
    if (!session) return { ok: false, error: "No session." };
    session.status = STATUS_UNLISTED;
    return { ok: true, session: session };
  }

  function isListed(session) {
    return !!session && session.status === STATUS_LISTED;
  }

  // The public catalogue = only the LISTED sessions.
  function catalogue(sessions) {
    if (!Array.isArray(sessions)) return [];
    return sessions.filter(isListed);
  }

  /* ---- selling a pre-recorded session (the transaction) -------------- */

  // SELL one access to a listed session. Unlimited capacity: this always
  // succeeds for a listed session and returns a sale that grants on-demand
  // ACCESS (a stream URL + an expiry computed from accessDays).
  //   now: optional timestamp for deterministic testing.
  function sellSession(session, buyer, now) {
    if (!session || session.type !== "prerecorded") {
      return { ok: false, error: "Not a pre-recorded session." };
    }
    if (!isListed(session)) {
      return { ok: false, error: "This session isn't listed for sale." };
    }
    var ts = (typeof now === "number" && isFinite(now)) ? now : Date.now();
    var expiresAt = session.accessDays > 0 ? ts + session.accessDays * DAY_MS : null; // null = lifetime
    return {
      ok: true,
      sale: {
        id: safeUid("sale"),
        sessionId: session.id,
        type: "prerecorded",
        buyer: asText(buyer).trim() || "Guest",
        price: session.price,
        // What the buyer actually receives: on-demand access, not a seat.
        access: {
          mediaUrl: session.mediaUrl,
          grantedAt: ts,
          expiresAt: expiresAt        // null => never expires
        },
        createdAt: ts
      }
    };
  }

  // Does a sale still grant access at time `now`?
  function accessActive(sale, now) {
    if (!sale || !sale.access) return false;
    var exp = sale.access.expiresAt;
    if (exp === null || exp === undefined) return true; // lifetime access
    var ts = (typeof now === "number" && isFinite(now)) ? now : Date.now();
    return ts < exp;
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)
     =================================================================== */

  function readMap(key) {
    try {
      var s = HC.store.get(key, {});
      return (s && typeof s === "object" && !Array.isArray(s)) ? s : {};
    } catch (e) { return {}; }
  }
  function writeMap(key, map) {
    try { return HC.store.set(key, (map && typeof map === "object") ? map : {}); }
    catch (e) { return false; }
  }

  function getSessions(providerId) {
    var all = readMap(STORE_SESSIONS);
    var list = all[providerId];
    return Array.isArray(list) ? list : [];
  }
  function saveSession(providerId, session) {
    var all = readMap(STORE_SESSIONS);
    var list = Array.isArray(all[providerId]) ? all[providerId] : [];
    var replaced = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === session.id) { list[i] = session; replaced = true; break; }
    }
    if (!replaced) list.push(session);
    all[providerId] = list;
    writeMap(STORE_SESSIONS, all);
    return session;
  }
  function getSales(providerId) {
    var all = readMap(STORE_SALES);
    var list = all[providerId];
    return Array.isArray(list) ? list : [];
  }
  function recordSale(providerId, sale) {
    var all = readMap(STORE_SALES);
    var list = Array.isArray(all[providerId]) ? all[providerId] : [];
    list.push(sale);
    all[providerId] = list;
    writeMap(STORE_SALES, all);
    return sale;
  }

  /* ===================================================================
     DEMO DATA — framed for school-age holiday content.
     =================================================================== */

  function demoProviderId() {
    try {
      var ps = HC.data.providers || [];
      for (var i = 0; i < ps.length; i++) {
        if (ps[i] && ps[i].id) return ps[i].id;
      }
    } catch (e) { /* ignore */ }
    return "demo-camp";
  }

  function demoSessions() {
    return [
      makeSession({
        title: "Rainy-Day Robotics: Build a Cardboard Robot",
        price: 8,
        mediaUrl: "https://video.holidaycamp.example/robotics-ep1",
        ageMin: 7, ageMax: 11, durationMins: 45, accessDays: 30
      }),
      makeSession({
        title: "Holiday Coding Club — Scratch Maze Game",
        price: 6,
        mediaUrl: "https://video.holidaycamp.example/scratch-maze",
        ageMin: 8, ageMax: 12, durationMins: 60, accessDays: 0
      }),
      makeSession({
        // deliberately incomplete (no media URL) so the UI shows it can't list
        title: "At-Home PE: Living-Room Olympics",
        price: 0,
        mediaUrl: "",
        ageMin: 5, ageMax: 9, durationMins: 30, accessDays: 14
      })
    ];
  }

  /* ===================================================================
     RENDER (UI into mountEl)
     =================================================================== */

  function ageLabel(s) {
    if (s.ageMin === null && s.ageMax === null) return "All ages";
    if (s.ageMin !== null && s.ageMax !== null) return "Ages " + s.ageMin + "–" + s.ageMax;
    if (s.ageMin !== null) return "Ages " + s.ageMin + "+";
    return "Up to " + s.ageMax;
  }

  function accessLabel(s) {
    return s.accessDays > 0 ? (s.accessDays + "-day access") : "Lifetime access";
  }

  function statusBadge(s) {
    var map = {};
    map[STATUS_LISTED] = ["Listed", "#E1F0E4", "#2f7d4f"];
    map[STATUS_DRAFT] = ["Draft", "#F0E8F4", "#603488"];
    map[STATUS_UNLISTED] = ["Unlisted", "#f4f4f4", "#808080"];
    var m = map[s.status] || map[STATUS_DRAFT];
    return '<span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;' +
      "background:" + m[1] + ";color:" + m[2] + '">' + m[0] + "</span>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      var sessions = demoSessions();
      var salesCount = {}; // sessionId -> count, for this preview only

      mountEl.innerHTML = "";
      var wrap = HC.util.el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

      wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 6px" },
        "Happity is a <b>live-only</b> timetable, so it can't list pre-recorded sessions. " +
        "HolidayCamp can: publish an <b>on-demand</b> recording (a rainy-day craft, a coding tutorial) and " +
        "<b>sell</b> it any number of times — each sale grants the buyer a stream link."));
      wrap.appendChild(HC.util.el("p", { style: "font-size:12.5px;color:var(--muted,#808080);margin:0 0 14px" },
        "A session must be complete (title + recording link + price) before it can be <b>Listed</b>. " +
        "Only listed sessions can be sold."));

      var list = HC.util.el("div", {
        style: "display:flex;flex-direction:column;gap:12px"
      });

      function renderCard(s) {
        var card = HC.util.el("div", {
          style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px"
        });

        var head = HC.util.el("div", {
          style: "display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin:0 0 6px"
        });
        head.appendChild(HC.util.el("strong", {
          style: "font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);font-size:15px"
        }, escapeHtml(s.title || "Untitled session")));
        head.appendChild(HC.util.el("span", null, statusBadge(s)));
        card.appendChild(head);

        var meta = HC.util.el("div", { style: "font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px" });
        meta.innerHTML = [
          HC.util.money(s.price === null ? 0 : s.price),
          escapeHtml(ageLabel(s)),
          (s.durationMins ? s.durationMins + " min" : "On-demand"),
          escapeHtml(accessLabel(s)),
          "▶ " + escapeHtml(s.mediaUrl ? "recording attached" : "no recording yet")
        ].join(" · ");
        card.appendChild(meta);

        var sold = HC.util.el("div", { style: "font-size:12.5px;color:var(--text,#383838);margin:0 0 10px" });
        function renderSold() {
          var n = salesCount[s.id] || 0;
          sold.innerHTML = "Sold: <b>" + n + "</b>" + (isListed(s) ? " · unlimited capacity" : "");
        }
        renderSold();
        card.appendChild(sold);

        var row = HC.util.el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });

        // LIST / UNLIST control.
        var listBtn = HC.util.el("button", { class: "hc-btn", type: "button" });
        function syncListBtn() {
          if (isListed(s)) {
            listBtn.textContent = "Unlist";
            listBtn.className = "hc-btn hc-btn-ghost";
          } else {
            listBtn.textContent = "List for sale";
            listBtn.className = "hc-btn";
          }
        }
        syncListBtn();
        listBtn.addEventListener("click", function () {
          var res = isListed(s) ? unlistSession(s) : listSession(s);
          if (!res.ok) { HC.util.toast(res.error); return; }
          saveSession(providerId, s);
          HC.util.toast(isListed(s) ? "Listed in the on-demand catalogue" : "Unlisted");
          syncListBtn(); renderSold(); sellBtn.disabled = !isListed(s);
        });
        row.appendChild(listBtn);

        // SELL control (only meaningful once listed).
        var sellBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Sell access");
        sellBtn.disabled = !isListed(s);
        sellBtn.addEventListener("click", function () {
          var res = sellSession(s, "Parent");
          if (!res.ok) { HC.util.toast(res.error); return; }
          recordSale(providerId, res.sale);
          salesCount[s.id] = (salesCount[s.id] || 0) + 1;
          renderSold();
          HC.util.toast("Sold — buyer gets " + (res.sale.access.expiresAt ? accessLabel(s) : "lifetime access"));
        });
        row.appendChild(sellBtn);

        // Why-can't-I-list hint.
        var blocker = listingBlocker(s);
        if (blocker && !isListed(s)) {
          row.appendChild(HC.util.el("span", {
            style: "font-size:12px;color:#9a1f5e;align-self:center"
          }, escapeHtml("⚠ " + blocker)));
        }

        card.appendChild(row);
        return card;
      }

      sessions.forEach(function (s) { list.appendChild(renderCard(s)); });
      wrap.appendChild(list);
      mountEl.appendChild(wrap);
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Preview unavailable: ' +
          escapeHtml(e && e.message ? e.message : String(e)) + "</p>";
      } catch (_) { /* give up quietly */ }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ===================================================================
     SELF TEST — exercises the LOGIC and asserts the acceptance criterion:
     "A pre-recorded session can be listed and sold."
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    function completeInput(extra) {
      var base = {
        title: "Rainy-Day Robotics",
        price: 8,
        mediaUrl: "https://video.holidaycamp.example/robotics-ep1",
        ageMin: 7, ageMax: 11, durationMins: 45, accessDays: 30
      };
      if (extra) for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) base[k] = extra[k]; }
      return base;
    }

    // 0. A new session is a DRAFT, on-demand, unlimited capacity — not a live ticket.
    check("A new pre-recorded session is a draft, on-demand, unlimited capacity", function () {
      var s = makeSession(completeInput());
      HC.assert(s.type === "prerecorded", "type should be 'prerecorded'");
      HC.assert(s.status === STATUS_DRAFT, "should start as a draft");
      HC.assert(s.capacity === Infinity, "a recording has unlimited capacity");
      HC.assert(!("date" in s) && !("dates" in s), "must NOT be tied to a date (unlike a live ticket)");
    });

    // 1. ACCEPTANCE (list): a complete session can be LISTED.
    check("A complete pre-recorded session can be LISTED", function () {
      var s = makeSession(completeInput());
      HC.assert(isListable(s), "complete session should be listable");
      var res = listSession(s);
      HC.assert(res.ok, "listing should succeed: " + (res.error || ""));
      HC.assert(s.status === STATUS_LISTED, "status should become 'listed'");
      HC.assert(isListed(s), "isListed should be true");
      HC.assert(typeof s.listedAt === "number", "listedAt timestamp should be set");
      HC.assert(catalogue([s]).length === 1, "a listed session appears in the catalogue");
    });

    // 2. ACCEPTANCE (sell): a LISTED session can be SOLD and grants access.
    check("A listed pre-recorded session can be SOLD and grants on-demand access", function () {
      var s = makeSession(completeInput());
      listSession(s);
      var res = sellSession(s, "Parent A", 1000);
      HC.assert(res.ok, "selling a listed session should succeed: " + (res.error || ""));
      HC.assert(res.sale.type === "prerecorded", "sale type should be 'prerecorded'");
      HC.assert(res.sale.price === 8, "sale price should match the session price");
      HC.assert(res.sale.access && res.sale.access.mediaUrl === s.mediaUrl,
        "sale must grant access to the recording's media URL");
      HC.assert(res.sale.access.grantedAt === 1000, "access granted timestamp should be set");
      HC.assert(accessActive(res.sale, 1000), "access should be active immediately after purchase");
    });

    // 3. An INCOMPLETE session cannot be listed (missing media / missing title).
    check("An incomplete session (no recording / no title) cannot be listed", function () {
      var noMedia = makeSession(completeInput({ mediaUrl: "" }));
      HC.assert(!isListable(noMedia), "no media => not listable");
      HC.assert(!listSession(noMedia).ok, "listing without a recording must fail");
      HC.assert(noMedia.status === STATUS_DRAFT, "remains a draft");

      var noTitle = makeSession(completeInput({ title: "   " }));
      HC.assert(!isListable(noTitle), "blank title => not listable");
      HC.assert(!listSession(noTitle).ok, "listing without a title must fail");

      var badUrl = makeSession(completeInput({ mediaUrl: "not-a-url" }));
      HC.assert(!isListable(badUrl), "non-URL media => not listable");

      var noPrice = makeSession(completeInput({ price: "" }));
      HC.assert(!isListable(noPrice), "no price => not listable");
    });

    // 4. A session that ISN'T listed cannot be sold.
    check("A session that isn't listed cannot be sold", function () {
      var draft = makeSession(completeInput());
      HC.assert(draft.status === STATUS_DRAFT, "still a draft");
      var res = sellSession(draft, "Parent B");
      HC.assert(!res.ok, "selling an unlisted draft must fail");
      HC.assert(/isn't listed/i.test(res.error || ""), "error should explain it isn't listed");
    });

    // 5. UNLIMITED capacity — the same recording sells repeatedly.
    check("Unlimited capacity: the same recording sells repeatedly", function () {
      var s = makeSession(completeInput());
      listSession(s);
      var n = 25, sales = [];
      for (var i = 0; i < n; i++) {
        var r = sellSession(s, "Parent " + i);
        HC.assert(r.ok, "sale #" + i + " should succeed");
        sales.push(r.sale.id);
      }
      // every sale id is unique (no seat collisions like a capped live class)
      var uniq = {};
      sales.forEach(function (id) { uniq[id] = true; });
      HC.assert(Object.keys(uniq).length === n, "every sale should be a distinct grant");
    });

    // 6. UNLISTING pulls it from the catalogue and stops further sales.
    check("Unlisting removes it from the catalogue and blocks further sales", function () {
      var s = makeSession(completeInput());
      listSession(s);
      HC.assert(catalogue([s]).length === 1, "listed => in catalogue");
      HC.assert(sellSession(s, "P").ok, "sells while listed");
      unlistSession(s);
      HC.assert(s.status === STATUS_UNLISTED, "status should be 'unlisted'");
      HC.assert(catalogue([s]).length === 0, "unlisted => gone from catalogue");
      HC.assert(!sellSession(s, "P").ok, "must not sell once unlisted");
    });

    // 7. ACCESS EXPIRY is computed from accessDays; 0 => lifetime.
    check("Access expiry is computed from accessDays (0 = lifetime)", function () {
      var timed = makeSession(completeInput({ accessDays: 30 }));
      listSession(timed);
      var sale = sellSession(timed, "P", 0).sale;
      HC.assert(sale.access.expiresAt === 30 * DAY_MS, "expiry should be grantedAt + 30 days");
      HC.assert(accessActive(sale, 29 * DAY_MS), "access active before expiry");
      HC.assert(!accessActive(sale, 31 * DAY_MS), "access expired after the window");

      var lifetime = makeSession(completeInput({ accessDays: 0 }));
      listSession(lifetime);
      var lsale = sellSession(lifetime, "P", 0).sale;
      HC.assert(lsale.access.expiresAt === null, "lifetime access never expires");
      HC.assert(accessActive(lsale, 9e15), "lifetime access still active far in the future");
    });

    // 8. A free (£0) pre-recorded session can still be listed and sold.
    check("A free (£0) pre-recorded session can be listed and sold", function () {
      var free = makeSession(completeInput({ price: 0 }));
      HC.assert(isListable(free), "£0 is a valid price for a recording");
      HC.assert(listSession(free).ok, "free session lists");
      var r = sellSession(free, "P");
      HC.assert(r.ok && r.sale.price === 0, "free session 'sells' (grants access) at £0");
    });

    // 9. Persistence round-trips the catalogue + sales via HC.store.
    check("Persists and reloads the catalogue and its sales via HC.store", function () {
      var pid = "selftest-prerec-" + safeUid("p");
      var s = makeSession(completeInput());
      listSession(s);
      saveSession(pid, s);
      var sale = sellSession(s, "Parent Z", 5000).sale;
      recordSale(pid, sale);

      var loadedSessions = getSessions(pid);
      HC.assert(loadedSessions.length === 1, "one session should persist");
      var ls = loadedSessions[0];
      HC.assert(ls.type === "prerecorded", "reloaded session is pre-recorded");
      HC.assert(ls.status === STATUS_LISTED, "reloaded session keeps its 'listed' status");
      HC.assert(catalogue(loadedSessions).length === 1, "reloaded session still in catalogue");

      var loadedSales = getSales(pid);
      HC.assert(loadedSales.length === 1, "one sale should persist");
      HC.assert(loadedSales[0].sessionId === s.id, "sale links back to the session");
      HC.assert(loadedSales[0].access.mediaUrl === s.mediaUrl, "sale keeps the access link");

      // cleanup
      try {
        var allS = readMap(STORE_SESSIONS); delete allS[pid]; writeMap(STORE_SESSIONS, allS);
        var allSales = readMap(STORE_SALES); delete allSales[pid]; writeMap(STORE_SALES, allSales);
      } catch (e) { /* ignore cleanup failure */ }
    });

    // 10. Defensive: garbage input never throws; demo data is well-formed.
    check("Garbage input is handled defensively; demo data is school-age framed", function () {
      [null, undefined, 42, "x", {}, { title: 123 }].forEach(function (bad) {
        var s = makeSession(bad);
        HC.assert(s && s.type === "prerecorded", "makeSession always returns a session");
        HC.assert(!isListable(s) || isListable(s), "isListable never throws");
        HC.assert(!sellSession(s, null).ok, "an incomplete/unlisted session never sells");
      });
      var demo = demoSessions();
      HC.assert(demo.length >= 2, "should provide demo sessions");
      var listable = demo.filter(isListable).length;
      HC.assert(listable >= 2, "at least two demo sessions are listable");
      HC.assert(demo.some(function (d) { return !isListable(d); }),
        "one demo session is deliberately incomplete (shows the can't-list path)");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER
     =================================================================== */

  HC.registerFeature({
    id: "provider-prerecorded",
    title: "List pre-recorded sessions",
    side: "provider",
    icon: "▶️",
    summary: "Publish an on-demand recording (a rainy-day craft, a coding tutorial) into a catalogue and sell it any number of times — each sale grants a stream link with optional access expiry. (Happity is live-only and can't do this.)",
    render: render,
    selfTest: selfTest
  });
})();
