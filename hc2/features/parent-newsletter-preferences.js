/* HolidayCamp feature — parent-newsletter-preferences
 *
 * Manage 'What's On' newsletter preferences / unsubscribe  (parent side)
 *
 * Replicates Happity's "Update my email preferences" flow. Evidence
 * (article 8255771 "Parents & Carers FAQs – Happity Newsletters…"):
 *   - "On the bottom of your weekly newsletter, you will see a button to a link
 *      that will direct you to 'Update my email preferences'. Here you can add
 *      or amend any details."
 *   - "If you would like to unsubscribe from the Happity newsletter, you can do
 *      this at the bottom of any previous newsletter email."
 *   - The What's On newsletter is "completely tailored to their preferences
 *      (e.g. location, age of their little one, days of the week they are free)".
 *
 * DISTINCT FROM parent-whats-on-newsletter:
 *   - That feature is the SUBSCRIBE flow (a brand-new parent opts in).
 *   - THIS feature is the MANAGE flow reached FROM a newsletter footer link: the
 *     parent is ALREADY on the list, arrives via a tokenised "Update my email
 *     preferences" / "Unsubscribe" link, and AMENDS an existing record or
 *     unsubscribes (and can re-subscribe). The unit of work is a one-click
 *     deep-link token → a preference centre, not a fresh sign-up form.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes):
 *   - LOCATION is a real Waltham Forest POSTCODE (E17, E11, E10, E4, IG8…) which
 *     we resolve to a directory AREA, plus optional extra areas.
 *   - CHILD AGE is the school-age spread (4–16) → a published age band.
 *   - AVAILABLE DAYS are the school-holiday camp weekdays (Mon–Fri).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   From a newsletter link, a parent can update personalisation preferences
 *   (postcode/area, child age, available days) AND unsubscribe — operating on an
 *   EXISTING subscription resolved from the link's token, not a fresh sign-up.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-newsletter-preferences: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Subscriber roster, keyed by link token. The "Update my email preferences"
  // and "Unsubscribe" links in a newsletter footer carry one of these tokens.
  var STORE_KEY = "parent_newsletter_roster";

  // Holiday-camp weekday set (camps run school-holiday weekdays, Mon–Fri).
  var ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  /* ============ postcode → area resolver (real Waltham Forest) ============ */
  // The article names "location"; the brief wants postcode/area. Holiday camps
  // here are Waltham Forest, whose postcode districts map onto directory areas.
  var POSTCODE_AREAS = {
    E17: "Walthamstow",
    E10: "Leyton",
    E11: "Leytonstone",
    E4: "Chingford",
    E18: "Woodford",      // South Woodford
    IG8: "Woodford",      // Woodford Green
    E7: "Walthamstow",    // Forest Gate fringe → nearest WF area
    NW: null
  };

  // Pull the outward postcode district (e.g. "E17 4QH" → "E17", "ig8 0hd"→"IG8").
  function outwardCode(postcode) {
    if (typeof postcode !== "string") return "";
    var pc = postcode.toUpperCase().replace(/\s+/g, "");
    if (!pc) return "";
    // outward = everything except the final 3 chars (the inward unit), but for
    // short/partial entries (just a district) keep what's there.
    var outward = pc.length > 3 ? pc.slice(0, pc.length - 3) : pc;
    // normalise to the letters+digits district token (drop any trailing junk)
    var m = outward.match(/^[A-Z]{1,2}\d{1,2}[A-Z]?/);
    return m ? m[0] : outward;
  }

  // Resolve a postcode to a directory AREA, or null if we can't place it.
  function areaForPostcode(postcode) {
    var out = outwardCode(postcode);
    if (!out) return null;
    if (POSTCODE_AREAS.hasOwnProperty(out)) return POSTCODE_AREAS[out];
    // Try the leading district letters (E18 → E1? no; but E4A style) — fall back
    // to the letter-prefixed district without a trailing letter.
    var base = out.match(/^[A-Z]{1,2}\d{1,2}/);
    if (base && POSTCODE_AREAS.hasOwnProperty(base[0])) return POSTCODE_AREAS[base[0]];
    return null;
  }

  function isWalthamForestPostcode(postcode) {
    return areaForPostcode(postcode) !== null;
  }

  /* ================= pure logic (testable, DOM-free) ================= */

  // Roster shape (persisted as plain JSON via HC.store):
  //   { byToken: { <token>: subscriber }, order: [token, …] }
  // Subscriber shape:
  //   {
  //     token:       String,   // opaque id carried by the newsletter link
  //     email:       String,
  //     subscribed:  Boolean,  // false once unsubscribed
  //     prefs: {
  //       postcode:  String,   // raw postcode the parent typed (article: location)
  //       area:      String,   // resolved/primary area
  //       extraAreas:[String], // additional areas they'd travel to
  //       childAge:  Number|null,
  //       days:      [String]  // available days (subset of ALL_DAYS)
  //     },
  //     updatedAt:   ISOString|null,
  //     unsubscribedAt: ISOString|null
  //   }
  // Pure functions take a subscriber and return a NEW one — never mutate in place.

  function emptyPrefs() {
    return { postcode: "", area: "", extraAreas: [], childAge: null, days: [] };
  }

  function clone(o) {
    try { return JSON.parse(JSON.stringify(o || {})); }
    catch (e) { return {}; }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }
  function lower(s) { return String(s == null ? "" : s).toLowerCase().trim(); }

  function sanitiseList(v) {
    if (!Array.isArray(v)) return [];
    var out = [], seen = {};
    for (var i = 0; i < v.length; i++) {
      var s = v[i];
      if (typeof s !== "string") continue;
      s = s.trim();
      if (!s || seen[s]) continue;
      seen[s] = true; out.push(s);
    }
    return out;
  }
  function sanitiseDays(v) {
    return sanitiseList(v).filter(function (d) { return ALL_DAYS.indexOf(d) !== -1; });
  }
  function sanitiseAge(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    if (n <= 0) return null;       // a holiday-camp child is never age 0 → unset
    if (n > 25) n = 25;            // clamp daft input
    return n;
  }

  // A school-age age band derived from the child's age (Reception → secondary).
  function ageBandFor(age) {
    var a = sanitiseAge(age);
    if (a === null) return null;
    if (a <= 4) return { id: "early", label: "Early years (3–4)", min: 3, max: 4 };
    if (a <= 7) return { id: "infant", label: "Infants (5–7)", min: 5, max: 7 };
    if (a <= 11) return { id: "junior", label: "Juniors (8–11)", min: 8, max: 11 };
    return { id: "teen", label: "Teens (12–16)", min: 12, max: 16 };
  }

  function emptyRoster() { return { byToken: {}, order: [] }; }

  function normaliseSubscriber(raw) {
    var s = {
      token: "", email: "", subscribed: true,
      prefs: emptyPrefs(), updatedAt: null, unsubscribedAt: null
    };
    if (!raw || typeof raw !== "object") return s;
    s.token = typeof raw.token === "string" ? raw.token : "";
    s.email = typeof raw.email === "string" ? raw.email : "";
    s.subscribed = raw.subscribed === undefined ? true : !!raw.subscribed;
    s.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
    s.unsubscribedAt = typeof raw.unsubscribedAt === "string" ? raw.unsubscribedAt : null;
    var p = raw.prefs && typeof raw.prefs === "object" ? raw.prefs : {};
    s.prefs = {
      postcode: typeof p.postcode === "string" ? p.postcode.trim() : "",
      area: typeof p.area === "string" ? p.area.trim() : "",
      extraAreas: sanitiseList(p.extraAreas),
      childAge: sanitiseAge(p.childAge),
      days: sanitiseDays(p.days)
    };
    return s;
  }

  function normaliseRoster(raw) {
    var r = emptyRoster();
    if (!raw || typeof raw !== "object" || !raw.byToken || typeof raw.byToken !== "object") return r;
    var order = Array.isArray(raw.order) ? raw.order : Object.keys(raw.byToken);
    for (var i = 0; i < order.length; i++) {
      var tok = order[i];
      if (typeof tok !== "string" || !raw.byToken[tok]) continue;
      var sub = normaliseSubscriber(raw.byToken[tok]);
      sub.token = tok;
      r.byToken[tok] = sub;
      r.order.push(tok);
    }
    return r;
  }

  // Seed an EXISTING subscriber (someone already on the newsletter) and return
  // their link token. In real life this happens when they first subscribe; here
  // it lets a manage-flow test start from a parent who is already on the list.
  function enrolExistingSubscriber(roster, email, prefs) {
    var r = clone(roster);
    if (!r.byToken) r.byToken = {};
    if (!Array.isArray(r.order)) r.order = [];
    var token = safeUid();
    var sub = normaliseSubscriber({
      token: token,
      email: typeof email === "string" ? email.trim() : "",
      subscribed: true,
      prefs: prefs || {},
      updatedAt: nowIso()
    });
    sub.token = token;
    r.byToken[token] = sub;
    r.order.push(token);
    return { roster: r, token: token };
  }

  // Resolve a tokenised newsletter link to the subscriber it belongs to.
  // Returns the subscriber (a copy) or null if the token is unknown/expired.
  function resolveToken(roster, token) {
    if (!roster || !roster.byToken || typeof token !== "string" || !token) return null;
    var sub = roster.byToken[token];
    if (!sub) return null;
    return clone(sub);
  }

  // THE acceptance criterion (part 1): update personalisation preferences on an
  // EXISTING subscriber resolved from a link token. Accepts a partial patch so a
  // parent can "add or amend ANY details" (article wording). A postcode is
  // resolved to its area automatically. Returns { roster, subscriber }.
  function updatePreferences(roster, token, patch) {
    var r = clone(roster);
    if (!r.byToken || !r.byToken[token]) {
      return { roster: r, subscriber: null, ok: false, reason: "unknown-token" };
    }
    var sub = r.byToken[token];
    if (!sub.prefs) sub.prefs = emptyPrefs();
    patch = patch || {};

    if (Object.prototype.hasOwnProperty.call(patch, "postcode")) {
      var pc = typeof patch.postcode === "string" ? patch.postcode.trim() : "";
      sub.prefs.postcode = pc;
      var resolved = areaForPostcode(pc);
      // Resolving the postcode (re)sets the primary area when we can place it.
      if (resolved) sub.prefs.area = resolved;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "area")) {
      sub.prefs.area = typeof patch.area === "string" ? patch.area.trim() : "";
    }
    if (Object.prototype.hasOwnProperty.call(patch, "extraAreas")) {
      sub.prefs.extraAreas = sanitiseList(patch.extraAreas);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "childAge")) {
      sub.prefs.childAge = sanitiseAge(patch.childAge);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "days")) {
      sub.prefs.days = sanitiseDays(patch.days);
    }
    sub.updatedAt = nowIso();
    // Amending preferences from the link implies an active subscription; if a
    // previously-unsubscribed parent edits details they are re-engaging.
    if (!sub.subscribed) {
      sub.subscribed = true;
      sub.unsubscribedAt = null;
    }
    return { roster: r, subscriber: clone(sub), ok: true };
  }

  // THE acceptance criterion (part 2): unsubscribe via the newsletter link token
  // (article: "unsubscribe… at the bottom of any previous newsletter email").
  // Preferences are RETAINED so a one-click re-subscribe is possible.
  function unsubscribe(roster, token) {
    var r = clone(roster);
    if (!r.byToken || !r.byToken[token]) {
      return { roster: r, subscriber: null, ok: false, reason: "unknown-token" };
    }
    var sub = r.byToken[token];
    sub.subscribed = false;
    sub.unsubscribedAt = nowIso();
    return { roster: r, subscriber: clone(sub), ok: true };
  }

  // Re-subscribe (article: parents can opt back in; the manage page offers it).
  function resubscribe(roster, token) {
    var r = clone(roster);
    if (!r.byToken || !r.byToken[token]) {
      return { roster: r, subscriber: null, ok: false, reason: "unknown-token" };
    }
    var sub = r.byToken[token];
    sub.subscribed = true;
    sub.unsubscribedAt = null;
    sub.updatedAt = nowIso();
    return { roster: r, subscriber: clone(sub), ok: true };
  }

  // Is the personalisation complete (location + age + at least one day)?
  function personalisationComplete(sub) {
    if (!sub || !sub.prefs) return false;
    var p = sub.prefs;
    var hasLocation = !!p.area || !!p.postcode || (p.extraAreas && p.extraAreas.length > 0);
    return hasLocation && p.childAge !== null && p.days.length > 0;
  }

  // The full set of areas this subscriber is tailored to (primary + extras).
  function tailoredAreas(sub) {
    if (!sub || !sub.prefs) return [];
    var out = [], seen = {};
    function add(a) {
      if (typeof a !== "string") return;
      a = a.trim();
      if (!a || seen[a]) return;
      seen[a] = true; out.push(a);
    }
    add(sub.prefs.area);
    (sub.prefs.extraAreas || []).forEach(add);
    return out;
  }

  // Parse a tokenised newsletter link, e.g.
  //   "https://holidaycamp/newsletter/preferences?token=abc&action=unsubscribe"
  // Returns { token, action } with action ∈ {manage, unsubscribe}.
  function parseLink(href) {
    var res = { token: "", action: "manage" };
    if (typeof href !== "string" || !href) return res;
    var qIdx = href.indexOf("?");
    var query = qIdx === -1 ? href : href.slice(qIdx + 1);
    var parts = query.split(/[&;]/);
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      var k = decodeURIComponent((kv[0] || "").trim());
      var v = decodeURIComponent((kv[1] || "").trim());
      if (k === "token" || k === "prefs" || k === "t") res.token = v;
      if (k === "action" && (v === "manage" || v === "unsubscribe")) res.action = v;
    }
    return res;
  }

  /* ================= persistence (HC.store only) ================= */

  function loadRoster() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    return normaliseRoster(raw);
  }
  function saveRoster(r) {
    try { HC.store.set(STORE_KEY, r); } catch (e) {}
  }

  /* ================= live camp data ================= */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Distinct, pickable areas drawn from the live directory (extra-area chips).
  function areaChoices() {
    var ps = providers();
    var seen = {}, out = [];
    function add(a) {
      if (typeof a !== "string") return;
      a = a.trim();
      if (!a || a === "Borough-wide" || a === "London" || a === "Waltham Forest" ||
        a.indexOf("/") !== -1) return;
      if (seen[a]) return;
      seen[a] = true; out.push(a);
    }
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (Array.isArray(p.areas)) p.areas.forEach(add);
      else add(p.area);
    }
    if (!out.length) {
      out = ["Walthamstow", "Leyton", "Leytonstone", "Chingford", "Highams Park", "Wanstead", "Woodford"];
    }
    out.sort();
    return out;
  }

  /* ================= demo seed (so the preview has a parent to manage) ===== */
  // We don't want the live preview to mutate a real roster, so the demo seeds a
  // throwaway subscriber under a fixed demo token if one isn't there yet.
  var DEMO_TOKEN = "demo-newsletter-link";
  function ensureDemoSubscriber(roster) {
    if (roster.byToken[DEMO_TOKEN]) return roster;
    var r = clone(roster);
    r.byToken[DEMO_TOKEN] = normaliseSubscriber({
      token: DEMO_TOKEN,
      email: "parent@example.com",
      subscribed: true,
      prefs: { postcode: "E17 4QH", area: "Walthamstow", extraAreas: ["Leyton"], childAge: 8, days: ["Mon", "Tue", "Wed"] },
      updatedAt: nowIso()
    });
    if (r.order.indexOf(DEMO_TOKEN) === -1) r.order.push(DEMO_TOKEN);
    return r;
  }

  /* ================= UI ================= */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  function render(mountEl) {
    if (!mountEl) return;
    mountEl.innerHTML = "";

    // Seed a demo subscriber and resolve the parent from the (demo) link token —
    // mimicking arriving from a newsletter footer "Update my email preferences".
    var roster = ensureDemoSubscriber(loadRoster());
    saveRoster(roster);
    var token = DEMO_TOKEN;
    var sub = resolveToken(roster, token);
    if (!sub) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">This preferences link has expired or is invalid.</p>';
      return;
    }

    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("div", {
      style: "background:var(--purple-tint,#F0E8F4);border-radius:12px;padding:10px 14px;font-size:12.5px;" +
        "color:var(--purple,#603488);margin:0 0 14px"
    }, "🔗 You followed the <strong>“Update my email preferences”</strong> link at the bottom of your " +
      "What's On newsletter. Add or amend any details below — or unsubscribe."));

    wrap.appendChild(HC.util.el("p", { style: "font-size:13.5px;margin:0 0 14px" },
      "Newsletter address: <strong>" + esc(sub.email || "—") + "</strong>"));

    // ---- POSTCODE / LOCATION ----
    var pcRow = HC.util.el("div", { style: "margin:0 0 14px" });
    pcRow.appendChild(fieldLabel("Your postcode (we'll find your area)"));
    var pcInput = HC.util.el("input", {
      type: "text", placeholder: "e.g. E17 4QH", value: sub.prefs.postcode || "",
      style: inputStyle().replace("max-width:320px", "max-width:200px")
    });
    var areaHint = HC.util.el("span", {
      style: "font-size:12.5px;color:var(--muted,#808080);margin-left:10px"
    });
    pcRow.appendChild(pcInput);
    pcRow.appendChild(areaHint);
    wrap.appendChild(pcRow);

    function paintArea() {
      var a = areaForPostcode(pcInput.value);
      areaHint.textContent = a ? "→ " + a : (pcInput.value.trim() ? "→ outside our holiday-camp areas" : "");
    }
    pcInput.addEventListener("input", paintArea);
    paintArea();

    // ---- EXTRA AREAS (multi-select chips) ----
    var areaRow = HC.util.el("div", { style: "margin:0 0 14px" });
    areaRow.appendChild(fieldLabel("Other areas you'd travel to"));
    var areaBox = HC.util.el("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    var selectedAreas = {};
    (sub.prefs.extraAreas || []).forEach(function (a) { selectedAreas[a] = true; });
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

    // ---- CHILD AGE ----
    var ageRow = HC.util.el("div", { style: "margin:0 0 14px" });
    ageRow.appendChild(fieldLabel("Your child's age"));
    var ageInput = HC.util.el("input", {
      type: "number", min: "4", max: "16", placeholder: "e.g. 8",
      value: (sub.prefs.childAge === null ? "" : String(sub.prefs.childAge)),
      style: inputStyle().replace("max-width:320px", "max-width:120px")
    });
    var bandHint = HC.util.el("span", {
      style: "font-size:12.5px;color:var(--muted,#808080);margin-left:10px"
    });
    ageRow.appendChild(ageInput);
    ageRow.appendChild(bandHint);
    wrap.appendChild(ageRow);

    function paintBand() {
      var band = ageBandFor(ageInput.value);
      bandHint.textContent = band ? "→ " + band.label : "";
    }
    ageInput.addEventListener("input", paintBand);
    paintBand();

    // ---- AVAILABLE DAYS ----
    var daysRow = HC.util.el("div", { style: "margin:0 0 16px" });
    daysRow.appendChild(fieldLabel("Days you're free"));
    var daysBox = HC.util.el("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    var selectedDays = {};
    (sub.prefs.days || []).forEach(function (d) { selectedDays[d] = true; });
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
    var saveBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Save my preferences");
    var subToggleBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" });
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(subToggleBtn);
    wrap.appendChild(btnRow);

    var status = HC.util.el("div", {
      style: "font-size:12.5px;color:var(--muted,#808080);margin-top:12px"
    });
    wrap.appendChild(status);

    mountEl.appendChild(wrap);

    function collectPatch() {
      return {
        postcode: pcInput.value,
        extraAreas: Object.keys(selectedAreas).filter(function (k) { return selectedAreas[k]; }),
        childAge: ageInput.value,
        days: Object.keys(selectedDays).filter(function (k) { return selectedDays[k]; })
      };
    }

    function paint() {
      subToggleBtn.textContent = sub.subscribed ? "Unsubscribe" : "Re-subscribe";
      var areas = tailoredAreas(sub);
      var band = ageBandFor(sub.prefs.childAge);
      if (sub.subscribed) {
        status.innerHTML = "✅ Subscribed. Tailored to <strong>" +
          (areas.length ? esc(areas.join(", ")) : "no area yet") + "</strong> · " +
          (band ? esc(band.label) : "no age yet") + " · " +
          (sub.prefs.days.length ? esc(sub.prefs.days.join("/")) : "no days yet") +
          (personalisationComplete(sub) ? "" : " — add the missing detail for a fully tailored newsletter.");
      } else {
        status.innerHTML = "🚫 You're unsubscribed from the What's On newsletter. " +
          "Your preferences are saved — re-subscribe any time.";
      }
    }

    saveBtn.addEventListener("click", function () {
      var res = updatePreferences(roster, token, collectPatch());
      if (res.ok) {
        roster = res.roster; sub = res.subscriber;
        saveRoster(roster);
        // reflect any postcode→area resolution back into the area hint
        paintArea();
        try {
          HC.util.toast(personalisationComplete(sub)
            ? "Preferences updated — your What's On is tailored"
            : "Preferences updated — add the missing detail to fully tailor it");
        } catch (e) {}
      }
      paint();
    });

    subToggleBtn.addEventListener("click", function () {
      var res = sub.subscribed ? unsubscribe(roster, token) : resubscribe(roster, token);
      if (res.ok) {
        roster = res.roster; sub = res.subscriber;
        saveRoster(roster);
        try { HC.util.toast(sub.subscribed ? "You're back on the list" : "Unsubscribed — preferences kept"); } catch (e) {}
      }
      paint();
    });

    paint();
  }

  /* ================= selfTest ================= */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    /* --- ACCEPTANCE CRITERION: from a newsletter link, an EXISTING subscriber
       updates personalisation (postcode/area, child age, days) AND unsubscribes --- */
    check("ACCEPTANCE: from a newsletter link, a parent updates postcode/area, age & days and can unsubscribe", function () {
      // An existing subscriber is already on the list (seeded once, like the
      // moment they first subscribed). We get the token their newsletter link carries.
      var seed = enrolExistingSubscriber(emptyRoster(), "leath@example.com", {
        postcode: "E10 5AB", area: "Leyton", childAge: 6, days: ["Mon"]
      });
      var roster = seed.roster, token = seed.token;
      HC.assert(typeof token === "string" && token.length > 0, "the newsletter link carries a token");

      // The footer link resolves to THIS subscriber (not a fresh sign-up).
      var resolved = resolveToken(roster, token);
      HC.assert(resolved && resolved.email === "leath@example.com", "token resolves to the existing subscriber");
      HC.assert(resolved.subscribed === true, "they are currently subscribed");
      HC.assert(resolved.prefs.area === "Leyton" && resolved.prefs.childAge === 6, "their current prefs are present");

      // UPDATE personalisation: new postcode (→ area), new age, new days.
      var upd = updatePreferences(roster, token, {
        postcode: "E17 4QH",                 // → Walthamstow
        childAge: 9,
        days: ["Tue", "Thu"]
      });
      HC.assert(upd.ok === true, "the preference update succeeds");
      roster = upd.roster;
      var s = upd.subscriber;
      // postcode/area updated (postcode resolved to its area)
      HC.assert(s.prefs.postcode === "E17 4QH", "postcode amended");
      HC.assert(s.prefs.area === "Walthamstow", "postcode resolved to the Walthamstow area, got " + s.prefs.area);
      // child age updated → new band
      HC.assert(s.prefs.childAge === 9, "child age amended");
      HC.assert(ageBandFor(s.prefs.childAge).id === "junior", "age 9 → Juniors band");
      // available days updated
      HC.assert(s.prefs.days.length === 2 && s.prefs.days.indexOf("Tue") !== -1 && s.prefs.days.indexOf("Thu") !== -1,
        "available days amended");
      // it's the SAME subscriber, not a new one
      HC.assert(s.token === token && s.email === "leath@example.com", "still the same subscriber record");
      HC.assert(Object.keys(roster.byToken).length === 1, "no duplicate subscriber created by an update");

      // UNSUBSCRIBE from the same link.
      var un = unsubscribe(roster, token);
      HC.assert(un.ok === true, "unsubscribe succeeds");
      roster = un.roster;
      HC.assert(un.subscriber.subscribed === false, "parent is now unsubscribed");
      HC.assert(typeof un.subscriber.unsubscribedAt === "string", "an unsubscribe timestamp is recorded");
      // preferences survive the unsubscribe (so re-subscribe is one click)
      HC.assert(un.subscriber.prefs.area === "Walthamstow" && un.subscriber.prefs.childAge === 9,
        "preferences are retained after unsubscribe");
    });

    // Distinctness: this feature operates on an EXISTING token, not a sign-up.
    check("Updating an unknown/expired token does not create a subscriber", function () {
      var roster = emptyRoster();
      var res = updatePreferences(roster, "no-such-token", { childAge: 7 });
      HC.assert(res.ok === false, "update on an unknown token reports failure");
      HC.assert(res.subscriber === null, "no subscriber returned");
      HC.assert(Object.keys(res.roster.byToken).length === 0, "no subscriber is silently created");
      var un = unsubscribe(roster, "no-such-token");
      HC.assert(un.ok === false && un.subscriber === null, "unsubscribe on an unknown token also fails cleanly");
    });

    // Postcode resolver places the real Waltham Forest districts.
    check("Postcode resolves to the correct holiday-camp area", function () {
      HC.assert(areaForPostcode("E17 4QH") === "Walthamstow", "E17 → Walthamstow");
      HC.assert(areaForPostcode("e10 5ab") === "Leyton", "E10 (lower-case) → Leyton");
      HC.assert(areaForPostcode("E11 1AA") === "Leytonstone", "E11 → Leytonstone");
      HC.assert(areaForPostcode("E4 9PT") === "Chingford", "E4 → Chingford");
      HC.assert(areaForPostcode("IG8 0HD") === "Woodford", "IG8 → Woodford");
      HC.assert(areaForPostcode("E17") === "Walthamstow", "bare district E17 → Walthamstow");
      HC.assert(areaForPostcode("SW1A 1AA") === null, "a non-WF postcode resolves to no area");
      HC.assert(isWalthamForestPostcode("E17 4QH") === true, "E17 is a WF postcode");
      HC.assert(isWalthamForestPostcode("M1 1AE") === false, "Manchester is not a WF postcode");
    });

    // A postcode update auto-updates the primary area.
    check("Amending the postcode re-resolves the primary area", function () {
      var seed = enrolExistingSubscriber(emptyRoster(), "p@x.com",
        { postcode: "E17 4QH", area: "Walthamstow", childAge: 8, days: ["Mon"] });
      var res = updatePreferences(seed.roster, seed.token, { postcode: "E4 9PT" });
      HC.assert(res.ok === true, "update ok");
      HC.assert(res.subscriber.prefs.area === "Chingford", "moving to E4 re-homes the parent to Chingford");
      // an unrecognised postcode keeps the postcode but leaves the area untouched
      var res2 = updatePreferences(res.roster, seed.token, { postcode: "ZZ9 9ZZ" });
      HC.assert(res2.subscriber.prefs.postcode === "ZZ9 9ZZ", "the raw postcode is still stored");
      HC.assert(res2.subscriber.prefs.area === "Chingford", "an unresolvable postcode leaves the area as-is");
    });

    // Partial amend: "add or amend ANY details" — untouched prefs are preserved.
    check("A partial amend changes only the named fields", function () {
      var seed = enrolExistingSubscriber(emptyRoster(), "p@x.com",
        { postcode: "E10 1AA", area: "Leyton", extraAreas: ["Walthamstow"], childAge: 8, days: ["Mon", "Tue"] });
      var res = updatePreferences(seed.roster, seed.token, { days: ["Wed"] }); // only days
      var s = res.subscriber;
      HC.assert(s.prefs.days.length === 1 && s.prefs.days[0] === "Wed", "days amended");
      HC.assert(s.prefs.area === "Leyton", "area untouched");
      HC.assert(s.prefs.childAge === 8, "age untouched");
      HC.assert(s.prefs.extraAreas.length === 1 && s.prefs.extraAreas[0] === "Walthamstow", "extra areas untouched");
    });

    // Inputs are sanitised on amend (junk days, dup areas, age coercion).
    check("Amended preferences are sanitised", function () {
      var seed = enrolExistingSubscriber(emptyRoster(), "p@x.com", { childAge: null, days: [] });
      var res = updatePreferences(seed.roster, seed.token, {
        extraAreas: ["Leyton", "Leyton", "  ", 7, "Chingford"],
        childAge: "10",
        days: ["Mon", "Mon", "Funday", "Sun"]
      });
      var s = res.subscriber;
      HC.assert(s.prefs.extraAreas.length === 2, "dup/blank/non-string extra areas dropped, got " + s.prefs.extraAreas.length);
      HC.assert(s.prefs.childAge === 10, "string age coerced to number");
      HC.assert(s.prefs.days.length === 1 && s.prefs.days[0] === "Mon", "invalid days dropped");
    });

    // Age bands cover the school-age spread (holiday camps, not baby classes).
    check("Age bands cover the school-age spread 4→16", function () {
      HC.assert(ageBandFor(4).id === "early", "4 → early years");
      HC.assert(ageBandFor(5).id === "infant", "5 → infants");
      HC.assert(ageBandFor(8).id === "junior", "8 → juniors");
      HC.assert(ageBandFor(12).id === "teen", "12 → teens");
      HC.assert(ageBandFor(16).id === "teen", "16 → teens");
      HC.assert(ageBandFor(null) === null, "no age → no band");
    });

    // Re-subscribe path (parent changed their mind from the manage page).
    check("A parent can re-subscribe after unsubscribing, keeping their prefs", function () {
      var seed = enrolExistingSubscriber(emptyRoster(), "p@x.com",
        { postcode: "E17 4QH", area: "Walthamstow", childAge: 8, days: ["Mon"] });
      var roster = unsubscribe(seed.roster, seed.token).roster;
      HC.assert(resolveToken(roster, seed.token).subscribed === false, "unsubscribed first");
      var re = resubscribe(roster, seed.token);
      HC.assert(re.ok === true && re.subscriber.subscribed === true, "re-subscribed");
      HC.assert(re.subscriber.unsubscribedAt === null, "the unsubscribe stamp is cleared on re-subscribe");
      HC.assert(re.subscriber.prefs.area === "Walthamstow" && re.subscriber.prefs.childAge === 8,
        "preferences survived the round-trip");
    });

    // Editing details while unsubscribed re-engages the parent (article: "amend").
    check("Amending details while unsubscribed re-engages the subscription", function () {
      var seed = enrolExistingSubscriber(emptyRoster(), "p@x.com", { area: "Leyton", childAge: 8, days: ["Mon"] });
      var roster = unsubscribe(seed.roster, seed.token).roster;
      var res = updatePreferences(roster, seed.token, { days: ["Tue"] });
      HC.assert(res.subscriber.subscribed === true, "editing prefs re-subscribes the parent");
      HC.assert(res.subscriber.unsubscribedAt === null, "the unsubscribe stamp is cleared");
    });

    // personalisationComplete needs location + age + a day.
    check("Personalisation completeness requires location, age and a day", function () {
      var full = enrolExistingSubscriber(emptyRoster(), "p@x.com",
        { area: "Leyton", childAge: 8, days: ["Mon"] }).roster;
      var s = resolveToken(full, Object.keys(full.byToken)[0]);
      HC.assert(personalisationComplete(s) === true, "complete personalisation passes");
      var noAge = enrolExistingSubscriber(emptyRoster(), "p@x.com", { area: "Leyton", childAge: null, days: ["Mon"] }).roster;
      HC.assert(personalisationComplete(resolveToken(noAge, Object.keys(noAge.byToken)[0])) === false, "missing age fails");
      var noLoc = enrolExistingSubscriber(emptyRoster(), "p@x.com", { childAge: 8, days: ["Mon"] }).roster;
      HC.assert(personalisationComplete(resolveToken(noLoc, Object.keys(noLoc.byToken)[0])) === false, "missing location fails");
      var noDay = enrolExistingSubscriber(emptyRoster(), "p@x.com", { area: "Leyton", childAge: 8, days: [] }).roster;
      HC.assert(personalisationComplete(resolveToken(noDay, Object.keys(noDay.byToken)[0])) === false, "missing day fails");
    });

    // A postcode alone counts as location even with no chosen area chip.
    check("A postcode counts as location on its own", function () {
      var seed = enrolExistingSubscriber(emptyRoster(), "p@x.com", { childAge: 8, days: ["Mon"] });
      var res = updatePreferences(seed.roster, seed.token, { postcode: "E11 1AA" });
      HC.assert(res.subscriber.prefs.area === "Leytonstone", "postcode set the area");
      HC.assert(personalisationComplete(res.subscriber) === true, "postcode satisfies the location requirement");
    });

    // The newsletter-link parser pulls token + action from a footer URL.
    check("Newsletter link parsing extracts the token and action", function () {
      var a = parseLink("https://holidaycamp/newsletter/prefs?token=abc123&action=manage");
      HC.assert(a.token === "abc123" && a.action === "manage", "manage link parsed");
      var b = parseLink("https://holidaycamp/newsletter/prefs?token=xyz&action=unsubscribe");
      HC.assert(b.token === "xyz" && b.action === "unsubscribe", "unsubscribe link parsed");
      var c = parseLink("?prefs=tok99");
      HC.assert(c.token === "tok99" && c.action === "manage", "the ?prefs= alias works and defaults to manage");
      var d = parseLink("");
      HC.assert(d.token === "" && d.action === "manage", "an empty link yields no token, default action");
    });

    // End-to-end via the parsed link, exercising the documented flow shape.
    check("End-to-end: parse link → resolve token → unsubscribe", function () {
      var seed = enrolExistingSubscriber(emptyRoster(), "p@x.com",
        { postcode: "E17 4QH", area: "Walthamstow", childAge: 8, days: ["Mon"] });
      var href = "https://holidaycamp/newsletter/prefs?token=" + seed.token + "&action=unsubscribe";
      var link = parseLink(href);
      HC.assert(link.token === seed.token, "token round-trips through the link");
      var sub = resolveToken(seed.roster, link.token);
      HC.assert(sub && sub.email === "p@x.com", "link resolves to the right parent");
      if (link.action === "unsubscribe") {
        var res = unsubscribe(seed.roster, link.token);
        HC.assert(res.subscriber.subscribed === false, "the unsubscribe link unsubscribes them");
      }
    });

    // Defensive: junk input must not throw.
    check("Defensive against junk input", function () {
      HC.assert(resolveToken(null, "x") === null, "null roster → null");
      HC.assert(resolveToken(emptyRoster(), "") === null, "empty token → null");
      HC.assert(normaliseRoster("garbage").order.length === 0, "garbage roster normalises empty");
      HC.assert(normaliseSubscriber(null).subscribed === true, "a null subscriber normalises to an active default");
      var r = updatePreferences(emptyRoster(), "x", null);
      HC.assert(r.ok === false, "updating a missing subscriber with a null patch fails cleanly");
      HC.assert(parseLink(null).token === "", "parsing a null link does not throw");
      HC.assert(outwardCode(12345) === "", "non-string postcode → empty outward code");
    });

    // Persistence round-trips through HC.store (namespaced, not raw localStorage).
    check("Roster & amended preferences persist via HC.store", function () {
      var seed = enrolExistingSubscriber(emptyRoster(), "persist@x.com",
        { postcode: "E17 4QH", area: "Walthamstow", extraAreas: ["Leyton"], childAge: 10, days: ["Mon", "Fri"] });
      var roster = updatePreferences(seed.roster, seed.token, { days: ["Wed", "Thu"] }).roster;
      var saveKey = "test_" + STORE_KEY;
      var ok = HC.store.set(saveKey, roster);
      HC.assert(ok !== false, "store.set should succeed");
      var got = normaliseRoster(HC.store.get(saveKey, null));
      var s = resolveToken(got, seed.token);
      HC.assert(s && s.email === "persist@x.com", "subscriber survives a store round-trip");
      HC.assert(s.prefs.area === "Walthamstow", "resolved area survives persistence");
      HC.assert(s.prefs.childAge === 10, "age survives persistence");
      HC.assert(s.prefs.days.length === 2 && s.prefs.days.indexOf("Wed") !== -1, "amended days survive persistence");
      try { HC.store.remove ? HC.store.remove(saveKey) : HC.store.set(saveKey, null); } catch (e) {}
    });

    // Extra-area choices are grounded in the live school-age directory.
    check("Extra-area choices come from the live holiday-camp directory", function () {
      var choices = areaChoices();
      HC.assert(Array.isArray(choices) && choices.length > 0, "there is at least one area to pick");
      var ps = providers();
      if (ps.length) {
        var allAreas = {};
        ps.forEach(function (p) {
          (Array.isArray(p.areas) ? p.areas : [p.area]).forEach(function (a) {
            if (typeof a === "string") allAreas[a] = true;
          });
        });
        var grounded = choices.every(function (c) {
          return Object.keys(allAreas).some(function (a) { return a.indexOf(c) !== -1; });
        });
        HC.assert(grounded, "every offered area is grounded in real directory data");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ================= register ================= */

  HC.registerFeature({
    id: "parent-newsletter-preferences",
    title: "Manage newsletter preferences / unsubscribe",
    side: "parent",
    icon: "⚙️",
    summary: "Reached from the 'Update my email preferences' link at the bottom of a What's On " +
      "newsletter. The tokenised link resolves to your existing subscription so you can amend your " +
      "postcode/area, your child's age and the days you're free — or unsubscribe (preferences kept for " +
      "one-click re-subscribe), exactly like Happity.",
    render: render,
    selfTest: selfTest
  });
})();
