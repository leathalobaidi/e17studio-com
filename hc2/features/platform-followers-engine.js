/* HolidayCamp feature — platform-followers-engine
 *
 * Followers timetable-email ENGINE  (PLATFORM side)
 *
 * This is the platform's distribution engine that sits behind the provider-side
 * "Followers list" feature. Where provider-followers.js lets ONE provider see and
 * export their own followers, THIS engine is the cross-platform scheduler that
 * actually composes and sends the timetable emails to every provider's followers.
 *
 * Replicates Happity support article 4291535 ("How to use Happity Followers for
 * zero-effort email marketing"), Member Benefits section, plus 04-seo §4.2. The
 * load-bearing evidence:
 *   - "When you add classes on Happity ... we'll send your latest timetable to
 *      your followers" -> the PLATFORM sends, automatically.
 *   - "By default, we'll distribute timetables 4 TIMES A YEAR for everyone — at
 *      the START OF EACH TERM." -> a 4x/year, term-start cadence.
 *   - "Classes from Happity MEMBERS get SENT OUT FIRST." -> within a term-start
 *      batch, Member providers' timetables are ordered ahead of non-members.
 *   - "we run frequent updates on Member's classes DURING THE TERM, sending out
 *      specific alerts whenever NEW CLASSES ARE ADDED." -> mid-term new-class
 *      alerts are a MEMBER-ONLY benefit, triggered by adding classes.
 *   - "If the customer's email address is starred out ... they have opted in to
 *      receive timetable information ... but they have NOT opted in for
 *      marketing." -> a follower receives timetable emails regardless of the
 *      separate marketing opt-in; the email is the platform's, not the provider's.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: "terms" here are the school-holiday
 * windows a camp provider sells into — Spring (Easter), Summer, Autumn (October
 * half-term + Christmas run-in), Winter. Each provider in the live E17 directory
 * has followers (parents who tapped "Follow" on the camp's profile). At each
 * term start the engine builds ONE timetable email per follower listing the
 * camps that follower follows; Members go to the front of the queue. When a
 * Member adds a new camp week mid-term, the engine fires a new-class alert to
 * that camp's followers — non-members get no such mid-term alert.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Followers get term-start timetable emails; Members' classes send first plus
 *   mid-term new-class alerts.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] platform-followers-engine: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;
  var STORE_KEY = "platform_followers_engine_state";

  // The four term-start sends per year (4x/year cadence). Holiday-camp framing.
  var TERMS = [
    { id: "spring", label: "Spring / Easter term", monthStart: 3 },   // late March / April
    { id: "summer", label: "Summer term",          monthStart: 6 },   // July
    { id: "autumn", label: "Autumn term",          monthStart: 9 },   // September / October
    { id: "winter", label: "Winter / Christmas term", monthStart: 12 } // December
  ];

  /* ============================================================ *
   *  PURE LOGIC (testable, DOM-free). All functions take a state *
   *  and return data or a NEW state — never mutate in place.      *
   *                                                              *
   *  State shape:                                                *
   *   {                                                          *
   *     providers: {                                             *
   *       <providerId>: {                                        *
   *         id, name,                                            *
   *         isMember: Boolean,        // Happity Member?          *
   *         classes: [ { id, label, addedTerm } ],  // live camp  *
   *         followers: [ { email, marketingOptIn } ]             *
   *       }                                                      *
   *     },                                                       *
   *     sentLog: [ envelope... ]   // every email the engine sent *
   *   }                                                          *
   *                                                              *
   *  An "envelope" (one email) =                                 *
   *   { id, kind:'term-start'|'new-class-alert', term,           *
   *     to, providerId, providerName, isMember,                  *
   *     classIds:[...], subject, sentAt, priority }              *
   * ============================================================ */

  function emptyState() {
    return { providers: {}, sentLog: [] };
  }

  function cloneState(state) {
    try { return JSON.parse(JSON.stringify(state || {})); }
    catch (e) { return emptyState(); }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  function normEmail(e) { return String(e == null ? "" : e).trim().toLowerCase(); }

  // ---- provider registration into the engine ----

  // Ensure a provider record exists; returns the record (live reference inside
  // the passed state, which the caller owns).
  function ensureProvider(state, provider) {
    if (!state.providers) state.providers = {};
    var pid = provider && provider.id ? String(provider.id) : "";
    if (!pid) return null;
    if (!state.providers[pid]) {
      state.providers[pid] = {
        id: pid,
        name: (provider && provider.name) || pid,
        isMember: false,
        classes: [],
        followers: []
      };
    } else if (provider && provider.name) {
      state.providers[pid].name = provider.name;
    }
    return state.providers[pid];
  }

  function setMember(state, providerId, isMember) {
    var next = cloneState(state);
    var p = ensureProvider(next, { id: providerId });
    if (p) p.isMember = !!isMember;
    return next;
  }

  // Add a FOLLOWER to a provider. Idempotent on email. A follow does not imply
  // marketing consent, but the follower still receives timetable emails.
  function addFollower(state, providerId, follower) {
    var next = cloneState(state);
    var p = ensureProvider(next, { id: providerId });
    if (!p) return { state: next, added: false };
    var email = normEmail(follower && follower.email);
    if (!email) return { state: next, added: false };
    if (!Array.isArray(p.followers)) p.followers = [];
    for (var i = 0; i < p.followers.length; i++) {
      if (normEmail(p.followers[i].email) === email) {
        // already a follower — let them update marketing consent
        if (follower && follower.marketingOptIn !== undefined) {
          p.followers[i].marketingOptIn = !!follower.marketingOptIn;
        }
        return { state: next, added: false };
      }
    }
    p.followers.push({ email: email, marketingOptIn: !!(follower && follower.marketingOptIn) });
    return { state: next, added: true };
  }

  // Add a CLASS (a camp week) to a provider. `term` marks which term it belongs
  // to (used by mid-term alerts). Returns { state, classId, added }.
  function addClass(state, providerId, klass) {
    var next = cloneState(state);
    var p = ensureProvider(next, { id: providerId });
    if (!p) return { state: next, classId: null, added: false };
    if (!Array.isArray(p.classes)) p.classes = [];
    var cid = (klass && klass.id) ? String(klass.id) : safeUid();
    for (var i = 0; i < p.classes.length; i++) {
      if (String(p.classes[i].id) === cid) return { state: next, classId: cid, added: false };
    }
    p.classes.push({
      id: cid,
      label: (klass && klass.label) ? String(klass.label) : ("Camp " + cid),
      addedTerm: (klass && klass.addedTerm) ? String(klass.addedTerm) : null
    });
    return { state: next, classId: cid, added: true };
  }

  // ---- ordering: Members first ----
  // Stable ordering of provider IDs with Members ahead of non-members. Within
  // each group, insertion order is preserved (so the result is deterministic).
  function orderProvidersMembersFirst(state) {
    var ids = Object.keys((state && state.providers) || {});
    var members = [], rest = [];
    for (var i = 0; i < ids.length; i++) {
      var p = state.providers[ids[i]];
      if (p && p.isMember) members.push(ids[i]); else rest.push(ids[i]);
    }
    return members.concat(rest);
  }

  // ---- the term-start distribution (4x/year) ----
  // Build the full batch of term-start envelopes for `term`. ONE email per
  // (follower-email × provider-they-follow) — i.e. each follower gets their
  // provider's latest timetable. Members are emitted FIRST (lower priority
  // number = earlier in the queue). Does not mutate state; returns envelopes.
  function buildTermStartBatch(state, term) {
    var envelopes = [];
    if (!state || !state.providers) return envelopes;
    var order = orderProvidersMembersFirst(state);
    var priority = 0;
    for (var i = 0; i < order.length; i++) {
      var p = state.providers[order[i]];
      if (!p) continue;
      var classes = Array.isArray(p.classes) ? p.classes : [];
      if (!classes.length) continue;            // nothing to put in a timetable
      var followers = Array.isArray(p.followers) ? p.followers : [];
      if (!followers.length) continue;          // nobody to send to
      var classIds = classes.map(function (c) { return c.id; });
      for (var f = 0; f < followers.length; f++) {
        priority += 1;
        envelopes.push({
          id: safeUid(),
          kind: "term-start",
          term: term,
          to: normEmail(followers[f].email),
          providerId: p.id,
          providerName: p.name,
          isMember: !!p.isMember,
          classIds: classIds.slice(),
          subject: "Your " + (p.name || "camp") + " timetable for " + termLabel(term),
          priority: priority
        });
      }
    }
    return envelopes;
  }

  // Actually "send" the term-start batch: append envelopes to the sent log with
  // a timestamp. Returns { state, sent, batch }. Idempotent per term: re-running
  // the same term does NOT re-send (a term distributes once).
  function sendTermStart(state, term) {
    var next = cloneState(state);
    if (!Array.isArray(next.sentLog)) next.sentLog = [];
    if (hasTermBeenSent(next, term)) {
      return { state: next, sent: 0, batch: [], alreadySent: true };
    }
    var batch = buildTermStartBatch(next, term);
    var ts = nowIso();
    for (var i = 0; i < batch.length; i++) {
      batch[i].sentAt = ts;
      next.sentLog.push(batch[i]);
    }
    return { state: next, sent: batch.length, batch: batch, alreadySent: false };
  }

  function hasTermBeenSent(state, term) {
    if (!state || !Array.isArray(state.sentLog)) return false;
    for (var i = 0; i < state.sentLog.length; i++) {
      var e = state.sentLog[i];
      if (e && e.kind === "term-start" && e.term === term) return true;
    }
    return false;
  }

  // ---- mid-term new-class alerts (MEMBER ONLY) ----
  // A provider adds a new class DURING the term. If they are a Member, fire a
  // new-class alert to that provider's followers. Non-members get NOTHING
  // mid-term (their next touch is the following term-start). Returns
  // { state, alertsSent, suppressed:Boolean, reason }.
  function announceNewClass(state, providerId, klass, term) {
    var added = addClass(state, providerId, klass);
    var next = added.state;
    var p = next.providers && next.providers[String(providerId)];
    if (!p) return { state: next, alertsSent: 0, suppressed: true, reason: "no-provider" };

    // Member benefit gate: mid-term alerts only go out for Members.
    if (!p.isMember) {
      return { state: next, alertsSent: 0, suppressed: true, reason: "not-member" };
    }
    var followers = Array.isArray(p.followers) ? p.followers : [];
    if (!followers.length) {
      return { state: next, alertsSent: 0, suppressed: true, reason: "no-followers" };
    }
    if (!Array.isArray(next.sentLog)) next.sentLog = [];
    var ts = nowIso();
    var sent = 0;
    for (var f = 0; f < followers.length; f++) {
      next.sentLog.push({
        id: safeUid(),
        kind: "new-class-alert",
        term: term || null,
        to: normEmail(followers[f].email),
        providerId: p.id,
        providerName: p.name,
        isMember: true,
        classIds: [added.classId],
        subject: "New camp added: " + (klass && klass.label ? klass.label : added.classId) +
          " at " + (p.name || "camp"),
        sentAt: ts,
        priority: 0
      });
      sent += 1;
    }
    return { state: next, alertsSent: sent, suppressed: false, reason: "", classId: added.classId };
  }

  /* ---- read helpers over the sent log (for UI + tests) ---- */

  function termStartEnvelopes(state, term) {
    return ((state && state.sentLog) || []).filter(function (e) {
      return e && e.kind === "term-start" && (term ? e.term === term : true);
    });
  }
  function newClassAlerts(state) {
    return ((state && state.sentLog) || []).filter(function (e) {
      return e && e.kind === "new-class-alert";
    });
  }
  // Envelopes a particular follower received, newest semantics aside.
  function inboxFor(state, email) {
    var target = normEmail(email);
    return ((state && state.sentLog) || []).filter(function (e) {
      return e && normEmail(e.to) === target;
    });
  }
  // In a term-start batch, the FIRST envelope a follower receives from a provider
  // they follow. Used to assert "Members' classes send first": for a follower
  // who follows both a Member and a non-member, the Member envelope has the
  // lower priority (earlier) number.
  function memberSendsFirst(batch) {
    if (!Array.isArray(batch) || !batch.length) return false;
    // The maximum priority among Member envelopes must be < the minimum priority
    // among non-member envelopes (Members are wholly ahead in the queue).
    var maxMember = -Infinity, minRest = Infinity, sawMember = false, sawRest = false;
    for (var i = 0; i < batch.length; i++) {
      var e = batch[i];
      if (e.isMember) { sawMember = true; if (e.priority > maxMember) maxMember = e.priority; }
      else { sawRest = true; if (e.priority < minRest) minRest = e.priority; }
    }
    if (!sawMember || !sawRest) return sawMember; // trivially "members first" if no rest
    return maxMember < minRest;
  }

  function termLabel(term) {
    for (var i = 0; i < TERMS.length; i++) if (TERMS[i].id === term) return TERMS[i].label;
    return term ? String(term) : "the new term";
  }

  /* ============================================================ *
   *  PERSISTENCE (HC.store only)                                 *
   * ============================================================ */

  function loadState() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object") return emptyState();
    if (!raw.providers || typeof raw.providers !== "object") raw.providers = {};
    if (!Array.isArray(raw.sentLog)) raw.sentLog = [];
    return raw;
  }
  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }
  function plannerById() {
    try { return (HC.data.planner && HC.data.planner.byId) || {}; } catch (e) { return {}; }
  }
  function plannerWeeks() {
    try { return (HC.data.planner && HC.data.planner.weeks) || []; } catch (e) { return []; }
  }

  // Seed the engine from the LIVE directory: take the first few real providers,
  // give each a couple of camp "classes" (from their confirmed planner weeks
  // where available), make every other one a Member, and seed deterministic
  // followers — some shared across providers so "Members first" is observable.
  function buildSeedState(limit) {
    var state = emptyState();
    var ps = providers();
    var byId = plannerById();
    var weeks = plannerWeeks();
    var picked = [];
    for (var i = 0; i < ps.length && picked.length < (limit || 5); i++) {
      if (ps[i] && ps[i].id && ps[i].name) picked.push(ps[i]);
    }
    if (!picked.length) {
      picked = [
        { id: "demo-a", name: "Demo Camp A" },
        { id: "demo-b", name: "Demo Camp B" }
      ];
    }

    // Shared followers so a single parent follows multiple camps (lets us see
    // ordering). plus camp-specific followers.
    var sharedFollowers = [
      { email: "shared.parent1@example.com", marketingOptIn: true },
      { email: "shared.parent2@example.com", marketingOptIn: false }
    ];

    for (var p = 0; p < picked.length; p++) {
      var prov = picked[p];
      ensureProvider(state, prov);
      // every other provider is a Member
      state.providers[prov.id].isMember = (p % 2 === 0);

      // classes from confirmed planner weeks, else a single generic camp week
      var pl = byId[prov.id] || {};
      var wk = Array.isArray(pl.weeks) ? pl.weeks : [];
      if (wk.length) {
        for (var w = 0; w < Math.min(wk.length, 3); w++) {
          var meta = weeks.filter(function (x) { return x.id === wk[w]; })[0];
          var label = meta ? (prov.name + " — " + meta.label + " (" + meta.dates + ")")
                           : (prov.name + " — week " + wk[w]);
          var ac = addClass(state, prov.id, { id: prov.id + "-wk" + wk[w], label: label, addedTerm: "summer" });
          state = ac.state;
        }
      } else {
        var ac2 = addClass(state, prov.id, { id: prov.id + "-summer", label: prov.name + " — Summer camp", addedTerm: "summer" });
        state = ac2.state;
      }

      // followers: shared two + one camp-specific
      var fr1 = addFollower(state, prov.id, sharedFollowers[0]); state = fr1.state;
      var fr2 = addFollower(state, prov.id, sharedFollowers[1]); state = fr2.state;
      var fr3 = addFollower(state, prov.id, {
        email: "fan." + prov.id + "@example.com", marketingOptIn: (p % 2 === 0)
      });
      state = fr3.state;
    }
    return state;
  }

  /* ============================================================ *
   *  UI                                                          *
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    var state = loadState();
    // If the engine has never been seeded, seed it from the live directory.
    if (!state.providers || !Object.keys(state.providers).length) {
      state = buildSeedState(5);
      saveState(state);
    }

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 6px" },
      "The platform's <strong>timetable-email engine</strong>. By default it distributes camp " +
      "timetables to followers <strong>4× a year — at the start of each term</strong>. " +
      "<strong>Members' camps send first</strong>, and Members also get <strong>mid-term new-camp alerts</strong> " +
      "whenever they add a week during the term — just like Happity."));
    wrap.appendChild(HC.util.el("p", {
      style: "font-size:12px;color:var(--muted,#808080);margin:0 0 14px"
    }, "Seeded from the live E17 holiday-camp directory. Followers receive these emails whether or not " +
       "they opted into a provider's own marketing."));

    var kpis = HC.util.el("div", { style: "display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px" });
    wrap.appendChild(kpis);

    // term send buttons
    var termRow = HC.util.el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px" });
    termRow.appendChild(HC.util.el("span", {
      style: "font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488);font-weight:700"
    }, "Term-start sends (4×/yr)"));
    wrap.appendChild(termRow);

    var controls = HC.util.el("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px" });
    var alertBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" },
      "Member adds a mid-term camp → alert");
    var nonMemberBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" },
      "Non-member adds a camp → (no alert)");
    var resetBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Reset engine");
    controls.appendChild(alertBtn);
    controls.appendChild(nonMemberBtn);
    controls.appendChild(resetBtn);
    wrap.appendChild(controls);

    var logHost = HC.util.el("div", {});
    wrap.appendChild(logHost);

    mountEl.appendChild(wrap);

    function kpiCard(label, value, tint) {
      return '<div style="flex:1;min-width:120px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;' +
        'padding:12px 14px;background:' + (tint || "#fff") + '">' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:24px;color:var(--purple,#603488)">' +
          esc(value) + "</div>" +
        '<div style="font-size:11.5px;color:var(--muted,#808080);text-transform:uppercase;letter-spacing:.4px">' +
          esc(label) + "</div>" +
      "</div>";
    }

    function firstMember(state) {
      var ids = Object.keys(state.providers || {});
      for (var i = 0; i < ids.length; i++) if (state.providers[ids[i]].isMember) return state.providers[ids[i]];
      return null;
    }
    function firstNonMember(state) {
      var ids = Object.keys(state.providers || {});
      for (var i = 0; i < ids.length; i++) if (!state.providers[ids[i]].isMember) return state.providers[ids[i]];
      return null;
    }

    function paintTermButtons() {
      // (re)build term buttons each paint so the "already sent" state shows
      while (termRow.childNodes.length > 1) termRow.removeChild(termRow.lastChild);
      TERMS.forEach(function (t) {
        var done = hasTermBeenSent(state, t.id);
        var b = HC.util.el("button", {
          class: "hc-btn" + (done ? " hc-btn-ghost" : ""),
          type: "button",
          title: done ? "Already distributed this term" : "Distribute the " + t.label + " timetable batch"
        }, (done ? "✓ " : "Send ") + t.label);
        b.disabled = done;
        b.style.opacity = done ? "0.6" : "1";
        b.addEventListener("click", function () {
          var res = sendTermStart(state, t.id);
          state = res.state;
          saveState(state);
          try {
            HC.util.toast(res.alreadySent
              ? t.label + " already sent this term"
              : "Sent " + res.sent + " " + t.label + " timetable email(s)");
          } catch (e) {}
          paint();
        });
        termRow.appendChild(b);
      });
    }

    function paint() {
      var totalFollowers = 0, members = 0, providerCount = 0;
      var ids = Object.keys(state.providers || {});
      providerCount = ids.length;
      ids.forEach(function (id) {
        var p = state.providers[id];
        if (p.isMember) members += 1;
        totalFollowers += (p.followers || []).length;
      });
      var termStart = termStartEnvelopes(state).length;
      var alerts = newClassAlerts(state).length;

      kpis.innerHTML =
        kpiCard("Camp providers", providerCount) +
        kpiCard("Members", members, "var(--purple-tint,#F0E8F4)") +
        kpiCard("Follower records", totalFollowers) +
        kpiCard("Term-start emails", termStart, "var(--pink-tint,#FCE8F0)") +
        kpiCard("Mid-term alerts", alerts, "var(--pink-tint,#FCE8F0)");

      paintTermButtons();

      // recent envelopes (last 14), newest first
      var log = (state.sentLog || []).slice(-14).reverse();
      if (!log.length) {
        logHost.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080)">' +
          "No emails sent yet — press a term-start button to distribute timetables.</p>";
        return;
      }
      var rows = log.map(function (e) {
        var tag = e.kind === "term-start"
          ? '<span style="background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:999px">TERM START</span>'
          : '<span style="background:var(--pink-tint,#FCE8F0);color:#9a1f5e;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:999px">NEW CAMP ALERT</span>';
        var member = e.isMember
          ? ' <span title="Happity Member" style="font-size:11px">⭐ Member</span>' : "";
        return '<tr style="border-bottom:1px solid var(--line,#E6E6E6)">' +
          '<td style="padding:7px 8px;font-size:12px">' + tag + member + "</td>" +
          '<td style="padding:7px 8px;font-size:12.5px">' + esc(e.subject) + "</td>" +
          '<td style="padding:7px 8px;font-size:12px;font-family:ui-monospace,monospace;color:var(--muted,#808080)">' + esc(e.to) + "</td>" +
        "</tr>";
      }).join("");
      logHost.innerHTML =
        '<h4 style="font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);margin:12px 0 6px;font-size:14px">Outbox (latest)</h4>' +
        '<table style="width:100%;border-collapse:collapse">' +
        '<tr style="text-align:left;border-bottom:1.5px solid var(--line,#E6E6E6)">' +
          '<th style="padding:7px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">Kind</th>' +
          '<th style="padding:7px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">Subject</th>' +
          '<th style="padding:7px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">To</th>' +
        "</tr>" + rows + "</table>";
    }

    alertBtn.addEventListener("click", function () {
      var m = firstMember(state);
      if (!m) { try { HC.util.toast("No Member provider seeded"); } catch (e) {} return; }
      var res = announceNewClass(state, m.id,
        { label: m.name + " — extra week just added", addedTerm: "summer" }, "summer");
      state = res.state;
      saveState(state);
      try {
        HC.util.toast(res.suppressed
          ? "Suppressed (" + res.reason + ")"
          : "Sent " + res.alertsSent + " new-camp alert(s) for " + m.name);
      } catch (e) {}
      paint();
    });

    nonMemberBtn.addEventListener("click", function () {
      var nm = firstNonMember(state);
      if (!nm) { try { HC.util.toast("No non-member provider seeded"); } catch (e) {} return; }
      var res = announceNewClass(state, nm.id,
        { label: nm.name + " — extra week just added", addedTerm: "summer" }, "summer");
      state = res.state;
      saveState(state);
      try {
        HC.util.toast(res.suppressed
          ? "No alert — " + nm.name + " is not a Member (term-start only)"
          : "Sent " + res.alertsSent + " alert(s)");
      } catch (e) {}
      paint();
    });

    resetBtn.addEventListener("click", function () {
      state = buildSeedState(5);
      saveState(state);
      try { HC.util.toast("Engine reset and re-seeded from live directory"); } catch (e) {}
      paint();
    });

    paint();
  }

  /* ============================================================ *
   *  selfTest — exercises the LOGIC and the acceptance criterion *
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // --- ACCEPTANCE, part 1: followers GET TERM-START TIMETABLE EMAILS ---
    check("Followers receive a term-start timetable email (4×/yr cadence)", function () {
      var s = emptyState();
      s = setMember(s, "campA", false);
      s = addClass(s, "campA", { id: "a1", label: "Camp A — Summer week 1", addedTerm: "summer" }).state;
      s = addFollower(s, "campA", { email: "parent1@example.com", marketingOptIn: true }).state;
      s = addFollower(s, "campA", { email: "parent2@example.com", marketingOptIn: false }).state;
      var res = sendTermStart(s, "summer");
      s = res.state;
      HC.assert(res.sent === 2, "two followers each get one term-start email, got " + res.sent);
      var inbox1 = inboxFor(s, "parent1@example.com");
      HC.assert(inbox1.length === 1, "follower 1 has exactly one email");
      HC.assert(inbox1[0].kind === "term-start", "it is a term-start email");
      HC.assert(inbox1[0].term === "summer", "for the summer term");
      HC.assert(inbox1[0].classIds.indexOf("a1") !== -1, "the timetable lists the camp's class");
    });

    check("Timetable-only follower (no marketing opt-in) still gets the term email", function () {
      var s = emptyState();
      s = addClass(s, "campA", { id: "a1", label: "Camp A", addedTerm: "summer" }).state;
      s = addFollower(s, "campA", { email: "noads@example.com", marketingOptIn: false }).state;
      var res = sendTermStart(s, "summer");
      s = res.state;
      HC.assert(res.sent === 1, "the non-marketing follower is still emailed the timetable");
      HC.assert(inboxFor(s, "noads@example.com").length === 1, "their inbox has the term-start email");
    });

    check("Four distinct term-start sends per year are supported (4×/yr)", function () {
      var s = emptyState();
      s = addClass(s, "campA", { id: "a1", label: "Camp A", addedTerm: "summer" }).state;
      s = addFollower(s, "campA", { email: "p@example.com", marketingOptIn: true }).state;
      var terms = ["spring", "summer", "autumn", "winter"];
      for (var i = 0; i < terms.length; i++) s = sendTermStart(s, terms[i]).state;
      HC.assert(termStartEnvelopes(s).length === 4, "one email per term × 1 follower = 4, got " + termStartEnvelopes(s).length);
      HC.assert(termStartEnvelopes(s, "winter").length === 1, "the winter term send happened");
      HC.assert(TERMS.length === 4, "the engine defines exactly four terms");
    });

    check("A term distributes ONCE — re-running the same term does not re-send", function () {
      var s = emptyState();
      s = addClass(s, "campA", { id: "a1", label: "Camp A", addedTerm: "summer" }).state;
      s = addFollower(s, "campA", { email: "p@example.com", marketingOptIn: true }).state;
      var first = sendTermStart(s, "summer"); s = first.state;
      HC.assert(first.sent === 1 && first.alreadySent === false, "first send delivers one email");
      var second = sendTermStart(s, "summer"); s = second.state;
      HC.assert(second.sent === 0 && second.alreadySent === true, "second send is a no-op");
      HC.assert(termStartEnvelopes(s, "summer").length === 1, "still exactly one summer email");
    });

    // --- ACCEPTANCE, part 2: MEMBERS' CLASSES SEND FIRST ---
    check("Members' classes send FIRST within a term-start batch", function () {
      var s = emptyState();
      // Insert the NON-member first, so ordering is not just insertion order.
      s = addClass(s, "freeCamp", { id: "f1", label: "Free Camp", addedTerm: "summer" }).state;
      s = addFollower(s, "freeCamp", { email: "shared@example.com", marketingOptIn: true }).state;
      s = setMember(s, "memberCamp", true);
      s = addClass(s, "memberCamp", { id: "m1", label: "Member Camp", addedTerm: "summer" }).state;
      s = addFollower(s, "memberCamp", { email: "shared@example.com", marketingOptIn: true }).state;

      var batch = buildTermStartBatch(s, "summer");
      HC.assert(batch.length === 2, "two envelopes for the shared follower (one per camp), got " + batch.length);
      HC.assert(memberSendsFirst(batch) === true, "Member envelopes are wholly ahead of non-member ones");

      // The first envelope in the queue is the Member's, despite being added 2nd.
      var ordered = batch.slice().sort(function (a, b) { return a.priority - b.priority; });
      HC.assert(ordered[0].isMember === true, "the first-sent envelope is the Member's");
      HC.assert(ordered[0].providerId === "memberCamp", "Member camp goes out before the free camp");
      HC.assert(ordered[1].isMember === false, "the non-member camp follows");
    });

    check("With multiple members and non-members, ALL members precede ALL non-members", function () {
      var s = emptyState();
      s = addClass(s, "free1", { id: "f1", addedTerm: "summer" }).state;
      s = addFollower(s, "free1", { email: "x@example.com", marketingOptIn: true }).state;
      s = setMember(s, "mem1", true);
      s = addClass(s, "mem1", { id: "m1", addedTerm: "summer" }).state;
      s = addFollower(s, "mem1", { email: "x@example.com", marketingOptIn: true }).state;
      s = addClass(s, "free2", { id: "f2", addedTerm: "summer" }).state;
      s = addFollower(s, "free2", { email: "x@example.com", marketingOptIn: true }).state;
      s = setMember(s, "mem2", true);
      s = addClass(s, "mem2", { id: "m2", addedTerm: "summer" }).state;
      s = addFollower(s, "mem2", { email: "x@example.com", marketingOptIn: true }).state;

      var batch = buildTermStartBatch(s, "summer");
      var ordered = batch.slice().sort(function (a, b) { return a.priority - b.priority; });
      HC.assert(ordered.length === 4, "four envelopes");
      HC.assert(ordered[0].isMember && ordered[1].isMember, "the first two sent are both Members");
      HC.assert(!ordered[2].isMember && !ordered[3].isMember, "the last two sent are non-members");
      HC.assert(memberSendsFirst(batch) === true, "members-first holds across the whole batch");
    });

    // --- ACCEPTANCE, part 3: MID-TERM NEW-CLASS ALERTS (MEMBER ONLY) ---
    check("A Member adding a camp mid-term fires a new-class alert to its followers", function () {
      var s = emptyState();
      s = setMember(s, "memberCamp", true);
      s = addClass(s, "memberCamp", { id: "m1", label: "Member Camp wk1", addedTerm: "summer" }).state;
      s = addFollower(s, "memberCamp", { email: "f1@example.com", marketingOptIn: true }).state;
      s = addFollower(s, "memberCamp", { email: "f2@example.com", marketingOptIn: false }).state;
      // term-start already happened; now a NEW camp is added mid-term
      s = sendTermStart(s, "summer").state;
      var res = announceNewClass(s, "memberCamp", { id: "m2", label: "Member Camp wk2", addedTerm: "summer" }, "summer");
      s = res.state;
      HC.assert(res.suppressed === false, "the alert is NOT suppressed for a Member");
      HC.assert(res.alertsSent === 2, "both followers get the new-class alert, got " + res.alertsSent);
      var alerts = newClassAlerts(s);
      HC.assert(alerts.length === 2, "two new-class-alert envelopes in the log");
      HC.assert(alerts[0].classIds.indexOf("m2") !== -1, "the alert names the newly-added camp");
      HC.assert(alerts[0].kind === "new-class-alert", "envelope kind is new-class-alert");
    });

    check("A NON-member adding a camp mid-term fires NO alert (member-only benefit)", function () {
      var s = emptyState();
      s = setMember(s, "freeCamp", false);
      s = addClass(s, "freeCamp", { id: "f1", label: "Free Camp wk1", addedTerm: "summer" }).state;
      s = addFollower(s, "freeCamp", { email: "f1@example.com", marketingOptIn: true }).state;
      s = sendTermStart(s, "summer").state;
      var before = newClassAlerts(s).length;
      var res = announceNewClass(s, "freeCamp", { id: "f2", label: "Free Camp wk2", addedTerm: "summer" }, "summer");
      s = res.state;
      HC.assert(res.suppressed === true, "the mid-term alert is suppressed");
      HC.assert(res.reason === "not-member", "suppressed precisely because they are not a Member");
      HC.assert(res.alertsSent === 0, "no alerts sent");
      HC.assert(newClassAlerts(s).length === before, "the new-class-alert count did not change");
      // ...but the class IS still recorded for the next term-start timetable
      HC.assert(s.providers.freeCamp.classes.length === 2, "the new camp is still on the timetable for next term");
    });

    check("Mid-term: a Member with no followers yet sends nothing (no error)", function () {
      var s = emptyState();
      s = setMember(s, "memberCamp", true);
      var res = announceNewClass(s, "memberCamp", { id: "m1", label: "wk1", addedTerm: "summer" }, "summer");
      s = res.state;
      HC.assert(res.suppressed === true && res.reason === "no-followers", "no followers -> nothing to alert");
      HC.assert(res.alertsSent === 0, "zero alerts");
    });

    // --- end-to-end: the full acceptance sentence in one scenario ---
    check("End-to-end: term-start to all, Members first, then mid-term Member alert", function () {
      var s = emptyState();
      // free camp added first (insertion order) but should NOT win the queue
      s = addClass(s, "free", { id: "free1", addedTerm: "summer" }).state;
      s = addFollower(s, "free", { email: "shared@example.com", marketingOptIn: true }).state;
      // member camp
      s = setMember(s, "mem", true);
      s = addClass(s, "mem", { id: "mem1", addedTerm: "summer" }).state;
      s = addFollower(s, "mem", { email: "shared@example.com", marketingOptIn: true }).state;
      s = addFollower(s, "mem", { email: "memfan@example.com", marketingOptIn: false }).state;

      // 1) TERM START — everyone's followers get a timetable email
      var ts = sendTermStart(s, "summer"); s = ts.state;
      HC.assert(ts.sent === 3, "3 term-start emails (free×1 + member×2), got " + ts.sent);
      HC.assert(memberSendsFirst(ts.batch) === true, "the member camp's emails are sent first");

      // 2) MID-TERM — only the Member's new camp triggers alerts
      var midMember = announceNewClass(s, "mem", { id: "mem2", addedTerm: "summer" }, "summer");
      s = midMember.state;
      HC.assert(midMember.alertsSent === 2, "the Member's 2 followers get a mid-term alert");
      var midFree = announceNewClass(s, "free", { id: "free2", addedTerm: "summer" }, "summer");
      s = midFree.state;
      HC.assert(midFree.suppressed === true, "the free camp's mid-term add raises no alert");

      // The shared follower ends with: 1 term-start (from free) + 1 term-start
      // (from member) + 1 mid-term member alert = 3 emails.
      var inbox = inboxFor(s, "shared@example.com");
      HC.assert(inbox.length === 3, "shared follower got 2 term-start + 1 member alert = 3, got " + inbox.length);
      HC.assert(newClassAlerts(s).length === 2, "only the Member generated mid-term alerts");
    });

    // --- seeding from LIVE school-age holiday-camp directory ---
    check("Engine seeds from the live holiday-camp directory and can distribute", function () {
      var s = buildSeedState(5);
      var ids = Object.keys(s.providers || {});
      HC.assert(ids.length >= 1, "at least one provider seeded");
      var anyMember = ids.some(function (id) { return s.providers[id].isMember; });
      var anyClass = ids.some(function (id) { return (s.providers[id].classes || []).length > 0; });
      var anyFollower = ids.some(function (id) { return (s.providers[id].followers || []).length > 0; });
      HC.assert(anyMember, "at least one seeded provider is a Member");
      HC.assert(anyClass, "seeded providers have camp classes");
      HC.assert(anyFollower, "seeded providers have followers");
      var res = sendTermStart(s, "summer");
      HC.assert(res.sent > 0, "the seeded engine sends real term-start emails, got " + res.sent);
      HC.assert(memberSendsFirst(res.batch) === true, "members-first holds on live-seeded data");
      // confirm the seed providers are real directory entries when data is present
      var ps = providers();
      if (ps.length) {
        var realHit = ids.some(function (id) { return ps.some(function (p) { return p && p.id === id; }); });
        HC.assert(realHit, "seeded providers map to the live directory");
      }
    });

    // --- defensive / idempotency ---
    check("Defensive: bad inputs never throw or corrupt the engine", function () {
      var s = emptyState();
      HC.assert(addFollower(s, "", { email: "x@example.com" }).added === false, "no provider id is a no-op");
      HC.assert(addFollower(s, "p", { email: "" }).added === false, "empty email cannot follow");
      HC.assert(buildTermStartBatch(null, "summer").length === 0, "null state builds an empty batch");
      HC.assert(sendTermStart(emptyState(), "summer").sent === 0, "no providers -> nothing sent");
      var bad = announceNewClass(emptyState(), "ghost", { id: "z" }, "summer");
      HC.assert(bad.suppressed === false || bad.suppressed === true, "announce never throws");
      // a provider with classes but zero followers sends nothing at term start
      var s2 = addClass(emptyState(), "lonely", { id: "l1", addedTerm: "summer" }).state;
      HC.assert(sendTermStart(s2, "summer").sent === 0, "no followers -> no term-start emails");
    });

    check("Following twice does not duplicate a follower (no double emails)", function () {
      var s = emptyState();
      s = addClass(s, "campA", { id: "a1", addedTerm: "summer" }).state;
      var r1 = addFollower(s, "campA", { email: "Dup@Example.com", marketingOptIn: false }); s = r1.state;
      var r2 = addFollower(s, "campA", { email: "dup@example.com", marketingOptIn: true }); s = r2.state;
      HC.assert(r1.added === true && r2.added === false, "second follow is not a new record");
      HC.assert(s.providers.campA.followers.length === 1, "one follower record");
      var res = sendTermStart(s, "summer");
      HC.assert(res.sent === 1, "the duplicate parent receives exactly one term-start email");
    });

    // --- persistence round-trips through HC.store (namespaced) ---
    check("Engine state persists via HC.store", function () {
      var s = buildSeedState(3);
      s = sendTermStart(s, "summer").state;
      var sentBefore = (s.sentLog || []).length;
      var ok = HC.store.set(STORE_KEY, s);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.providers && Array.isArray(got.sentLog), "engine survives a store round-trip");
      HC.assert((got.sentLog || []).length === sentBefore, "sent log survives persistence");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================ *
   *  register                                                    *
   * ============================================================ */

  HC.registerFeature({
    id: "platform-followers-engine",
    title: "Followers timetable-email engine",
    side: "platform",
    icon: "📨",
    summary: "The platform engine that distributes camp timetables to followers 4× a year at the start of " +
      "each term. Members' camps send first, and Members also get mid-term new-camp alerts whenever they add " +
      "a week during the term — like Happity's zero-effort email marketing.",
    render: render,
    selfTest: selfTest
  });
})();
