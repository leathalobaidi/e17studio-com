/* HolidayCamp feature module — platform-badge-credit
 *
 * Side: PLATFORM.
 * Replicates Happity's "Badge for credit" / backlink scheme for school-age
 * HOLIDAY CAMPS: a provider who adds the hyperlinked HolidayCamp badge to their
 * own website (and/or printed posters/flyers) earns listing credit, claimed
 * once per provider account.
 *
 * Evidence (Happity support corpus):
 *   - 3496517 "Use the Happity Badge to get £20 in free credit":
 *       "£10 for printed materials … £10 for using our logo on your website …
 *        Or £20 for doing both!"  and  "badges must have a hyperlink to be
 *        eligible for credit."
 *   - 6453700 "T&Cs for Happity Badges":
 *       "Only one claim per provider account for the duration the account is
 *        opened."  "The badge must be hyperlinked back to your Happity page or
 *        the Happity home page."  "Changes to badge image used will not make you
 *        re-eligible for credit."  "Credit must be used within six months …"
 *       "If we believe someone has obtained credit falsely … we reserve the
 *        right to remove credit."  "maximum credit available in this offer is
 *        £20. £10 for printed materials, and £10 for website."
 *   - 04-seo §2.1 — badge backlinks as a link-building / referral lever.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   Adding the hyperlinked badge to a provider site qualifies for credit
 *   (ONE claim per account).
 *
 * Model
 * -----
 * Each provider account has a badge-credit record:
 *   {
 *     accountId,           // provider.id
 *     surfaces: {          // the two claimable surfaces (Happity's £10 + £10)
 *       website: { claimed, evidenceUrl, hyperlinked, awardedAt },
 *       print:   { claimed, evidencePhoto, awardedAt }
 *     },
 *     claimed: Boolean,    // the ONE lifetime claim has been settled
 *     creditPence,         // total credit awarded (max £20 = 2000p)
 *     ledger: [ ... ]      // award/usage/reversal entries
 *   }
 *
 * Eligibility rules (mirrors the T&Cs):
 *   - WEBSITE surface qualifies iff the evidence URL carries an APPROVED badge
 *     that is HYPERLINKED back to the provider's HolidayCamp page OR the
 *     HolidayCamp home page. A badge with no hyperlink is INELIGIBLE.
 *   - PRINT surface qualifies on a clearly-displayed photo of the badge.
 *   - The whole claim is ONE PER ACCOUNT for the account lifetime: once settled
 *     a provider cannot claim again (swapping the badge image does not re-open
 *     eligibility).
 *   - Credit is capped at £20 (£10 website + £10 print).
 *
 * Design notes
 * - Self-contained & DEFENSIVE: never throws at registration time; every read of
 *   live data and store is guarded.
 * - render(mountEl) draws a working claim form: pick a provider, paste a website
 *   URL, toggle "badge is hyperlinked", optionally attach a print photo, submit,
 *   and watch credit awarded — with the one-claim lock enforced live.
 * - Persistence via HC.store (key "badgeCredit.accounts"), never raw localStorage.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    return; // nothing to attach to — fail silent, never throw.
  }
  var HC = window.HC;

  /* ============================================================
     Constants — the scheme parameters, lifted from the evidence.
     ============================================================ */
  var WEBSITE_AWARD_PENCE = 1000;   // £10 for the website badge
  var PRINT_AWARD_PENCE   = 1000;   // £10 for printed materials
  var MAX_CREDIT_PENCE    = 2000;   // £20 cap (3496517 / 6453700)
  var CREDIT_VALID_DAYS   = 182;    // "within six months of receipt"

  // The set of APPROVED badge variants a provider may display (3496517 lists
  // light-purple / yellow "Book with HolidayCamp" + "Find on HolidayCamp").
  var APPROVED_BADGES = [
    { id: "book-purple",  label: "Book with HolidayCamp (purple)", text: "Book with HolidayCamp" },
    { id: "book-yellow",  label: "Book with HolidayCamp (yellow)", text: "Book with HolidayCamp" },
    { id: "find-purple",  label: "Find on HolidayCamp (purple)",   text: "Find on HolidayCamp" },
    { id: "find-yellow",  label: "Find on HolidayCamp (yellow)",   text: "Find on HolidayCamp" }
  ];

  var STORE_KEY = "badgeCredit.accounts";

  /* ============================================================
     Live data helpers (guarded).
     ============================================================ */
  function safeProviders() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  function providerById(id) {
    var ps = safeProviders();
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && String(ps[i].id) === String(id)) return ps[i];
    }
    return null;
  }

  // A provider's canonical HolidayCamp listing URL — the legitimate hyperlink
  // target for the badge (Happity: "your Happity page or the Happity home page").
  function holidayCampPageUrl(provider) {
    var id = provider && provider.id ? String(provider.id) : "x";
    return "https://holidaycamp.example/e17/camp/" + id;
  }
  var HOLIDAYCAMP_HOME = "https://holidaycamp.example/";

  /* ============================================================
     Account store — map of accountId -> record. Guarded read/write.
     ============================================================ */
  function loadAccounts() {
    try {
      var v = HC.store.get(STORE_KEY, {});
      return (v && typeof v === "object") ? v : {};
    } catch (e) { return {}; }
  }
  function saveAccounts(map) {
    try { HC.store.set(STORE_KEY, map || {}); return true; }
    catch (e) { return false; }
  }

  function blankRecord(accountId) {
    return {
      accountId: String(accountId),
      surfaces: {
        website: { claimed: false, evidenceUrl: null, hyperlinked: false, badgeId: null, awardedAt: null },
        print:   { claimed: false, evidencePhoto: null, awardedAt: null }
      },
      claimed: false,        // the ONE lifetime claim settled?
      creditPence: 0,
      ledger: []
    };
  }

  function getRecord(map, accountId) {
    var rec = map[String(accountId)];
    if (!rec) { rec = blankRecord(accountId); map[String(accountId)] = rec; }
    // defensive shape repair
    if (!rec.surfaces) rec.surfaces = blankRecord(accountId).surfaces;
    if (!rec.surfaces.website) rec.surfaces.website = { claimed: false, evidenceUrl: null, hyperlinked: false, badgeId: null, awardedAt: null };
    if (!rec.surfaces.print) rec.surfaces.print = { claimed: false, evidencePhoto: null, awardedAt: null };
    if (!Array.isArray(rec.ledger)) rec.ledger = [];
    if (typeof rec.creditPence !== "number") rec.creditPence = 0;
    return rec;
  }

  /* ============================================================
     Eligibility — the heart of the scheme.

     A WEBSITE badge qualifies iff it is an APPROVED badge that is
     HYPERLINKED back to the provider's HolidayCamp page OR the home page.
     ============================================================ */
  function isApprovedBadge(badgeId) {
    if (!badgeId) return false;
    for (var i = 0; i < APPROVED_BADGES.length; i++) {
      if (APPROVED_BADGES[i].id === badgeId) return true;
    }
    return false;
  }

  function looksLikeUrl(s) {
    return typeof s === "string" && /^https?:\/\/[^\s]+\.[^\s]+/i.test(s.trim());
  }

  function normaliseUrl(u) {
    return String(u == null ? "" : u).trim().replace(/\/+$/, "").toLowerCase();
  }

  // Is the badge's hyperlink target a legitimate HolidayCamp destination for
  // THIS provider? (their listing page or the HolidayCamp home page)
  function hyperlinkIsValid(linkTarget, provider) {
    if (!looksLikeUrl(linkTarget)) return false;
    var t = normaliseUrl(linkTarget);
    var page = normaliseUrl(holidayCampPageUrl(provider));
    var home = normaliseUrl(HOLIDAYCAMP_HOME);
    return t === page || t === home;
  }

  /* Evaluate a WEBSITE submission. Returns a verdict object.
     submission = { provider, evidenceUrl, badgeId, hyperlinked, linkTarget } */
  function evaluateWebsite(submission) {
    var reasons = [];
    var s = submission || {};
    var provider = s.provider;

    if (!provider) reasons.push("No provider account selected.");
    if (!looksLikeUrl(s.evidenceUrl)) {
      reasons.push("A link to your live website (where the badge is shown) is required.");
    }
    if (!isApprovedBadge(s.badgeId)) {
      reasons.push("Badge must be one of the approved HolidayCamp badges.");
    }
    // THE crucial rule: the badge must be hyperlinked back to HolidayCamp.
    if (!s.hyperlinked) {
      reasons.push("The badge is not hyperlinked — a plain image does not qualify.");
    } else if (!hyperlinkIsValid(s.linkTarget, provider)) {
      reasons.push("The badge hyperlink must point to your HolidayCamp page or the HolidayCamp home page.");
    }

    return { surface: "website", eligible: reasons.length === 0, reasons: reasons };
  }

  /* Evaluate a PRINT submission.
     submission = { provider, evidencePhoto, badgeId } */
  function evaluatePrint(submission) {
    var reasons = [];
    var s = submission || {};
    if (!s.provider) reasons.push("No provider account selected.");
    if (!s.evidencePhoto) reasons.push("A photo of the printed poster/flyer on display is required.");
    if (!isApprovedBadge(s.badgeId)) reasons.push("Badge must be an approved HolidayCamp badge, clearly displayed.");
    return { surface: "print", eligible: reasons.length === 0, reasons: reasons };
  }

  /* ============================================================
     claimCredit — submit one or both surfaces for an account.
     Enforces ONE CLAIM PER ACCOUNT and the £20 cap.

     opts = { accountId, website?, print? }
       website = { evidenceUrl, badgeId, hyperlinked, linkTarget }
       print   = { evidencePhoto, badgeId }

     Returns:
       { ok, awardedPence, creditPence, surfaces:{website,print}, reasons:[], record }
     ============================================================ */
  function claimCredit(opts) {
    opts = opts || {};
    var map = loadAccounts();
    var provider = providerById(opts.accountId);
    var accountId = opts.accountId;
    var result = {
      ok: false,
      awardedPence: 0,
      creditPence: 0,
      surfaces: { website: null, print: null },
      reasons: [],
      record: null
    };

    // T&C: "You must have a HolidayCamp account to be eligible."
    if (!provider) {
      result.reasons.push("No such provider account — credit cannot be applied without one.");
      return result;
    }

    var rec = getRecord(map, accountId);
    result.record = rec;
    result.creditPence = rec.creditPence;

    // THE acceptance criterion's hard limit: one claim per account, lifetime.
    if (rec.claimed) {
      result.reasons.push("This account has already claimed its badge credit. Only one claim per account.");
      result.creditPence = rec.creditPence;
      return result;
    }

    var awarded = 0;
    var anySurface = false;

    // ---- WEBSITE surface ----
    if (opts.website) {
      anySurface = true;
      var wv = evaluateWebsite({
        provider: provider,
        evidenceUrl: opts.website.evidenceUrl,
        badgeId: opts.website.badgeId,
        hyperlinked: opts.website.hyperlinked,
        linkTarget: opts.website.linkTarget
      });
      result.surfaces.website = wv;
      if (wv.eligible && !rec.surfaces.website.claimed) {
        rec.surfaces.website.claimed = true;
        rec.surfaces.website.evidenceUrl = String(opts.website.evidenceUrl);
        rec.surfaces.website.hyperlinked = true;
        rec.surfaces.website.badgeId = opts.website.badgeId;
        rec.surfaces.website.awardedAt = Date.now();
        awarded += WEBSITE_AWARD_PENCE;
        rec.ledger.push({ type: "award", surface: "website", pence: WEBSITE_AWARD_PENCE, at: Date.now() });
      } else if (!wv.eligible) {
        result.reasons = result.reasons.concat(wv.reasons);
      }
    }

    // ---- PRINT surface ----
    if (opts.print) {
      anySurface = true;
      var pv = evaluatePrint({
        provider: provider,
        evidencePhoto: opts.print.evidencePhoto,
        badgeId: opts.print.badgeId
      });
      result.surfaces.print = pv;
      if (pv.eligible && !rec.surfaces.print.claimed) {
        rec.surfaces.print.claimed = true;
        rec.surfaces.print.evidencePhoto = String(opts.print.evidencePhoto);
        rec.surfaces.print.awardedAt = Date.now();
        awarded += PRINT_AWARD_PENCE;
        rec.ledger.push({ type: "award", surface: "print", pence: PRINT_AWARD_PENCE, at: Date.now() });
      } else if (!pv.eligible) {
        result.reasons = result.reasons.concat(pv.reasons);
      }
    }

    if (!anySurface) {
      result.reasons.push("Submit a website badge, a printed-materials photo, or both.");
      return result;
    }

    if (awarded > 0) {
      // Apply the £20 cap defensively.
      var newTotal = rec.creditPence + awarded;
      if (newTotal > MAX_CREDIT_PENCE) {
        awarded = Math.max(0, MAX_CREDIT_PENCE - rec.creditPence);
        newTotal = MAX_CREDIT_PENCE;
      }
      rec.creditPence = newTotal;
      rec.claimed = true;           // the single lifetime claim is now settled
      rec.claimedAt = Date.now();
      rec.expiresAt = Date.now() + CREDIT_VALID_DAYS * 24 * 60 * 60 * 1000;
      result.ok = true;
      result.awardedPence = awarded;
    }
    result.creditPence = rec.creditPence;

    saveAccounts(map);
    return result;
  }

  // Reverse credit obtained in bad faith / contravention of the T&Cs.
  // ("we reserve the right to remove credit … or debit your Stripe account")
  function reverseCredit(accountId, reason) {
    var map = loadAccounts();
    var rec = getRecord(map, accountId);
    var removed = rec.creditPence;
    rec.creditPence = 0;
    rec.reversed = true;
    rec.ledger.push({ type: "reversal", pence: -removed, at: Date.now(), reason: reason || "T&C breach" });
    saveAccounts(map);
    return { ok: true, removedPence: removed, record: rec };
  }

  // Read-only snapshot for an account (does not create/persist).
  function statusFor(accountId) {
    var map = loadAccounts();
    var rec = map[String(accountId)];
    if (!rec) return { claimed: false, creditPence: 0, surfaces: { website: false, print: false } };
    return {
      claimed: !!rec.claimed,
      creditPence: rec.creditPence || 0,
      surfaces: {
        website: !!(rec.surfaces && rec.surfaces.website && rec.surfaces.website.claimed),
        print: !!(rec.surfaces && rec.surfaces.print && rec.surfaces.print.claimed)
      }
    };
  }

  function resetAccount(accountId) {
    var map = loadAccounts();
    delete map[String(accountId)];
    saveAccounts(map);
  }

  /* ============================================================
     render(mountEl) — a working claim form.
     ============================================================ */
  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function money(p) {
    try { return HC.util.money(p / 100); } catch (e) { return "£" + (p / 100).toFixed(2); }
  }

  function render(mountEl) {
    try {
      var el = HC.util.el;
      var providers = safeProviders();
      if (!providers.length) {
        mountEl.innerHTML = '<p style="color:var(--muted,#808080)">No provider accounts — the live camp directory looks empty.</p>';
        return;
      }

      mountEl.innerHTML = "";

      mountEl.appendChild(el("p", { style: "font-size:13.5px;color:var(--text,#383838);margin:0 0 14px" },
        "Add the hyperlinked HolidayCamp badge to your website (and/or your printed posters/flyers) and claim listing credit — " +
        "<b>" + money(WEBSITE_AWARD_PENCE) + "</b> for the website, <b>" + money(PRINT_AWARD_PENCE) + "</b> for print, up to <b>" +
        money(MAX_CREDIT_PENCE) + "</b>. The badge must be <b>hyperlinked</b> back to your HolidayCamp page to qualify. " +
        "<b>One claim per account.</b>"));

      // --- account picker ---
      var picker = el("select", { style: fieldStyle() });
      providers.forEach(function (p) {
        var o = el("option", { value: p.id }, escapeText(p.name || p.id));
        picker.appendChild(o);
      });
      mountEl.appendChild(labelled("Provider account", picker));

      // Show the legit hyperlink target for the chosen provider.
      var target = el("div", { style: "font-size:12px;color:var(--muted,#808080);margin:-6px 0 14px" });
      mountEl.appendChild(target);

      // --- badge variant ---
      var badgeSel = el("select", { style: fieldStyle() });
      APPROVED_BADGES.forEach(function (b) {
        badgeSel.appendChild(el("option", { value: b.id }, escapeText(b.label)));
      });
      mountEl.appendChild(labelled("Approved badge", badgeSel));

      // --- website surface ---
      var urlInput = el("input", { type: "text", placeholder: "https://your-camp-site.co.uk/", style: fieldStyle() });
      mountEl.appendChild(labelled("Your website (where the badge is shown)", urlInput));

      var linkInput = el("input", { type: "text", placeholder: "Where the badge links to…", style: fieldStyle() });
      mountEl.appendChild(labelled("Badge hyperlink target", linkInput));

      var hyperWrap = el("label", { style: "display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--text,#383838);margin:0 0 14px;cursor:pointer" });
      var hyperBox = el("input", { type: "checkbox" });
      hyperBox.checked = true;
      hyperWrap.appendChild(hyperBox);
      hyperWrap.appendChild(el("span", {}, "The badge is hyperlinked (not just an image)"));
      mountEl.appendChild(hyperWrap);

      // "Use my HolidayCamp page" convenience.
      var fillBtn = el("button", { class: "hc-btn hc-btn-ghost", type: "button", style: "margin:0 0 16px" },
        "↳ Link to my HolidayCamp page");
      mountEl.appendChild(fillBtn);

      // --- print surface ---
      var printWrap = el("label", { style: "display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--text,#383838);margin:0 0 14px;cursor:pointer" });
      var printBox = el("input", { type: "checkbox" });
      printWrap.appendChild(printBox);
      printWrap.appendChild(el("span", {}, "I have a photo of the printed badge on display (+" + money(PRINT_AWARD_PENCE) + ")"));
      mountEl.appendChild(printWrap);

      var submit = el("button", { class: "hc-btn", type: "button" }, "Claim my credit");
      mountEl.appendChild(submit);

      var out = el("div", { style: "margin-top:16px" });
      mountEl.appendChild(out);

      function currentProvider() { return providerById(picker.value); }

      function refreshTarget() {
        var p = currentProvider();
        if (!p) { target.innerHTML = ""; return; }
        target.innerHTML = "Your HolidayCamp page: <code>" + escapeText(holidayCampPageUrl(p)) + "</code>";
        renderStatus();
      }

      function renderStatus() {
        var p = currentProvider();
        out.innerHTML = "";
        if (!p) return;
        var st = statusFor(p.id);
        var box = el("div", {
          style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;" +
            (st.claimed ? "background:#E1F0E4" : "background:#fff")
        });
        box.innerHTML =
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
            escapeText(p.name || p.id) + "</div>" +
          '<div style="font-size:13px;color:var(--text,#383838);margin-top:4px">' +
            (st.claimed
              ? "✓ Claimed — credit on this account: <b>" + money(st.creditPence) + "</b> " +
                "(website: " + (st.surfaces.website ? "yes" : "no") + ", print: " + (st.surfaces.print ? "yes" : "no") + "). " +
                "<i>One claim per account — no further claims.</i>"
              : "No claim yet on this account.") +
          "</div>";
        out.appendChild(box);

        if (st.claimed) {
          var resetBtn = el("button", { class: "hc-btn hc-btn-ghost", type: "button", style: "margin-top:10px" },
            "Reset this account (demo)");
          resetBtn.addEventListener("click", function () {
            resetAccount(p.id);
            HC.util.toast("Account reset");
            renderStatus();
          });
          out.appendChild(resetBtn);
        }
      }

      fillBtn.addEventListener("click", function () {
        var p = currentProvider();
        if (p) { linkInput.value = holidayCampPageUrl(p); }
      });

      picker.addEventListener("change", refreshTarget);

      submit.addEventListener("click", function () {
        var p = currentProvider();
        if (!p) { HC.util.toast("Pick a provider account"); return; }

        var opts = { accountId: p.id };
        opts.website = {
          evidenceUrl: urlInput.value,
          badgeId: badgeSel.value,
          hyperlinked: !!hyperBox.checked,
          linkTarget: linkInput.value
        };
        if (printBox.checked) {
          opts.print = { evidencePhoto: "poster-" + p.id + ".jpg", badgeId: badgeSel.value };
        }

        var r = claimCredit(opts);
        if (r.ok) {
          HC.util.toast("✓ " + money(r.awardedPence) + " credit awarded");
        } else {
          HC.util.toast("✗ " + (r.reasons[0] || "Could not award credit"));
        }
        renderStatus();
        if (r.reasons.length) {
          var why = el("ul", { style: "font-size:12.5px;color:#9a1f5e;margin:10px 0 0;padding-left:18px" });
          r.reasons.forEach(function (msg) { why.appendChild(el("li", {}, escapeText(msg))); });
          out.appendChild(why);
        }
      });

      refreshTarget();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Badge-credit preview failed: ' +
        escapeText(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function fieldStyle() {
    return "width:100%;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;" +
      "font-family:inherit;font-size:14px;margin:0 0 14px;background:#fff;box-sizing:border-box";
  }
  function labelled(text, control) {
    var el = HC.util.el;
    var wrap = el("div", {});
    wrap.appendChild(el("label", {
      style: "display:block;font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12.5px;" +
        "color:var(--purple,#603488);margin:0 0 5px"
    }, escapeText(text)));
    wrap.appendChild(control);
    return wrap;
  }

  /* ============================================================
     selfTest — exercises the CLAIM LOGIC and asserts the
     acceptance criterion across many cases.
     ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var providers = safeProviders();

    // Use real provider ids so the test exercises live data.
    var A = providers[0] && providers[0].id;
    var B = providers[1] && providers[1].id;
    var C = providers[2] && providers[2].id;

    // Clean slate for the accounts we touch.
    [A, B, C].forEach(function (id) { if (id != null) resetAccount(id); });

    // 0. Live data present.
    check("Live provider directory yields claimable accounts", function () {
      HC.assert(providers.length >= 3, "expected >=3 providers, got " + providers.length);
      HC.assert(A != null && B != null && C != null, "need three provider ids");
    });

    var pageUrlA = holidayCampPageUrl(providerById(A));

    // 1. ACCEPTANCE CRITERION (core): a HYPERLINKED approved badge on the
    //    provider's website qualifies for credit.
    check("Hyperlinked badge on provider site qualifies for website credit", function () {
      var r = claimCredit({
        accountId: A,
        website: { evidenceUrl: "https://camp-a.co.uk/", badgeId: "book-purple",
                   hyperlinked: true, linkTarget: pageUrlA }
      });
      HC.assert(r.ok === true, "claim should succeed: " + r.reasons.join("; "));
      HC.assert(r.awardedPence === WEBSITE_AWARD_PENCE,
        "website award should be " + WEBSITE_AWARD_PENCE + "p, got " + r.awardedPence);
      HC.assert(r.creditPence === WEBSITE_AWARD_PENCE, "account credit should reflect the award");
    });

    // 2. ACCEPTANCE CRITERION (one claim per account): a SECOND claim on the
    //    same account is rejected — even a valid one.
    check("Second claim on the same account is rejected (one claim per account)", function () {
      var r2 = claimCredit({
        accountId: A,
        website: { evidenceUrl: "https://camp-a.co.uk/again", badgeId: "find-yellow",
                   hyperlinked: true, linkTarget: pageUrlA }
      });
      HC.assert(r2.ok === false, "a second claim must not succeed");
      HC.assert(r2.awardedPence === 0, "no further credit on a second claim");
      HC.assert(/only one claim per account/i.test(r2.reasons.join(" ")),
        "rejection reason should cite one-claim-per-account, got: " + r2.reasons.join("; "));
      HC.assert(statusFor(A).creditPence === WEBSITE_AWARD_PENCE,
        "credit unchanged after rejected second claim");
    });

    // 3. NEGATIVE: a badge with NO hyperlink does NOT qualify (the link is the
    //    whole point of the scheme — "badges must have a hyperlink").
    check("Non-hyperlinked badge does NOT qualify", function () {
      resetAccount(B);
      var r = claimCredit({
        accountId: B,
        website: { evidenceUrl: "https://camp-b.co.uk/", badgeId: "book-purple",
                   hyperlinked: false, linkTarget: holidayCampPageUrl(providerById(B)) }
      });
      HC.assert(r.ok === false, "plain image must not qualify");
      HC.assert(r.creditPence === 0, "no credit for a non-hyperlinked badge");
      HC.assert(/not hyperlinked/i.test(r.reasons.join(" ")), "reason should mention hyperlink");
      HC.assert(statusFor(B).claimed === false, "account B must remain unclaimed");
    });

    // 4. NEGATIVE: hyperlink that points somewhere OTHER than HolidayCamp is
    //    ineligible (must link back to your HolidayCamp page / home page).
    check("Badge hyperlinked to a non-HolidayCamp URL does NOT qualify", function () {
      resetAccount(B);
      var r = claimCredit({
        accountId: B,
        website: { evidenceUrl: "https://camp-b.co.uk/", badgeId: "book-purple",
                   hyperlinked: true, linkTarget: "https://some-other-site.com/" }
      });
      HC.assert(r.ok === false, "wrong link target must not qualify");
      HC.assert(/holidaycamp page or the holidaycamp home page/i.test(r.reasons.join(" ")),
        "reason should require linking back to HolidayCamp");
    });

    // 5. POSITIVE: linking to the HolidayCamp HOME page is also valid.
    check("Badge hyperlinked to the HolidayCamp home page qualifies", function () {
      resetAccount(B);
      var r = claimCredit({
        accountId: B,
        website: { evidenceUrl: "https://camp-b.co.uk/", badgeId: "find-purple",
                   hyperlinked: true, linkTarget: HOLIDAYCAMP_HOME }
      });
      HC.assert(r.ok === true, "home-page link should qualify: " + r.reasons.join("; "));
      HC.assert(r.creditPence === WEBSITE_AWARD_PENCE, "home-page link earns the website award");
    });

    // 6. NEGATIVE: an unapproved badge id does not qualify.
    check("Unapproved badge image does NOT qualify", function () {
      resetAccount(C);
      var r = claimCredit({
        accountId: C,
        website: { evidenceUrl: "https://camp-c.co.uk/", badgeId: "homemade-badge",
                   hyperlinked: true, linkTarget: holidayCampPageUrl(providerById(C)) }
      });
      HC.assert(r.ok === false, "non-approved badge must not qualify");
      HC.assert(/approved/i.test(r.reasons.join(" ")), "reason should require an approved badge");
    });

    // 7. BOTH surfaces in one claim = £20, and it still counts as the single
    //    lifetime claim (cannot claim again afterwards).
    check("Website + print in one claim awards £20 and settles the single claim", function () {
      resetAccount(C);
      var pageC = holidayCampPageUrl(providerById(C));
      var r = claimCredit({
        accountId: C,
        website: { evidenceUrl: "https://camp-c.co.uk/", badgeId: "book-yellow",
                   hyperlinked: true, linkTarget: pageC },
        print: { evidencePhoto: "poster-c.jpg", badgeId: "book-yellow" }
      });
      HC.assert(r.ok === true, "combined claim should succeed: " + r.reasons.join("; "));
      HC.assert(r.awardedPence === MAX_CREDIT_PENCE,
        "both surfaces should award the £20 max, got " + r.awardedPence);
      HC.assert(statusFor(C).surfaces.website && statusFor(C).surfaces.print,
        "both surfaces should be recorded");
      // and the one-claim lock holds afterwards
      var again = claimCredit({
        accountId: C,
        print: { evidencePhoto: "poster-c2.jpg", badgeId: "book-yellow" }
      });
      HC.assert(again.ok === false, "no further claim after the £20 claim settles");
    });

    // 8. Credit is capped at £20 even if logic somehow over-awards.
    check("Total credit never exceeds the £20 cap", function () {
      var ids = [A, B, C];
      ids.forEach(function (id) {
        HC.assert(statusFor(id).creditPence <= MAX_CREDIT_PENCE,
          "account " + id + " exceeded the £20 cap");
      });
    });

    // 9. T&C: a missing account cannot be credited ("credit cannot be applied
    //    without one").
    check("Unknown account cannot be credited", function () {
      var r = claimCredit({
        accountId: "no-such-provider-zzz",
        website: { evidenceUrl: "https://x.co/", badgeId: "book-purple", hyperlinked: true,
                   linkTarget: HOLIDAYCAMP_HOME }
      });
      HC.assert(r.ok === false, "unknown account must not be credited");
      HC.assert(/without one/i.test(r.reasons.join(" ")) || r.reasons.length > 0,
        "should explain the account requirement");
    });

    // 10. "Changes to badge image will not make you re-eligible": after a
    //     settled claim, resubmitting with a DIFFERENT approved badge is refused.
    check("Swapping the badge image does not re-open eligibility", function () {
      // account A is already claimed (test 1). Try a different approved badge.
      var r = claimCredit({
        accountId: A,
        website: { evidenceUrl: "https://camp-a.co.uk/v2", badgeId: "find-purple",
                   hyperlinked: true, linkTarget: holidayCampPageUrl(providerById(A)) }
      });
      HC.assert(r.ok === false, "changing the badge must not re-open the claim");
    });

    // 11. Bad-faith reversal removes credit (anti-abuse clause).
    check("Credit obtained in bad faith can be reversed", function () {
      HC.assert(statusFor(A).creditPence > 0, "precondition: A holds credit");
      var rv = reverseCredit(A, "duplicate / bad faith");
      HC.assert(rv.ok === true, "reversal should succeed");
      HC.assert(statusFor(A).creditPence === 0, "credit should be removed after reversal");
    });

    // 12. Persistence: the claim survives a fresh store read (uses HC.store).
    check("Claim persists via HC.store (survives reload)", function () {
      // B was claimed via home-page link (test 5). Re-read from the store.
      var snap = statusFor(B);
      HC.assert(snap.claimed === true, "account B claim should persist");
      HC.assert(snap.creditPence === WEBSITE_AWARD_PENCE, "persisted credit should match");
    });

    // Clean up the accounts we created so we leave the store as found.
    [A, B, C].forEach(function (id) { if (id != null) resetAccount(id); });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "platform-badge-credit",
    title: "Badge-for-credit backlink scheme",
    side: "platform",
    icon: "🏅",
    summary: "Providers who add the hyperlinked HolidayCamp badge to their website (and/or printed posters) earn listing credit — up to £20, one claim per account.",
    render: render,
    selfTest: selfTest
  });
})();
