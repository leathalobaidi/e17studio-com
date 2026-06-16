/* HolidayCamp feature — parent-follow
 *
 * Follow a provider for new-camp alerts  (parent side)
 *
 * Replicates Happity's "Followers" behaviour (support article 4291535,
 * "How to use Happity Followers for zero-effort email marketing"; 02-ia-ux
 * §4.1 names Follow as the substitute for a waiting list). Evidence:
 *   - "When parents view your profile ... we invite them to 'Follow' you for
 *      updates on your classes. This is especially useful if ... they can't
 *      see a time / venue that works for them right now."
 *   - "when you add classes ... we'll send your latest timetable to your
 *      followers" — i.e. a Follow records the parent for TIMETABLE EMAILS.
 *   - "parents are also asked if they would like to opt-in to YOUR OWN
 *      newsletter too" — an explicit, separate marketing consent.
 *   - "By default, we'll distribute timetables 4 times a year ... at the start
 *      of each term" plus ad-hoc alerts "whenever new classes are added".
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: there is no waiting list for a one-off
 * camp week, so a parent who can't find a slot that works *Follows* the camp
 * provider. The Follow is recorded against that provider; when the provider
 * publishes a new holiday-camp timetable (e.g. summer dates open), every
 * follower is queued a timetable email. A separate tick opts the parent into
 * the provider's own newsletter (express marketing consent).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   A 'Follow' action records the parent against the provider for timetable
 *   emails.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-follow: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "parent_follow_state";
  // A self-identifying parent for the mock. In a real app this is the logged-in
  // account; here we mint a stable per-browser id so follows persist sensibly.
  var PARENT_KEY = "parent_follow_identity";

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  // The whole feature state is a single object persisted via HC.store:
  //   {
  //     parentEmail: String,
  //     follows: {
  //       <providerId>: {
  //         providerId, providerName,
  //         followedAt: ISOString,
  //         newsletterOptIn: Boolean,   // express consent to provider's own list
  //         timetableEmails: [ { id, sentAt, subject, campCount } ]  // outbox
  //       },
  //       ...
  //     }
  //   }
  // Pure functions take a state, return a NEW state — never mutate in place, so
  // tests can run against fresh literals without touching storage.

  function emptyState(email) {
    return { parentEmail: email || "", follows: {} };
  }

  function cloneState(state) {
    // Defensive deep-ish clone (state is plain JSON).
    try {
      return JSON.parse(JSON.stringify(state || {}));
    } catch (e) {
      return emptyState(state && state.parentEmail);
    }
  }

  function isFollowing(state, providerId) {
    return !!(state && state.follows && state.follows[providerId]);
  }

  // THE acceptance criterion in code: record the parent against the provider so
  // that provider's timetable emails will reach them. Returns a new state.
  //   opts.newsletterOptIn — express opt-in to the provider's own newsletter.
  //   opts.email           — parent's email (recorded so timetables can be sent).
  function followProvider(state, provider, opts) {
    var next = cloneState(state);
    if (!next.follows) next.follows = {};
    if (!provider || !provider.id) return next; // defensive: nothing to follow

    opts = opts || {};
    if (opts.email) next.parentEmail = String(opts.email);

    var existing = next.follows[provider.id];
    next.follows[provider.id] = {
      providerId: provider.id,
      providerName: provider.name || provider.id,
      followedAt: (existing && existing.followedAt) || nowIso(),
      newsletterOptIn: !!opts.newsletterOptIn,
      // preserve any previously queued timetable emails
      timetableEmails: (existing && Array.isArray(existing.timetableEmails))
        ? existing.timetableEmails
        : []
    };
    return next;
  }

  function unfollowProvider(state, providerId) {
    var next = cloneState(state);
    if (next.follows && next.follows[providerId]) {
      delete next.follows[providerId];
    }
    return next;
  }

  // Toggle the express newsletter opt-in for a provider already being followed.
  function setNewsletterOptIn(state, providerId, optIn) {
    var next = cloneState(state);
    if (next.follows && next.follows[providerId]) {
      next.follows[providerId].newsletterOptIn = !!optIn;
    }
    return next;
  }

  // Simulate the provider publishing a new holiday-camp timetable. Per the
  // article, EVERY follower is sent the latest timetable. Here we model the
  // single current parent: if they follow the provider, a timetable email is
  // appended to their outbox for that provider. Returns { state, delivered }.
  function publishTimetable(state, provider, campCount, subject) {
    var next = cloneState(state);
    var delivered = false;
    if (provider && provider.id && isFollowing(next, provider.id) && next.parentEmail) {
      var rec = next.follows[provider.id];
      if (!Array.isArray(rec.timetableEmails)) rec.timetableEmails = [];
      rec.timetableEmails.push({
        id: safeUid(),
        sentAt: nowIso(),
        to: next.parentEmail,
        subject: subject || ((provider.name || "Camp") + " — new holiday-camp dates"),
        campCount: Number(campCount) || 0
      });
      delivered = true;
    }
    return { state: next, delivered: delivered };
  }

  // How many timetable emails this parent has been queued for a provider.
  function timetableCount(state, providerId) {
    if (!isFollowing(state, providerId)) return 0;
    var rec = state.follows[providerId];
    return (rec && Array.isArray(rec.timetableEmails)) ? rec.timetableEmails.length : 0;
  }

  function followedList(state) {
    if (!state || !state.follows) return [];
    return Object.keys(state.follows).map(function (id) { return state.follows[id]; });
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  /* ---------------- persistence helpers (HC.store only) ---------------- */

  function loadState() {
    var email = "";
    try { email = HC.store.get(PARENT_KEY, "") || ""; } catch (e) { email = ""; }
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object") return emptyState(email);
    if (!raw.follows || typeof raw.follows !== "object") raw.follows = {};
    if (typeof raw.parentEmail !== "string") raw.parentEmail = email;
    return raw;
  }

  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
    try { if (state && state.parentEmail) HC.store.set(PARENT_KEY, state.parentEmail); } catch (e) {}
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Pick a representative live provider to demo (one with a real area/summary).
  function pickSeedProvider() {
    var ps = providers();
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && ps[i].id && ps[i].name) return ps[i];
    }
    return { id: "demo-camp", name: "Holiday Camp Provider", area: "Walthamstow", summary: "" };
  }

  /* ---------------- UI ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function render(mountEl) {
    if (!mountEl) return;
    var state = loadState();
    var seed = pickSeedProvider();

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Holiday camps sell out and there's no waiting list for a one-off week — so if you " +
      "can't find a date that works, <strong>Follow</strong> the provider. We'll record you " +
      "against them and email you their timetable the moment new camp dates go live."));

    // ---- email row (the address timetable emails are recorded against) ----
    var emailRow = HC.util.el("div", { style: "margin:0 0 14px" });
    emailRow.appendChild(HC.util.el("label", {
      style: "display:block;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:12px;" +
        "text-transform:uppercase;letter-spacing:.5px;color:var(--magenta,#F82488);margin:0 0 6px"
    }, "Your email for camp alerts"));
    var emailInput = HC.util.el("input", {
      type: "email", placeholder: "you@example.com", value: state.parentEmail || "",
      style: "width:100%;max-width:320px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);" +
        "border-radius:10px;font-size:14px;box-sizing:border-box"
    });
    emailRow.appendChild(emailInput);
    wrap.appendChild(emailRow);

    // ---- the provider you're viewing + Follow control ----
    var card = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;margin:0 0 16px;background:#fff"
    });
    card.appendChild(HC.util.el("div", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:17px"
    }, esc(seed.name)));
    card.appendChild(HC.util.el("div", {
      style: "font-size:12.5px;color:var(--muted,#808080);margin:2px 0 10px"
    }, esc(seed.area || seed.venue || "Holiday camp")));

    // newsletter opt-in (express consent — separate from the Follow itself)
    var nlLabel = HC.util.el("label", {
      style: "display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--text,#383838);margin:0 0 12px;cursor:pointer"
    });
    var nlCheck = HC.util.el("input", { type: "checkbox" });
    var followedRec = state.follows[seed.id];
    nlCheck.checked = !!(followedRec && followedRec.newsletterOptIn);
    nlLabel.appendChild(nlCheck);
    nlLabel.appendChild(HC.util.el("span", null,
      "Also email me <strong>" + esc(seed.name) + "</strong>'s own newsletter (you can opt out anytime)."));
    card.appendChild(nlLabel);

    var btnRow = HC.util.el("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center" });
    var followBtn = HC.util.el("button", { class: "hc-btn", type: "button" });
    var publishBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" },
      "Provider publishes new dates");
    btnRow.appendChild(followBtn);
    btnRow.appendChild(publishBtn);
    card.appendChild(btnRow);

    var statusLine = HC.util.el("div", {
      style: "font-size:12.5px;color:var(--muted,#808080);margin-top:10px"
    });
    card.appendChild(statusLine);
    wrap.appendChild(card);

    // ---- list of who you follow + their timetable outbox ----
    var listHead = HC.util.el("div", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);" +
        "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 8px"
    }, "Providers you follow");
    wrap.appendChild(listHead);
    var listBox = HC.util.el("div", {});
    wrap.appendChild(listBox);

    mountEl.appendChild(wrap);

    function paint() {
      var following = isFollowing(state, seed.id);
      followBtn.textContent = following ? "✓ Following" : "Follow for camp alerts";
      followBtn.setAttribute("style", following
        ? "background:var(--purple,#603488);color:#fff"
        : "");
      publishBtn.disabled = !following;
      publishBtn.style.opacity = following ? "1" : "0.5";

      if (following) {
        var n = timetableCount(state, seed.id);
        statusLine.innerHTML = "You're recorded against this provider for timetable emails" +
          (n ? " — <strong>" + n + "</strong> sent to " + esc(state.parentEmail || "your inbox") + " so far." : ". No new dates yet.");
      } else {
        statusLine.textContent = "Not following yet — Follow to get their next timetable by email.";
      }

      // render follow list
      var rows = followedList(state);
      if (!rows.length) {
        listBox.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080);margin:0">' +
          "You're not following any providers yet.</p>";
        return;
      }
      listBox.innerHTML = rows.map(function (r) {
        var emails = (r.timetableEmails || []);
        var latest = emails.length ? emails[emails.length - 1] : null;
        return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:12px 14px;margin:0 0 10px;background:#fff">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
            '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
              esc(r.providerName) + "</span>" +
            '<span style="font-size:11.5px;color:var(--muted,#808080)">' +
              (r.newsletterOptIn ? "newsletter ✓" : "alerts only") + "</span>" +
          "</div>" +
          '<div style="font-size:12.5px;color:var(--muted,#808080);margin-top:3px">' +
            emails.length + " timetable email" + (emails.length === 1 ? "" : "s") +
            (latest ? " · last: " + esc(latest.subject) + " (" + latest.campCount + " camps)" : "") +
          "</div>" +
        "</div>";
      }).join("");
    }

    followBtn.addEventListener("click", function () {
      var email = (emailInput.value || "").trim();
      if (isFollowing(state, seed.id)) {
        state = unfollowProvider(state, seed.id);
        saveState(state);
        try { HC.util.toast("Unfollowed " + seed.name); } catch (e) {}
      } else {
        if (!email) {
          try { HC.util.toast("Add your email so we can send the timetable"); } catch (e) {}
          emailInput.focus();
          return;
        }
        state = followProvider(state, seed, { email: email, newsletterOptIn: nlCheck.checked });
        saveState(state);
        try { HC.util.toast("Following " + seed.name + " — you'll get their next timetable"); } catch (e) {}
      }
      paint();
    });

    nlCheck.addEventListener("change", function () {
      if (isFollowing(state, seed.id)) {
        state = setNewsletterOptIn(state, seed.id, nlCheck.checked);
        saveState(state);
        paint();
      }
    });

    emailInput.addEventListener("input", function () {
      // keep the recorded email current for any already-followed providers
      var v = (emailInput.value || "").trim();
      if (v && v !== state.parentEmail) {
        state.parentEmail = v;
        saveState(state);
      }
    });

    publishBtn.addEventListener("click", function () {
      var res = publishTimetable(state, seed, 6, seed.name + " — summer holiday-camp dates now live");
      state = res.state;
      saveState(state);
      if (res.delivered) {
        try { HC.util.toast("Timetable emailed to followers (incl. you)"); } catch (e) {}
      } else {
        try { HC.util.toast("Follow first to receive the timetable"); } catch (e) {}
      }
      paint();
    });

    paint();
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var provA = { id: "camp-a", name: "Lloyd Park Holiday Club", area: "Walthamstow" };
    var provB = { id: "camp-b", name: "Active London Camp", area: "Leyton" };

    // ACCEPTANCE CRITERION (core): a Follow records the parent against the
    // provider for timetable emails.
    check("Follow records the parent against the provider for timetable emails", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "leath@example.com" });
      HC.assert(isFollowing(s, provA.id), "parent should now be following provider A");
      var rec = s.follows[provA.id];
      HC.assert(rec, "a follow record should exist for provider A");
      HC.assert(rec.providerId === provA.id, "record keyed to the provider id");
      HC.assert(rec.providerName === provA.name, "record stores the provider name");
      HC.assert(s.parentEmail === "leath@example.com", "the parent's email is recorded for timetable delivery");
      HC.assert(Array.isArray(rec.timetableEmails), "an outbox exists to receive timetable emails");
      HC.assert(typeof rec.followedAt === "string" && rec.followedAt.length > 0, "follow timestamp recorded");
    });

    // The whole point: a followed provider's published timetable reaches the parent.
    check("Provider publishing new camp dates emails the follower's timetable", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "leath@example.com" });
      HC.assert(timetableCount(s, provA.id) === 0, "no timetable emails before any are published");
      var res = publishTimetable(s, provA, 6, "Summer dates live");
      s = res.state;
      HC.assert(res.delivered === true, "the timetable should be delivered to a follower");
      HC.assert(timetableCount(s, provA.id) === 1, "exactly one timetable email recorded");
      var mail = s.follows[provA.id].timetableEmails[0];
      HC.assert(mail.to === "leath@example.com", "email addressed to the recorded parent");
      HC.assert(mail.campCount === 6, "the email carries the new camp count, got " + mail.campCount);
      HC.assert(mail.subject === "Summer dates live", "the timetable subject is carried through");
    });

    // A non-follower must NOT be recorded for that provider's emails.
    check("Publishing does not email a parent who does not follow the provider", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "leath@example.com" }); // follows A only
      var res = publishTimetable(s, provB, 4, "Active London dates"); // B publishes
      s = res.state;
      HC.assert(res.delivered === false, "a non-followed provider must not deliver");
      HC.assert(!isFollowing(s, provB.id), "parent is not following provider B");
      HC.assert(timetableCount(s, provB.id) === 0, "no timetable emails for the un-followed provider");
    });

    // Multiple published timetables accumulate (the term-by-term / ad-hoc alerts).
    check("Repeat publishes accumulate timetable emails for the follower", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "p@x.com" });
      s = publishTimetable(s, provA, 6, "Term 1").state;
      s = publishTimetable(s, provA, 3, "New week added").state;
      s = publishTimetable(s, provA, 8, "Summer block").state;
      HC.assert(timetableCount(s, provA.id) === 3, "three timetable emails should be queued, got " + timetableCount(s, provA.id));
    });

    // Follow without an email cannot receive timetables (the email IS the channel).
    check("A follow with no recorded email cannot be sent a timetable", function () {
      var s = emptyState();
      s = followProvider(s, provA, {}); // followed, but no email recorded
      HC.assert(isFollowing(s, provA.id), "still recorded as following");
      var res = publishTimetable(s, provA, 5);
      HC.assert(res.delivered === false, "cannot deliver a timetable with no address on file");
      HC.assert(timetableCount(res.state, provA.id) === 0, "no email recorded without an address");
    });

    // Newsletter opt-in is a SEPARATE, express consent — not implied by Follow.
    check("Newsletter opt-in is separate express consent, defaulting off", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "p@x.com" });
      HC.assert(s.follows[provA.id].newsletterOptIn === false, "Follow alone does not opt into the provider's own newsletter");
      s = followProvider(s, provB, { email: "p@x.com", newsletterOptIn: true });
      HC.assert(s.follows[provB.id].newsletterOptIn === true, "explicit opt-in is honoured");
      s = setNewsletterOptIn(s, provA.id, true);
      HC.assert(s.follows[provA.id].newsletterOptIn === true, "opt-in can be toggled on later");
      s = setNewsletterOptIn(s, provA.id, false);
      HC.assert(s.follows[provA.id].newsletterOptIn === false, "opt-in can be withdrawn");
    });

    // Unfollow removes the parent from that provider's timetable list.
    check("Unfollow removes the parent from the provider's timetable list", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "p@x.com" });
      s = publishTimetable(s, provA, 6).state;
      HC.assert(isFollowing(s, provA.id), "following before unfollow");
      s = unfollowProvider(s, provA.id);
      HC.assert(!isFollowing(s, provA.id), "no longer following after unfollow");
      var res = publishTimetable(s, provA, 6);
      HC.assert(res.delivered === false, "an unfollowed parent receives no further timetables");
    });

    // Re-following the same provider is idempotent and preserves history/timestamp.
    check("Re-following is idempotent and preserves the original follow + outbox", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "p@x.com" });
      var firstAt = s.follows[provA.id].followedAt;
      s = publishTimetable(s, provA, 6).state;
      // follow again (e.g. they re-open the profile) with a newsletter opt-in
      s = followProvider(s, provA, { email: "p@x.com", newsletterOptIn: true });
      HC.assert(Object.keys(s.follows).length === 1, "still a single follow record, not a duplicate");
      HC.assert(s.follows[provA.id].followedAt === firstAt, "original follow timestamp preserved");
      HC.assert(timetableCount(s, provA.id) === 1, "previously queued timetable emails preserved");
      HC.assert(s.follows[provA.id].newsletterOptIn === true, "newsletter opt-in updated on re-follow");
    });

    // Following several providers keeps independent records (multi-follow).
    check("Following multiple providers keeps independent records", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "p@x.com" });
      s = followProvider(s, provB, { email: "p@x.com" });
      HC.assert(followedList(s).length === 2, "two providers followed");
      s = publishTimetable(s, provA, 6).state; // only A publishes
      HC.assert(timetableCount(s, provA.id) === 1, "A's follower got a timetable");
      HC.assert(timetableCount(s, provB.id) === 0, "B's record is untouched by A's publish");
    });

    // Defensive: bad inputs must not throw or corrupt state.
    check("Defensive against missing/invalid provider and bad campCount", function () {
      var s = emptyState();
      var s2 = followProvider(s, null, { email: "p@x.com" });
      HC.assert(followedList(s2).length === 0, "following nothing is a no-op");
      var s3 = followProvider(s, { name: "no id" }, { email: "p@x.com" });
      HC.assert(followedList(s3).length === 0, "a provider with no id cannot be followed");
      s = followProvider(s, provA, { email: "p@x.com" });
      var res = publishTimetable(s, provA, "not-a-number", "Subj");
      HC.assert(res.state.follows[provA.id].timetableEmails[0].campCount === 0, "bad campCount coerced to 0");
    });

    // Persistence round-trips through HC.store (namespaced, not raw localStorage).
    check("Follow state persists via HC.store", function () {
      var s = emptyState();
      s = followProvider(s, provA, { email: "persist@x.com", newsletterOptIn: true });
      s = publishTimetable(s, provA, 9, "Persisted timetable").state;
      var ok = HC.store.set(STORE_KEY, s);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.follows && got.follows[provA.id], "follow survives a store round-trip");
      HC.assert(got.parentEmail === "persist@x.com", "recorded email survives persistence");
      HC.assert(got.follows[provA.id].timetableEmails.length === 1, "queued timetable survives persistence");
      HC.assert(got.follows[provA.id].newsletterOptIn === true, "newsletter opt-in survives persistence");
      // clean up so we don't leave probe state lying around
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // Seed provider is drawn from the LIVE school-age holiday-camp directory.
    check("Seed provider comes from the live holiday-camp directory", function () {
      var seed = pickSeedProvider();
      HC.assert(seed && typeof seed.id === "string" && seed.id.length > 0, "seed has a provider id");
      HC.assert(typeof seed.name === "string" && seed.name.length > 0, "seed has a provider name");
      // when real data is loaded it should be one of the 44 directory providers
      var ps = providers();
      if (ps.length) {
        var found = ps.some(function (p) { return p && p.id === seed.id; });
        HC.assert(found, "seed should be a real directory provider when data is present");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-follow",
    title: "Follow a camp provider",
    side: "parent",
    icon: "🔔",
    summary: "No waiting list for a sold-out camp week — Follow the provider instead. " +
      "Your follow is recorded against them, and you're emailed their timetable the moment new " +
      "holiday-camp dates go live. A separate tick opts you into their own newsletter, following the same marketplace pattern.",
    render: render,
    selfTest: selfTest
  });
})();
