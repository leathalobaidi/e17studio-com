/* HolidayCamp feature — parent-whats-on-newsletter
 *
 * Receive the 'What's On' parent newsletter  (parent side)
 *
 * Replicates Happity's parent-facing "What's On" newsletter. Evidence:
 *   - 6081998 ("What is the What's On newsletter…"): "Every Sunday, we send out
 *     our much loved What's On newsletter to over 140k parents… showing
 *     recommended classes and activities for the week ahead. The newsletter
 *     chooses relevant classes for each mum/dad/caregiver, completely tailored
 *     to their preferences (e.g. location, age of their little one, days of the
 *     week they are free, etc)."
 *   - 8255771 ("Parents & Carers FAQs – Happity Newsletters…"): "Opt-in to our
 *     marketing to find out what's on in your area, receive our newsletter…";
 *     parents can "unsubscribe… at the bottom of any newsletter"; and "Update
 *     my email preferences… add or amend any details."
 *
 * This is the HAPPITY-SIDE digest (the whole directory), NOT a single
 * provider's own follow list (that is parent-follow). A parent SUBSCRIBES once
 * and gives three tailoring preferences — exactly the trio the article names:
 *     • AREA(s)   — location they want camps in
 *     • AGE BAND  — their child's age (camps are filtered to ones that fit)
 *     • FREE DAYS — days of the week they can do (Mon–Fri school holidays)
 * Each Sunday a "What's On" issue is built for that parent by matching the live
 * holiday-camp directory against those preferences.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): age bands are the
 * Reception→secondary spread (4–16), days are the weekday camp days, and areas
 * are the real Waltham Forest directory areas.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   A parent can subscribe; preference (area, age band, free days) is captured.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-whats-on-newsletter: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "parent_whats_on_subscription";

  // Holiday-camp weekday set (camps run school-holiday weekdays, Mon–Fri).
  var ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  /* ================= pure logic (testable, DOM-free) ================= */

  // Subscription shape (persisted as plain JSON via HC.store):
  //   {
  //     subscribed: Boolean,
  //     email: String,
  //     prefs: {
  //       areas:   [String],   // location preference (article: "in your area")
  //       childAge: Number|null, // child's age → resolved age band
  //       days:    [String]    // free days of the week (subset of ALL_DAYS)
  //     },
  //     subscribedAt: ISOString|null,
  //     issues: [ { id, builtAt, weekOf, matches:[{id,name}] } ]  // Sunday outbox
  //   }
  // Pure functions take a subscription, return a NEW one — never mutate in place.

  function emptySubscription() {
    return {
      subscribed: false,
      email: "",
      prefs: { areas: [], childAge: null, days: [] },
      subscribedAt: null,
      issues: []
    };
  }

  function clone(sub) {
    try { return JSON.parse(JSON.stringify(sub || {})); }
    catch (e) { return emptySubscription(); }
  }

  // Normalise whatever is on disk into a valid subscription object.
  function normalise(raw) {
    var s = emptySubscription();
    if (!raw || typeof raw !== "object") return s;
    s.subscribed = !!raw.subscribed;
    s.email = typeof raw.email === "string" ? raw.email : "";
    s.subscribedAt = typeof raw.subscribedAt === "string" ? raw.subscribedAt : null;
    var p = raw.prefs && typeof raw.prefs === "object" ? raw.prefs : {};
    s.prefs.areas = sanitiseList(p.areas);
    s.prefs.days = sanitiseDays(p.days);
    s.prefs.childAge = sanitiseAge(p.childAge);
    s.issues = Array.isArray(raw.issues) ? raw.issues : [];
    return s;
  }

  function sanitiseList(v) {
    if (!Array.isArray(v)) return [];
    var out = [], seen = {};
    for (var i = 0; i < v.length; i++) {
      var s = v[i];
      if (typeof s !== "string") continue;
      s = s.trim();
      if (!s || seen[s]) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  function sanitiseDays(v) {
    var list = sanitiseList(v);
    return list.filter(function (d) { return ALL_DAYS.indexOf(d) !== -1; });
  }

  function sanitiseAge(v) {
    // Treat empty/absent input as "no age". Number(null)/Number("") are 0, which
    // would otherwise masquerade as a real age, so guard those explicitly.
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    if (n <= 0) return null; // a holiday-camp child is never age 0 — treat as unset
    if (n > 25) n = 25; // clamp daft input
    return n;
  }

  // A school-age age band derived from the child's age. Holiday camps publish
  // age brackets; we bucket into the brackets parents actually pick from.
  function ageBandFor(age) {
    var a = sanitiseAge(age);
    if (a === null) return null;
    if (a <= 4) return { id: "early", label: "Early years (3–4)", min: 3, max: 4 };
    if (a <= 7) return { id: "infant", label: "Infants (5–7)", min: 5, max: 7 };
    if (a <= 11) return { id: "junior", label: "Juniors (8–11)", min: 8, max: 11 };
    return { id: "teen", label: "Teens (12–16)", min: 12, max: 16 };
  }

  // THE acceptance criterion in code: subscribe a parent and CAPTURE their three
  // preferences (area, age band, free days). Returns a new subscription.
  function subscribe(sub, email, prefs) {
    var next = clone(sub);
    prefs = prefs || {};
    next.subscribed = true;
    next.email = typeof email === "string" ? email.trim() : (next.email || "");
    next.prefs = {
      areas: sanitiseList(prefs.areas),
      childAge: sanitiseAge(prefs.childAge),
      days: sanitiseDays(prefs.days)
    };
    next.subscribedAt = next.subscribedAt || nowIso();
    if (!Array.isArray(next.issues)) next.issues = [];
    return next;
  }

  // Update any subset of preferences while staying subscribed (article 8255771
  // "Update my email preferences… add or amend any details").
  function updatePreferences(sub, patch) {
    var next = clone(sub);
    if (!next.prefs) next.prefs = { areas: [], childAge: null, days: [] };
    patch = patch || {};
    if (Object.prototype.hasOwnProperty.call(patch, "areas")) {
      next.prefs.areas = sanitiseList(patch.areas);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "days")) {
      next.prefs.days = sanitiseDays(patch.days);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "childAge")) {
      next.prefs.childAge = sanitiseAge(patch.childAge);
    }
    return next;
  }

  // Unsubscribe (article 8255771 "unsubscribe from the newsletter"). Keeps the
  // captured preferences so re-subscribing is one click, but stops issues.
  function unsubscribe(sub) {
    var next = clone(sub);
    next.subscribed = false;
    return next;
  }

  // Has this parent captured the full preference trio the newsletter tailors on?
  function preferencesCaptured(sub) {
    if (!sub || !sub.prefs) return false;
    return sub.prefs.areas.length > 0 &&
      sub.prefs.childAge !== null &&
      sub.prefs.days.length > 0;
  }

  // Does a camp serve any of the parent's preferred areas?
  function matchesArea(provider, areas) {
    if (!areas || !areas.length) return false;
    var hay = providerAreas(provider).map(lower);
    for (var i = 0; i < areas.length; i++) {
      var want = lower(areas[i]);
      // borough-wide / london serve everyone; otherwise substring either way
      for (var j = 0; j < hay.length; j++) {
        var h = hay[j];
        if (h === "borough-wide" || h === "london" || h === "waltham forest") return true;
        if (h.indexOf(want) !== -1 || want.indexOf(h) !== -1) return true;
      }
    }
    return false;
  }

  function providerAreas(provider) {
    if (!provider) return [];
    var out = [];
    if (Array.isArray(provider.areas)) out = out.concat(provider.areas);
    if (provider.area) out.push(provider.area);
    return out.filter(function (x) { return typeof x === "string" && x; });
  }

  // Does a camp's published age range overlap the child's age?
  function matchesAge(provider, age) {
    var a = sanitiseAge(age);
    if (a === null) return false;
    var min = Number(provider && provider.ageMin);
    var max = Number(provider && provider.ageMax);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 99;
    return a >= min && a <= max;
  }

  // Build a parent's "What's On" issue for a given Sunday: scan the directory
  // and keep camps that match BOTH their area AND their child's age. (Free days
  // are a captured tailoring preference shown in the issue header; live data has
  // no per-day field, so day filtering is informational, matching the article's
  // "days of the week they are free" tailoring intent without inventing data.)
  // Returns { sub, issue, delivered }.
  function buildWeeklyIssue(sub, directory, weekOf) {
    var next = clone(sub);
    if (!Array.isArray(next.issues)) next.issues = [];
    var matches = [];
    if (next.subscribed) {
      var ps = Array.isArray(directory) ? directory : [];
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (!p || !p.id) continue;
        if (matchesArea(p, next.prefs.areas) && matchesAge(p, next.prefs.childAge)) {
          matches.push({ id: p.id, name: p.name || p.id });
        }
      }
    }
    var issue = {
      id: safeUid(),
      builtAt: nowIso(),
      weekOf: weekOf || nowIso().slice(0, 10),
      days: (next.prefs && next.prefs.days) ? next.prefs.days.slice() : [],
      matches: matches
    };
    var delivered = false;
    // Only a SUBSCRIBED parent with a real email receives the Sunday issue.
    if (next.subscribed && next.email) {
      next.issues.push(issue);
      delivered = true;
    }
    return { sub: next, issue: issue, delivered: delivered };
  }

  function issueCount(sub) {
    return (sub && Array.isArray(sub.issues)) ? sub.issues.length : 0;
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }
  function lower(s) { return String(s == null ? "" : s).toLowerCase().trim(); }

  /* ================= persistence (HC.store only) ================= */

  function loadSub() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    return normalise(raw);
  }
  function saveSub(sub) {
    try { HC.store.set(STORE_KEY, sub); } catch (e) {}
  }

  /* ================= live camp data ================= */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // The distinct, human-friendly areas offered as location choices, drawn from
  // the live directory. Falls back to the core Waltham Forest towns.
  function areaChoices() {
    var ps = providers();
    var seen = {}, out = [];
    function add(a) {
      if (typeof a !== "string") return;
      a = a.trim();
      if (!a || a === "Borough-wide" || a === "London" || a === "Waltham Forest" ||
        a.indexOf("/") !== -1) return; // skip composite/blanket labels for the picker
      if (seen[a]) return;
      seen[a] = true; out.push(a);
    }
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (Array.isArray(p.areas)) p.areas.forEach(add);
      else add(p.area);
    }
    if (!out.length) {
      out = ["Walthamstow", "Leyton", "Leytonstone", "Chingford", "Highams Park", "Wanstead"];
    }
    out.sort();
    return out;
  }

  /* ================= UI ================= */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    var sub = loadSub();
    mountEl.innerHTML = "";

    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Every Sunday night we send the <strong>What's On</strong> holiday-camp newsletter — " +
      "a shortlist of camps for the week ahead, tailored to you. Tell us three things and " +
      "we'll match the directory to your family: where you want camps, your child's age, and " +
      "which days you're free."));

    // ---- email ----
    var emailRow = HC.util.el("div", { style: "margin:0 0 14px" });
    emailRow.appendChild(fieldLabel("Your email for the newsletter"));
    var emailInput = HC.util.el("input", {
      type: "email", placeholder: "you@example.com", value: sub.email || "",
      style: inputStyle()
    });
    emailRow.appendChild(emailInput);
    wrap.appendChild(emailRow);

    // ---- AREA preference (multi-select chips) ----
    var areaRow = HC.util.el("div", { style: "margin:0 0 14px" });
    areaRow.appendChild(fieldLabel("Areas you'd consider"));
    var areaBox = HC.util.el("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    var selectedAreas = {};
    sub.prefs.areas.forEach(function (a) { selectedAreas[a] = true; });
    areaChoices().forEach(function (a) {
      var chip = chipButton(a, !!selectedAreas[a]);
      chip.addEventListener("click", function () {
        selectedAreas[a] = !selectedAreas[a];
        setChipState(chip, selectedAreas[a]);
      });
      areaBox.appendChild(chip);
    });
    areaRow.appendChild(areaBox);
    wrap.appendChild(areaRow);

    // ---- AGE preference ----
    var ageRow = HC.util.el("div", { style: "margin:0 0 14px" });
    ageRow.appendChild(fieldLabel("Your child's age"));
    var ageInput = HC.util.el("input", {
      type: "number", min: "3", max: "16", placeholder: "e.g. 8",
      value: (sub.prefs.childAge === null ? "" : String(sub.prefs.childAge)),
      style: inputStyle().replace("max-width:320px", "max-width:120px")
    });
    var ageBandHint = HC.util.el("span", {
      style: "font-size:12.5px;color:var(--muted,#808080);margin-left:10px"
    });
    ageRow.appendChild(ageInput);
    ageRow.appendChild(ageBandHint);
    wrap.appendChild(ageRow);

    function paintBand() {
      var band = ageBandFor(ageInput.value);
      ageBandHint.textContent = band ? "→ " + band.label : "";
    }
    ageInput.addEventListener("input", paintBand);
    paintBand();

    // ---- FREE DAYS preference ----
    var daysRow = HC.util.el("div", { style: "margin:0 0 16px" });
    daysRow.appendChild(fieldLabel("Days you're free"));
    var daysBox = HC.util.el("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    var selectedDays = {};
    sub.prefs.days.forEach(function (d) { selectedDays[d] = true; });
    ALL_DAYS.forEach(function (d) {
      var chip = chipButton(d, !!selectedDays[d]);
      chip.addEventListener("click", function () {
        selectedDays[d] = !selectedDays[d];
        setChipState(chip, selectedDays[d]);
      });
      daysBox.appendChild(chip);
    });
    daysRow.appendChild(daysBox);
    wrap.appendChild(daysRow);

    // ---- actions ----
    var btnRow = HC.util.el("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center" });
    var subBtn = HC.util.el("button", { class: "hc-btn", type: "button" });
    var previewBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" },
      "Preview this Sunday's issue");
    var unsubBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Unsubscribe");
    btnRow.appendChild(subBtn);
    btnRow.appendChild(previewBtn);
    btnRow.appendChild(unsubBtn);
    wrap.appendChild(btnRow);

    var status = HC.util.el("div", {
      style: "font-size:12.5px;color:var(--muted,#808080);margin-top:12px"
    });
    wrap.appendChild(status);

    var issueBox = HC.util.el("div", { style: "margin-top:14px" });
    wrap.appendChild(issueBox);

    mountEl.appendChild(wrap);

    function collectPrefs() {
      return {
        areas: Object.keys(selectedAreas).filter(function (k) { return selectedAreas[k]; }),
        childAge: ageInput.value,
        days: Object.keys(selectedDays).filter(function (k) { return selectedDays[k]; })
      };
    }

    function paint() {
      subBtn.textContent = sub.subscribed ? "✓ Subscribed · save changes" : "Subscribe to What's On";
      subBtn.setAttribute("style", sub.subscribed ? "background:var(--purple,#603488);color:#fff" : "");
      unsubBtn.style.display = sub.subscribed ? "" : "none";
      previewBtn.disabled = !sub.subscribed;
      previewBtn.style.opacity = sub.subscribed ? "1" : "0.5";

      if (sub.subscribed) {
        var band = ageBandFor(sub.prefs.childAge);
        status.innerHTML = "You're subscribed. Tailored to <strong>" +
          (sub.prefs.areas.length ? esc(sub.prefs.areas.join(", ")) : "no areas yet") +
          "</strong> · " + (band ? esc(band.label) : "no age yet") + " · " +
          (sub.prefs.days.length ? esc(sub.prefs.days.join("/")) : "no days yet") +
          (issueCount(sub) ? " · " + issueCount(sub) + " issue(s) sent." : ".");
      } else {
        status.textContent = "Not subscribed yet — fill in your preferences and subscribe.";
      }

      var latest = issueCount(sub) ? sub.issues[sub.issues.length - 1] : null;
      if (latest) {
        issueBox.innerHTML =
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:14px 16px;background:#fff">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
          "What's On · week of " + esc(latest.weekOf) + "</div>" +
          '<div style="font-size:12.5px;color:var(--muted,#808080);margin:2px 0 8px">' +
          latest.matches.length + " camp" + (latest.matches.length === 1 ? "" : "s") +
          " for your family" + (latest.days && latest.days.length ? " · " + esc(latest.days.join("/")) : "") + "</div>" +
          (latest.matches.length
            ? '<ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.7">' +
              latest.matches.slice(0, 8).map(function (m) { return "<li>" + esc(m.name) + "</li>"; }).join("") +
              (latest.matches.length > 8 ? "<li>…and " + (latest.matches.length - 8) + " more</li>" : "") +
              "</ul>"
            : '<p style="font-size:13px;color:var(--muted,#808080);margin:0">No camps matched your preferences this week — widen your areas or days.</p>') +
          "</div>";
      } else {
        issueBox.innerHTML = "";
      }
    }

    subBtn.addEventListener("click", function () {
      var email = (emailInput.value || "").trim();
      if (!email) {
        try { HC.util.toast("Add your email so we can send the newsletter"); } catch (e) {}
        emailInput.focus();
        return;
      }
      sub = subscribe(sub, email, collectPrefs());
      saveSub(sub);
      try {
        HC.util.toast(preferencesCaptured(sub)
          ? "Subscribed — your What's On is tailored"
          : "Subscribed — add area, age & days for tailoring");
      } catch (e) {}
      paint();
    });

    previewBtn.addEventListener("click", function () {
      // keep prefs current first, then build a live issue from the directory
      sub = updatePreferences(sub, collectPrefs());
      saveSub(sub);
      var res = buildWeeklyIssue(sub, providers());
      sub = res.sub;
      saveSub(sub);
      try {
        HC.util.toast(res.delivered
          ? "This Sunday's issue: " + res.issue.matches.length + " camps"
          : "Subscribe with an email to receive issues");
      } catch (e) {}
      paint();
    });

    unsubBtn.addEventListener("click", function () {
      sub = unsubscribe(sub);
      saveSub(sub);
      try { HC.util.toast("Unsubscribed — your preferences are kept"); } catch (e) {}
      paint();
    });

    paint();
  }

  function fieldLabel(text) {
    return HC.util.el("label", {
      style: "display:block;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:12px;" +
        "text-transform:uppercase;letter-spacing:.5px;color:var(--magenta,#F82488);margin:0 0 6px"
    }, esc(text));
  }
  function inputStyle() {
    return "width:100%;max-width:320px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);" +
      "border-radius:10px;font-size:14px;box-sizing:border-box";
  }
  function chipButton(label, on) {
    var b = HC.util.el("button", { type: "button" }, esc(label));
    setChipState(b, on);
    return b;
  }
  function setChipState(b, on) {
    b.setAttribute("style",
      "cursor:pointer;border-radius:999px;font-size:13px;padding:6px 13px;font-family:'Quicksand',system-ui,sans-serif;" +
      "font-weight:700;" + (on
        ? "background:var(--purple,#603488);color:#fff;border:1.5px solid var(--purple,#603488)"
        : "background:#fff;color:var(--purple,#603488);border:1.5px solid var(--line,#E6E6E6)"));
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /* ================= selfTest ================= */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Mini directory standing in for the live data (matches its shape).
    var dir = [
      { id: "stow-8", name: "Walthamstow Multi-Sports", areas: ["Walthamstow"], ageMin: 5, ageMax: 11 },
      { id: "leyton-teen", name: "Leyton Teen Coding Camp", areas: ["Leyton"], ageMin: 12, ageMax: 16 },
      { id: "chingford-arts", name: "Chingford Arts Week", areas: ["Chingford"], ageMin: 4, ageMax: 8 },
      { id: "boroughwide-haf", name: "HAF Borough Programme", areas: ["Borough-wide"], ageMin: 5, ageMax: 16 },
      { id: "wanstead-early", name: "Wanstead Early Years Play", areas: ["Wanstead"], ageMin: 3, ageMax: 4 }
    ];

    /* --- ACCEPTANCE CRITERION: subscribe captures area, age band, free days --- */
    check("ACCEPTANCE: a parent can subscribe and area, age band & free days are captured", function () {
      var s = emptySubscription();
      HC.assert(s.subscribed === false, "starts unsubscribed");
      s = subscribe(s, "leath@example.com", {
        areas: ["Walthamstow", "Leyton"],
        childAge: 8,
        days: ["Mon", "Tue", "Wed"]
      });
      HC.assert(s.subscribed === true, "parent is now subscribed");
      HC.assert(s.email === "leath@example.com", "email captured for delivery");
      // AREA captured
      HC.assert(s.prefs.areas.length === 2 &&
        s.prefs.areas.indexOf("Walthamstow") !== -1 &&
        s.prefs.areas.indexOf("Leyton") !== -1, "area preference captured");
      // AGE BAND captured (age → resolved band)
      HC.assert(s.prefs.childAge === 8, "child age captured");
      var band = ageBandFor(s.prefs.childAge);
      HC.assert(band && band.id === "junior", "age 8 resolves to the Juniors (8–11) band, got " + (band && band.id));
      // FREE DAYS captured
      HC.assert(s.prefs.days.length === 3 &&
        s.prefs.days.indexOf("Mon") !== -1 && s.prefs.days.indexOf("Wed") !== -1, "free days captured");
      // all three captured
      HC.assert(preferencesCaptured(s) === true, "the full preference trio is captured");
      HC.assert(typeof s.subscribedAt === "string" && s.subscribedAt.length > 0, "subscription timestamp recorded");
    });

    // Age band buckets are the school-age brackets (not baby classes).
    check("Age bands cover the school-age spread 3→16", function () {
      HC.assert(ageBandFor(3).id === "early", "3 → early years");
      HC.assert(ageBandFor(4).id === "early", "4 → early years");
      HC.assert(ageBandFor(5).id === "infant", "5 → infants");
      HC.assert(ageBandFor(7).id === "infant", "7 → infants");
      HC.assert(ageBandFor(8).id === "junior", "8 → juniors");
      HC.assert(ageBandFor(11).id === "junior", "11 → juniors");
      HC.assert(ageBandFor(12).id === "teen", "12 → teens");
      HC.assert(ageBandFor(16).id === "teen", "16 → teens");
      HC.assert(ageBandFor(null) === null, "no age → no band");
    });

    // preferencesCaptured requires ALL THREE — partial subscription is flagged.
    check("Preference capture requires all three of area, age and days", function () {
      var s = subscribe(emptySubscription(), "p@x.com", { areas: ["Leyton"], childAge: 9, days: ["Mon"] });
      HC.assert(preferencesCaptured(s) === true, "complete prefs pass");
      HC.assert(preferencesCaptured(subscribe(emptySubscription(), "p@x.com",
        { areas: [], childAge: 9, days: ["Mon"] })) === false, "missing area fails");
      HC.assert(preferencesCaptured(subscribe(emptySubscription(), "p@x.com",
        { areas: ["Leyton"], childAge: null, days: ["Mon"] })) === false, "missing age fails");
      HC.assert(preferencesCaptured(subscribe(emptySubscription(), "p@x.com",
        { areas: ["Leyton"], childAge: 9, days: [] })) === false, "missing days fails");
    });

    // Inputs are sanitised: dupes dropped, junk days rejected, age clamped/typed.
    check("Captured preferences are sanitised (dupes, bad days, age coercion)", function () {
      var s = subscribe(emptySubscription(), "  p@x.com  ", {
        areas: ["Leyton", "Leyton", "  ", 42, "Chingford"],
        childAge: "10",            // string number
        days: ["Mon", "Mon", "Funday", "Sat"] // dupe + invalid (Sat isn't a camp weekday here)
      });
      HC.assert(s.email === "p@x.com", "email trimmed");
      HC.assert(s.prefs.areas.length === 2, "duplicate/blank/non-string areas removed, got " + s.prefs.areas.length);
      HC.assert(s.prefs.childAge === 10, "string age coerced to number");
      HC.assert(s.prefs.days.length === 1 && s.prefs.days[0] === "Mon",
        "invalid days dropped, only Mon kept, got " + JSON.stringify(s.prefs.days));
    });

    // The Sunday issue is TAILORED: only camps matching area AND age appear.
    check("Weekly issue is tailored to the captured area & age preferences", function () {
      var s = subscribe(emptySubscription(), "p@x.com", {
        areas: ["Walthamstow"], childAge: 8, days: ["Mon"]
      });
      var res = buildWeeklyIssue(s, dir, "2026-07-26");
      HC.assert(res.delivered === true, "a subscribed parent with an email gets the issue");
      var ids = res.issue.matches.map(function (m) { return m.id; });
      HC.assert(ids.indexOf("stow-8") !== -1, "Walthamstow 5–11 camp matches an 8yo in Walthamstow");
      HC.assert(ids.indexOf("boroughwide-haf") !== -1, "borough-wide camp reaches every area");
      HC.assert(ids.indexOf("leyton-teen") === -1, "a Leyton teen camp does NOT match an 8yo Walthamstow parent");
      HC.assert(ids.indexOf("wanstead-early") === -1, "a Wanstead early-years camp does not match (wrong area & age)");
      HC.assert(res.issue.days.indexOf("Mon") !== -1, "the issue carries the parent's free days for context");
    });

    // Age tailoring excludes camps the child has aged out of / into.
    check("Age band filters camps a child is too old or too young for", function () {
      var teen = subscribe(emptySubscription(), "p@x.com", { areas: ["Leyton"], childAge: 14, days: ["Tue"] });
      var ids = buildWeeklyIssue(teen, dir).issue.matches.map(function (m) { return m.id; });
      HC.assert(ids.indexOf("leyton-teen") !== -1, "a 14yo matches the Leyton teen camp");
      var tot = subscribe(emptySubscription(), "p@x.com", { areas: ["Chingford"], childAge: 4, days: ["Tue"] });
      var ids2 = buildWeeklyIssue(tot, dir).issue.matches.map(function (m) { return m.id; });
      HC.assert(ids2.indexOf("chingford-arts") !== -1, "a 4yo matches the 4–8 Chingford arts camp");
    });

    // No matches must produce a clean (empty) issue, not an error. (Use a
    // directory WITHOUT the borough-wide camp, which by design reaches everyone.)
    check("An issue with no matching camps is delivered empty, not broken", function () {
      var localDir = dir.filter(function (p) { return p.id !== "boroughwide-haf"; });
      var s = subscribe(emptySubscription(), "p@x.com", { areas: ["Loughton"], childAge: 8, days: ["Mon"] });
      var res = buildWeeklyIssue(s, localDir);
      HC.assert(res.delivered === true, "still delivered to a subscriber");
      HC.assert(res.issue.matches.length === 0, "no camps match an out-of-area parent here");
    });

    // Borough-wide / blanket-area camps deliberately reach every subscriber.
    check("Borough-wide camps reach a subscriber in any area", function () {
      var s = subscribe(emptySubscription(), "p@x.com", { areas: ["Loughton"], childAge: 8, days: ["Mon"] });
      var ids = buildWeeklyIssue(s, dir).issue.matches.map(function (m) { return m.id; });
      HC.assert(ids.indexOf("boroughwide-haf") !== -1, "the borough-wide HAF camp reaches a Loughton parent");
      HC.assert(ids.indexOf("stow-8") === -1, "a Walthamstow-only camp does not reach a Loughton parent");
    });

    // Updating preferences re-tailors future issues (article: "amend any details").
    check("Updating preferences changes who/what the newsletter matches", function () {
      var s = subscribe(emptySubscription(), "p@x.com", { areas: ["Walthamstow"], childAge: 8, days: ["Mon"] });
      var before = buildWeeklyIssue(s, dir).issue.matches.map(function (m) { return m.id; });
      HC.assert(before.indexOf("chingford-arts") === -1, "Chingford camp not matched before update");
      s = updatePreferences(s, { areas: ["Chingford"], childAge: 6 });
      HC.assert(s.subscribed === true, "still subscribed after a preference update");
      HC.assert(s.prefs.areas[0] === "Chingford" && s.prefs.childAge === 6, "prefs amended");
      HC.assert(s.prefs.days.indexOf("Mon") !== -1, "untouched preference (days) is preserved");
      var after = buildWeeklyIssue(s, dir).issue.matches.map(function (m) { return m.id; });
      HC.assert(after.indexOf("chingford-arts") !== -1, "Chingford 4–8 camp now matches a 6yo in Chingford");
    });

    // Unsubscribe stops delivery but PRESERVES captured preferences.
    check("Unsubscribe stops issues yet keeps the captured preferences", function () {
      var s = subscribe(emptySubscription(), "p@x.com", { areas: ["Walthamstow"], childAge: 8, days: ["Mon"] });
      s = unsubscribe(s);
      HC.assert(s.subscribed === false, "no longer subscribed");
      HC.assert(s.prefs.areas[0] === "Walthamstow" && s.prefs.childAge === 8 && s.prefs.days[0] === "Mon",
        "preferences retained for easy re-subscribe");
      var res = buildWeeklyIssue(s, dir);
      HC.assert(res.delivered === false, "an unsubscribed parent receives no Sunday issue");
      HC.assert(issueCount(res.sub) === 0, "no issue is recorded for an unsubscribed parent");
    });

    // A subscription with no email cannot be delivered (email IS the channel).
    check("A subscription with no email captures prefs but cannot be delivered", function () {
      var s = subscribe(emptySubscription(), "", { areas: ["Walthamstow"], childAge: 8, days: ["Mon"] });
      HC.assert(s.subscribed === true, "still marked subscribed");
      HC.assert(preferencesCaptured(s) === true, "preferences still captured without an email");
      var res = buildWeeklyIssue(s, dir);
      HC.assert(res.delivered === false, "cannot deliver with no address on file");
    });

    // Repeat Sundays accumulate issues in the parent's outbox.
    check("Successive Sundays accumulate newsletter issues", function () {
      var s = subscribe(emptySubscription(), "p@x.com", { areas: ["Walthamstow"], childAge: 8, days: ["Mon"] });
      s = buildWeeklyIssue(s, dir, "2026-07-26").sub;
      s = buildWeeklyIssue(s, dir, "2026-08-02").sub;
      s = buildWeeklyIssue(s, dir, "2026-08-09").sub;
      HC.assert(issueCount(s) === 3, "three weekly issues recorded, got " + issueCount(s));
      HC.assert(s.issues[2].weekOf === "2026-08-09", "the latest issue is the most recent week");
    });

    // Defensive: junk inputs and an empty directory must not throw.
    check("Defensive against junk input and an empty directory", function () {
      var s = subscribe(null, null, null);
      HC.assert(s.subscribed === true, "subscribing with null args still yields a valid subscription");
      HC.assert(preferencesCaptured(s) === false, "no prefs captured from null");
      var res = buildWeeklyIssue(s, null);
      HC.assert(res.issue.matches.length === 0, "no directory → no matches, no throw");
      HC.assert(normalise("not an object").subscribed === false, "garbage on disk normalises to a clean sub");
    });

    // Persistence round-trips through HC.store (namespaced, not raw localStorage).
    check("Subscription & captured preferences persist via HC.store", function () {
      var s = subscribe(emptySubscription(), "persist@x.com", {
        areas: ["Walthamstow", "Leyton"], childAge: 10, days: ["Mon", "Fri"]
      });
      s = buildWeeklyIssue(s, dir, "2026-07-26").sub;
      var ok = HC.store.set(STORE_KEY, s);
      HC.assert(ok !== false, "store.set should succeed");
      var got = normalise(HC.store.get(STORE_KEY, null));
      HC.assert(got.subscribed === true, "subscription survives a store round-trip");
      HC.assert(got.email === "persist@x.com", "email survives persistence");
      HC.assert(got.prefs.areas.length === 2, "captured areas survive persistence");
      HC.assert(got.prefs.childAge === 10, "captured age survives persistence");
      HC.assert(got.prefs.days.length === 2, "captured free days survive persistence");
      HC.assert(issueCount(got) === 1, "a delivered issue survives persistence");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // Area choices are drawn from the LIVE school-age directory when present.
    check("Area choices come from the live holiday-camp directory", function () {
      var choices = areaChoices();
      HC.assert(Array.isArray(choices) && choices.length > 0, "there is at least one area to pick");
      var ps = providers();
      if (ps.length) {
        // every choice should appear somewhere in the real directory's areas
        var allAreas = {};
        ps.forEach(function (p) {
          (Array.isArray(p.areas) ? p.areas : [p.area]).forEach(function (a) {
            if (typeof a === "string") allAreas[a] = true;
          });
        });
        var grounded = choices.every(function (c) {
          // each picker area is a token of some real directory area string
          return Object.keys(allAreas).some(function (a) { return a.indexOf(c) !== -1; });
        });
        HC.assert(grounded, "every offered area is grounded in real directory data");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ================= register ================= */

  HC.registerFeature({
    id: "parent-whats-on-newsletter",
    title: "Receive the What's On newsletter",
    side: "parent",
    icon: "📮",
    summary: "Subscribe to the Sunday-night What's On holiday-camp newsletter. We capture three " +
      "tailoring preferences — your area, your child's age band, and the days you're free — and each " +
      "week match the live camp directory to your family, following the same marketplace pattern. Unsubscribe or amend " +
      "your details any time.",
    render: render,
    selfTest: selfTest
  });
})();
