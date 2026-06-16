/* HolidayCamp feature — provider-claim-listing
 *
 * Claim an unclaimed / auto-imported listing  (PROVIDER side)
 *
 * Replicates Happity's "claim this listing" path. Evidence (support article):
 *   - 8536511 "What to do if your information is wrong":
 *       "If you have an unclaimed listing and would like this updated you can
 *        either: Click 'Claim this listing' which will prompt you to create an
 *        account, this will then give you the flexibility to log in and adjust
 *        this whenever you would like."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: HolidayCamp's directory is seeded with
 * auto-imported camp listings (e.g. scraped from a council HAF page) that no one
 * has logged in to manage yet — these are UNCLAIMED. An unclaimed listing shows a
 * "Claim this listing" CTA. Clicking it routes the camp operator to ACCOUNT
 * CREATION. Once their email is verified, the claim is bound: the previously
 * unclaimed listing is attached to their new provider account, and from then on
 * they can log in and edit it whenever they like. A listing can only be owned by
 * one account; a second claim attempt on the same listing is refused.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   An unclaimed provider listing displays a 'Claim this listing' CTA that routes
 *   to account creation and, on verification, binds the existing listing to the
 *   new provider account for editing.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-claim-listing: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_claim_listing_state";

  // Claim lifecycle for a single listing.
  var CLAIM = {
    UNCLAIMED: "unclaimed",          // auto-imported; no account owns it -> CTA shown
    PENDING: "claim pending",        // a claim was started; account created, email NOT yet verified
    CLAIMED: "claimed"               // email verified; listing bound to the account, editable
  };

  /* ---------------- pure logic (testable, DOM-free) ----------------
   *
   * State persisted via HC.store:
   *   {
   *     claims: {
   *       <listingId>: {
   *         listingId,                 // provider id from the live directory
   *         listingName,               // snapshot of the name for display
   *         status: one of CLAIM.*,
   *         accountId: String|null,    // the claiming provider account (once started)
   *         claimEmail: String|null,   // email the claimant signed up with
   *         verification: null | {
   *           token: String,           // single-use email-verification token
   *           sentAt: ISOString,
   *           consumedAt: ISOString|null
   *         },
   *         startedAt: ISOString|null,
   *         claimedAt: ISOString|null
   *       }
   *     }
   *   }
   *
   * "Unclaimed" is the DEFAULT: a listing with no entry in `claims`, OR an entry
   * whose status is UNCLAIMED, is unclaimed and shows the CTA. Pure functions take
   * a state and return a NEW state — never mutate in place.
   */

  function emptyState() {
    return { claims: {} };
  }

  function cloneState(state) {
    try {
      return JSON.parse(JSON.stringify(state || {}));
    } catch (e) {
      return emptyState();
    }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  function makeToken() {
    return "vrf_" + safeUid().replace(/[^a-z0-9]/gi, "").slice(0, 18);
  }

  function makeAccountId() {
    return "acct_" + safeUid().replace(/[^a-z0-9]/gi, "").slice(0, 16);
  }

  function getClaim(state, listingId) {
    return (state && state.claims && state.claims[listingId]) || null;
  }

  // Is this listing unclaimed (and therefore shows the "Claim this listing" CTA)?
  // A listing with no record at all is unclaimed by default.
  function isUnclaimed(state, listingId) {
    var c = getClaim(state, listingId);
    return !c || c.status === CLAIM.UNCLAIMED;
  }

  // Should the "Claim this listing" CTA be shown for this listing?
  // Only when nobody has yet bound it (unclaimed) — not while pending or claimed.
  function showsClaimCta(state, listingId) {
    return isUnclaimed(state, listingId);
  }

  function isClaimed(state, listingId) {
    var c = getClaim(state, listingId);
    return !!c && c.status === CLAIM.CLAIMED;
  }

  // Who can edit this listing? Only the account it is BOUND to once claimed.
  function canEdit(state, listingId, accountId) {
    var c = getClaim(state, listingId);
    return !!c && c.status === CLAIM.CLAIMED && !!accountId && c.accountId === accountId;
  }

  function emailError(email) {
    var e = email == null ? "" : String(email).trim();
    // Deliberately simple, mock-grade check — not a real RFC validator.
    if (!e) return "Enter an email address to create your account.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "That doesn't look like a valid email address.";
    return null;
  }

  // STEP 1 — CLICK "Claim this listing" -> ROUTE TO ACCOUNT CREATION.
  // Creates a brand-new provider account, attaches it to the listing as a PENDING
  // claim, and issues a single-use email-verification token. The listing is NOT
  // yet editable — binding only completes on verification.
  // Returns { state, ok, error, accountId, verification }.
  function startClaim(state, listing, email) {
    var next = cloneState(state);
    if (!next.claims) next.claims = {};

    listing = listing || {};
    var listingId = listing.id || listing.listingId;
    if (!listingId) {
      return { state: next, ok: false, error: "No listing to claim.", accountId: null, verification: null };
    }

    // Guard: a listing already pending or claimed cannot be re-claimed here.
    var existing = next.claims[listingId];
    if (existing && existing.status === CLAIM.CLAIMED) {
      return { state: next, ok: false, error: "This listing has already been claimed.", accountId: null, verification: null };
    }
    if (existing && existing.status === CLAIM.PENDING) {
      return {
        state: next, ok: false,
        error: "A claim on this listing is already in progress — check your email to verify it.",
        accountId: existing.accountId,
        verification: existing.verification ? { token: existing.verification.token, email: existing.claimEmail } : null
      };
    }

    var eErr = emailError(email);
    if (eErr) {
      return { state: next, ok: false, error: eErr, accountId: null, verification: null };
    }

    var accountId = makeAccountId();
    var token = makeToken();
    next.claims[listingId] = {
      listingId: listingId,
      listingName: String(listing.name || listing.listingName || "Imported camp listing"),
      status: CLAIM.PENDING,
      accountId: accountId,
      claimEmail: String(email).trim(),
      verification: { token: token, sentAt: nowIso(), consumedAt: null },
      startedAt: nowIso(),
      claimedAt: null
    };
    return {
      state: next,
      ok: true,
      error: null,
      accountId: accountId,
      verification: { token: token, email: String(email).trim() }
    };
  }

  // Does this token currently complete the claim (open verification)?
  function tokenVerifiesClaim(state, listingId, token) {
    var c = getClaim(state, listingId);
    if (!c || c.status !== CLAIM.PENDING || !c.verification) return false;
    if (c.verification.consumedAt) return false;
    return !!token && c.verification.token === token;
  }

  // STEP 2 — VERIFY EMAIL -> BIND the existing listing to the new account.
  // Validates the single-use token, consumes it, flips the listing to CLAIMED and
  // records the binding. After this the account can edit the listing.
  // Returns { state, ok, error }.
  function verifyClaim(state, listingId, token) {
    var next = cloneState(state);
    var c = getClaim(next, listingId);
    if (!c) return { state: next, ok: false, error: "No claim has been started for this listing." };
    if (c.status === CLAIM.UNCLAIMED) {
      return { state: next, ok: false, error: "This listing is unclaimed — start a claim first." };
    }
    if (c.status === CLAIM.CLAIMED) {
      return { state: next, ok: false, error: "This listing is already claimed." };
    }
    if (!c.verification || c.verification.consumedAt) {
      return { state: next, ok: false, error: "This verification link has already been used." };
    }
    if (!token || c.verification.token !== token) {
      return { state: next, ok: false, error: "Invalid or expired verification link." };
    }

    c.verification.consumedAt = nowIso();
    c.status = CLAIM.CLAIMED;
    c.claimedAt = nowIso();
    return { state: next, ok: true, error: null };
  }

  // Apply an edit to a CLAIMED listing — proves the binding gives edit rights.
  // Edits are stored on the claim record (mock — the live directory is read-only).
  // Returns { state, ok, error }.
  function editClaimedListing(state, listingId, accountId, patch) {
    var next = cloneState(state);
    var c = getClaim(next, listingId);
    if (!c) return { state: next, ok: false, error: "No claim record for this listing." };
    if (c.status !== CLAIM.CLAIMED) {
      return { state: next, ok: false, error: "You must claim this listing before editing it." };
    }
    if (!accountId || c.accountId !== accountId) {
      return { state: next, ok: false, error: "Only the account that claimed this listing can edit it." };
    }
    c.edits = c.edits && typeof c.edits === "object" ? c.edits : {};
    if (patch && typeof patch === "object") {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) c.edits[k] = patch[k];
      }
    }
    c.lastEditedAt = nowIso();
    return { state: next, ok: true, error: null };
  }

  function statusLabel(status) {
    if (status === CLAIM.UNCLAIMED) return "Unclaimed";
    if (status === CLAIM.PENDING) return "Claim pending verification";
    if (status === CLAIM.CLAIMED) return "Claimed";
    return status || "Unclaimed";
  }

  function listClaims(state) {
    if (!state || !state.claims) return [];
    return Object.keys(state.claims).map(function (id) { return state.claims[id]; });
  }

  /* ---------------- persistence helpers (HC.store only) ---------------- */

  function loadState() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object" || !raw.claims || typeof raw.claims !== "object") {
      return emptyState();
    }
    return raw;
  }

  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Pick a representative live listing to demo as an auto-imported, unclaimed one.
  // HAF / council-imported listings are the natural "unclaimed" candidates.
  function pickSeedListing(state) {
    var ps = providers();
    // Prefer a listing that isn't already claimed in our state.
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (p && p.id && p.name && isUnclaimed(state, p.id)) return p;
    }
    for (var j = 0; j < ps.length; j++) {
      if (ps[j] && ps[j].id && ps[j].name) return ps[j];
    }
    return { id: "imported-haf-camp", name: "Waltham Forest HAF Holiday Camp", area: "Walthamstow" };
  }

  /* ---------------- UI ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function statusPillStyle(status) {
    var base = "display:inline-block;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;" +
      "font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:3px 10px;border-radius:999px;";
    if (status === CLAIM.CLAIMED) return base + "background:#E1F0E4;color:#2f7d4f";
    if (status === CLAIM.PENDING) return base + "background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)";
    return base + "background:#FFF4D6;color:#8a6d00"; // unclaimed
  }

  function render(mountEl) {
    if (!mountEl) return;

    var state = loadState();
    var seed = pickSeedListing(state);
    var listingId = seed.id;

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Some HolidayCamp listings are <strong>auto-imported</strong> (e.g. from a council HAF page) " +
      "and nobody has logged in to manage them yet. Those are <strong>unclaimed</strong>. Exactly like " +
      "Happity, an unclaimed listing shows a <strong>“Claim this listing”</strong> button: click it to " +
      "<strong>create an account</strong>, verify your email, and the existing listing becomes yours to " +
      "log in and edit whenever you like."));

    // ---------- the public listing card (what a parent / operator sees) ----------
    var card = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;margin:0 0 16px;background:#fff"
    });
    wrap.appendChild(card);

    // ---------- account-creation panel (revealed when the CTA is clicked) ----------
    var panel = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;margin:0 0 16px;background:#fff"
    });
    wrap.appendChild(panel);

    mountEl.appendChild(wrap);

    function repaint() {
      var c = getClaim(state, listingId);
      var status = c ? c.status : CLAIM.UNCLAIMED;

      var html = '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
        '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
          esc(seed.name) + "</span>" +
        '<span style="' + statusPillStyle(status) + '">' + esc(statusLabel(status)) + "</span>" +
        "</div>";
      if (seed.area) {
        html += '<div style="font-size:12.5px;color:var(--muted,#808080);margin:3px 0 0">' + esc(seed.area) + "</div>";
      }
      html += '<div style="font-size:11.5px;color:var(--muted,#808080);margin:6px 0 0">' +
        "Auto-imported listing · id " + esc(listingId) + "</div>";

      if (showsClaimCta(state, listingId)) {
        html += '<p style="font-size:13px;margin:12px 0 10px">This listing isn’t managed by anyone yet. ' +
          "Are you the camp organiser?</p>" +
          '<button class="hc-btn" type="button" data-hccl="cta">Claim this listing</button>';
      } else if (status === CLAIM.PENDING) {
        html += '<p style="font-size:13px;margin:12px 0 0;color:var(--purple,#603488)">' +
          "Account created — we’ve emailed a verification link to <strong>" + esc(c.claimEmail) +
          "</strong>. Verify it below to finish claiming this listing.</p>";
      } else if (status === CLAIM.CLAIMED) {
        html += '<p style="font-size:13px;margin:12px 0 0;color:#2f7d4f">✓ You’ve claimed this listing. ' +
          "It’s now bound to your account and you can log in and edit it whenever you like.</p>";
      }
      card.innerHTML = html;

      paintPanel();
      wireCard();
    }

    function paintPanel() {
      var c = getClaim(state, listingId);
      var status = c ? c.status : CLAIM.UNCLAIMED;

      if (status === CLAIM.UNCLAIMED) {
        panel.innerHTML =
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--muted,#808080);font-size:13px">' +
          "Click “Claim this listing” to create your account.</div>";
        return;
      }

      if (status === CLAIM.PENDING) {
        panel.innerHTML =
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
            "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 10px\">" +
            "Verify your email to bind the listing</div>" +
          '<p style="font-size:13px;margin:0 0 10px">Open the link from your inbox (shown here for the demo):</p>' +
          '<div style="background:var(--purple-tint,#F0E8F4);border-radius:10px;padding:10px 12px;margin:0 0 12px;' +
            'font-size:12px;color:var(--purple,#603488);word-break:break-all">' +
            "🔗 holidaycamp.app/claim/verify?token=" + esc(c.verification ? c.verification.token : "") + "</div>" +
          '<button class="hc-btn" type="button" data-hccl="verify">Verify & claim listing</button>';
        return;
      }

      // CLAIMED — show the edit panel, proving the binding gives edit rights.
      var currentName = (c.edits && c.edits.name) || seed.name;
      panel.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
          "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 10px\">" +
          "Edit your listing</div>" +
        '<p style="font-size:13px;margin:0 0 8px">The listing is bound to account <strong>' + esc(c.accountId) +
          "</strong>. Make a change to prove you can now edit it:</p>" +
        '<input id="hcclName" type="text" value="' + esc(currentName).replace(/"/g, "&quot;") + '" ' +
          'style="width:100%;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;' +
          'font-size:14px;box-sizing:border-box;margin:0 0 10px">' +
        '<button class="hc-btn" type="button" data-hccl="edit">Save change</button>';
    }

    function wireCard() {
      var ctaBtn = card.querySelector('[data-hccl="cta"]');
      if (ctaBtn) {
        ctaBtn.addEventListener("click", function () {
          // CTA routes to account creation: collect an email, then start the claim.
          var email = "";
          try {
            email = window.prompt
              ? window.prompt("Create your account — enter your email to claim “" + seed.name + "”:", "")
              : "";
          } catch (e) { email = ""; }
          if (email === null) return; // user cancelled
          if (!email) {
            // Fall back to a deterministic demo email so the flow is always shown.
            email = "claimant@" + String(listingId).replace(/[^a-z0-9]/gi, "").slice(0, 14) + ".example";
          }
          var res = startClaim(state, seed, email);
          state = res.state;
          saveState(state);
          try {
            HC.util.toast(res.ok
              ? "Account created — verification email sent to " + res.verification.email
              : (res.error || "Could not start claim"));
          } catch (e) {}
          repaint();
        });
      }

      var verifyBtn = panel.querySelector('[data-hccl="verify"]');
      if (verifyBtn) {
        verifyBtn.addEventListener("click", function () {
          var c = getClaim(state, listingId);
          var token = c && c.verification ? c.verification.token : "";
          var res = verifyClaim(state, listingId, token);
          state = res.state;
          saveState(state);
          try {
            HC.util.toast(res.ok
              ? "Email verified — listing bound to your account. You can edit it now."
              : (res.error || "Could not verify"));
          } catch (e) {}
          repaint();
        });
      }

      var editBtn = panel.querySelector('[data-hccl="edit"]');
      if (editBtn) {
        editBtn.addEventListener("click", function () {
          var c = getClaim(state, listingId);
          var field = panel.querySelector("#hcclName");
          var newName = field ? field.value : "";
          var res = editClaimedListing(state, listingId, c ? c.accountId : null, { name: newName });
          state = res.state;
          saveState(state);
          try {
            HC.util.toast(res.ok ? "Saved — your listing is updated." : (res.error || "Could not save"));
          } catch (e) {}
          repaint();
        });
      }
    }

    // A small "reset this demo" affordance so the mockup can be replayed.
    var resetRow = HC.util.el("div", { style: "margin-top:4px" });
    var resetBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Reset demo");
    resetBtn.addEventListener("click", function () {
      if (state.claims && state.claims[listingId]) {
        delete state.claims[listingId];
        saveState(state);
      }
      try { HC.util.toast("Demo reset — listing is unclaimed again"); } catch (e) {}
      repaint();
    });
    resetRow.appendChild(resetBtn);
    wrap.appendChild(resetRow);

    repaint();
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var listing = { id: "imported-haf-camp", name: "Waltham Forest HAF Holiday Camp", area: "Walthamstow" };
    var email = "organiser@hafcamp.example";

    // ACCEPTANCE CRITERION, part A: an unclaimed listing displays the
    // "Claim this listing" CTA.
    check("An auto-imported listing is unclaimed and shows the 'Claim this listing' CTA", function () {
      var s = emptyState();
      HC.assert(isUnclaimed(s, listing.id) === true, "a listing with no record is unclaimed by default");
      HC.assert(showsClaimCta(s, listing.id) === true, "the claim CTA is shown for an unclaimed listing");
      HC.assert(isClaimed(s, listing.id) === false, "an unclaimed listing is not claimed");
      HC.assert(canEdit(s, listing.id, "anyone") === false, "nobody can edit an unclaimed listing");
    });

    // ACCEPTANCE CRITERION, part B: clicking the CTA ROUTES TO ACCOUNT CREATION —
    // it makes a new account and issues an email-verification token. The listing
    // is NOT yet bound/editable.
    check("Clicking 'Claim this listing' routes to account creation (new account + verification email)", function () {
      var res = startClaim(emptyState(), listing, email);
      HC.assert(res.ok === true, "starting a claim on an unclaimed listing succeeds");
      HC.assert(typeof res.accountId === "string" && res.accountId.length > 0, "a brand-new provider account is created");
      HC.assert(res.verification && typeof res.verification.token === "string" && res.verification.token.length > 0,
        "a verification email/token is issued");
      HC.assert(res.verification.email === email, "the verification email is addressed to the sign-up email");
      var c = getClaim(res.state, listing.id);
      HC.assert(c.status === CLAIM.PENDING, "listing moves to 'claim pending', not yet claimed");
      HC.assert(c.accountId === res.accountId, "the claim records the new account");
      HC.assert(showsClaimCta(res.state, listing.id) === false, "the CTA disappears once a claim is in progress");
      HC.assert(canEdit(res.state, listing.id, res.accountId) === false, "the listing is NOT editable before verification");
    });

    // ACCEPTANCE CRITERION, part C: ON VERIFICATION, the EXISTING listing is BOUND
    // to the new account, and that account can now EDIT it.
    check("On verification, the existing listing binds to the new account and becomes editable", function () {
      var started = startClaim(emptyState(), listing, email);
      var token = getClaim(started.state, listing.id).verification.token;
      HC.assert(tokenVerifiesClaim(started.state, listing.id, token) === true, "the issued token verifies the claim");
      var ver = verifyClaim(started.state, listing.id, token);
      HC.assert(ver.ok === true, "verification succeeds with the right token");
      var c = getClaim(ver.state, listing.id);
      HC.assert(c.status === CLAIM.CLAIMED, "listing becomes 'claimed' after verification");
      HC.assert(isClaimed(ver.state, listing.id) === true, "isClaimed() recognises the bound listing");
      HC.assert(c.accountId === started.accountId, "the SAME existing listing id is bound to the new account");
      HC.assert(c.listingId === listing.id, "binding preserves the original (auto-imported) listing identity");
      // The bound account can now edit; nobody else can.
      HC.assert(canEdit(ver.state, listing.id, started.accountId) === true, "the claiming account can now edit the listing");
      HC.assert(canEdit(ver.state, listing.id, "someone-else") === false, "an unrelated account still cannot edit it");
      var edited = editClaimedListing(ver.state, listing.id, started.accountId, { name: "Renamed HAF Camp" });
      HC.assert(edited.ok === true, "the claiming account can apply an edit to the listing");
      HC.assert(getClaim(edited.state, listing.id).edits.name === "Renamed HAF Camp", "the edit is recorded against the listing");
    });

    // Full end-to-end happy path in one go.
    check("End-to-end: unclaimed -> claim -> create account -> verify -> claimed & editable", function () {
      var s = emptyState();
      HC.assert(showsClaimCta(s, listing.id), "step 0: CTA shown");
      var started = startClaim(s, listing, email);
      HC.assert(getClaim(started.state, listing.id).status === CLAIM.PENDING, "step 1: pending after account creation");
      var token = getClaim(started.state, listing.id).verification.token;
      var ver = verifyClaim(started.state, listing.id, token);
      HC.assert(getClaim(ver.state, listing.id).status === CLAIM.CLAIMED, "step 2: claimed after verification");
      HC.assert(canEdit(ver.state, listing.id, started.accountId) === true, "step 3: editable by the owner");
      HC.assert(showsClaimCta(ver.state, listing.id) === false, "step 4: CTA no longer shown once claimed");
    });

    // The verification token is single-use.
    check("Verification token is single-use (consumed on first verify)", function () {
      var started = startClaim(emptyState(), listing, email);
      var token = getClaim(started.state, listing.id).verification.token;
      var v1 = verifyClaim(started.state, listing.id, token);
      HC.assert(v1.ok === true, "first verification succeeds");
      HC.assert(getClaim(v1.state, listing.id).verification.consumedAt, "token marked consumed");
      HC.assert(tokenVerifiesClaim(v1.state, listing.id, token) === false, "consumed token no longer verifies");
      var v2 = verifyClaim(v1.state, listing.id, token);
      HC.assert(v2.ok === false, "the same link can't be used twice");
      HC.assert(/already (used|claimed)/i.test(v2.error || ""), "error says link used / already claimed, got: " + v2.error);
    });

    // A wrong/forged token must not verify the claim.
    check("A wrong verification token cannot claim the listing", function () {
      var started = startClaim(emptyState(), listing, email);
      HC.assert(tokenVerifiesClaim(started.state, listing.id, "vrf_forged0000") === false, "forged token rejected");
      var v = verifyClaim(started.state, listing.id, "vrf_forged0000");
      HC.assert(v.ok === false, "verification fails with a bad token");
      HC.assert(getClaim(v.state, listing.id).status === CLAIM.PENDING, "listing stays pending, not claimed");
    });

    // A claimed listing cannot be double-claimed (one owner only).
    check("A claimed listing cannot be claimed by a second account", function () {
      var started = startClaim(emptyState(), listing, email);
      var token = getClaim(started.state, listing.id).verification.token;
      var ver = verifyClaim(started.state, listing.id, token);
      HC.assert(isClaimed(ver.state, listing.id) === true, "listing is claimed by the first account");
      var second = startClaim(ver.state, listing, "rival@other.example");
      HC.assert(second.ok === false, "a second claim is refused");
      HC.assert(/already been claimed/i.test(second.error || ""), "error explains it's already claimed, got: " + second.error);
      // Ownership is unchanged.
      HC.assert(getClaim(second.state, listing.id).accountId === started.accountId, "original owner retained");
      HC.assert(canEdit(second.state, listing.id, started.accountId) === true, "original owner keeps edit rights");
    });

    // Starting a claim twice (before verifying) doesn't create a second account.
    check("Re-clicking the CTA while pending does not create a second account", function () {
      var first = startClaim(emptyState(), listing, email);
      var again = startClaim(first.state, listing, "different@email.example");
      HC.assert(again.ok === false, "a second claim-start while pending is refused");
      HC.assert(again.accountId === first.accountId, "it surfaces the SAME in-progress account, not a new one");
      HC.assert(/in progress/i.test(again.error || ""), "error explains a claim is already underway, got: " + again.error);
      HC.assert(getClaim(again.state, listing.id).claimEmail === email, "the original claimant email is preserved");
    });

    // Account creation validates the email (the "create an account" step).
    check("Account creation rejects an invalid email", function () {
      var bad = startClaim(emptyState(), listing, "not-an-email");
      HC.assert(bad.ok === false, "an invalid email is rejected");
      HC.assert(getClaim(bad.state, listing.id) === null, "no claim/account is created from a bad email");
      var empty = startClaim(emptyState(), listing, "");
      HC.assert(empty.ok === false, "an empty email is rejected");
      HC.assert(emailError("good@camp.example") === null, "a valid email passes");
    });

    // Editing is gated on having claimed the listing.
    check("An unclaimed or pending listing cannot be edited", function () {
      var unclaimed = editClaimedListing(emptyState(), listing.id, "acct_x", { name: "Hax" });
      HC.assert(unclaimed.ok === false, "can't edit a listing with no claim record");
      var started = startClaim(emptyState(), listing, email);
      var pendingEdit = editClaimedListing(started.state, listing.id, started.accountId, { name: "Too soon" });
      HC.assert(pendingEdit.ok === false, "can't edit while the claim is only pending");
      HC.assert(/claim this listing before editing/i.test(pendingEdit.error || ""), "error tells them to claim first");
    });

    // Verifying before any claim is started is a clean no-op error.
    check("Verifying with no claim started fails cleanly", function () {
      var v = verifyClaim(emptyState(), listing.id, "vrf_anything");
      HC.assert(v.ok === false, "verifying a never-claimed listing fails");
      HC.assert(/no claim/i.test(v.error || ""), "error explains there's no claim, got: " + v.error);
      HC.assert(isUnclaimed(v.state, listing.id) === true, "the listing remains unclaimed");
    });

    // Defensive: missing/garbage inputs never throw or corrupt state.
    check("Defensive against missing listings and garbage state", function () {
      var noId = startClaim(emptyState(), { name: "No id here" }, email);
      HC.assert(noId.ok === false, "a listing with no id can't be claimed");
      HC.assert(/no listing/i.test(noId.error || ""), "error explains there's nothing to claim");
      HC.assert(getClaim(null, "x") === null, "getClaim on null state is null, not a throw");
      HC.assert(isUnclaimed(null, "x") === true, "isUnclaimed on null state defaults to true");
      HC.assert(listClaims(undefined).length === 0, "listClaims on undefined is empty");
      var cloned = cloneState({ claims: { a: { status: CLAIM.CLAIMED } } });
      HC.assert(cloned.claims.a.status === CLAIM.CLAIMED, "cloneState round-trips a real object");
    });

    // Persistence round-trips through HC.store (namespaced, not raw localStorage).
    check("Claim state persists via HC.store", function () {
      var started = startClaim(emptyState(), listing, email);
      var token = getClaim(started.state, listing.id).verification.token;
      var ver = verifyClaim(started.state, listing.id, token);
      var ok = HC.store.set(STORE_KEY, ver.state);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.claims && got.claims[listing.id], "claim survives a store round-trip");
      HC.assert(got.claims[listing.id].status === CLAIM.CLAIMED, "claimed status survives persistence");
      HC.assert(got.claims[listing.id].accountId === started.accountId, "the account binding survives persistence");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // The demo listing is drawn from the LIVE school-age holiday-camp directory.
    check("Seed listing comes from the live holiday-camp directory", function () {
      var seed = pickSeedListing(emptyState());
      HC.assert(seed && typeof seed.id === "string" && seed.id.length > 0, "seed has a listing id");
      HC.assert(typeof seed.name === "string" && seed.name.length > 0, "seed has a listing name");
      var ps = providers();
      if (ps.length) {
        var found = ps.some(function (p) { return p && p.id === seed.id; });
        HC.assert(found, "seed should be a real directory listing when data is present");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-claim-listing",
    title: "Claim an unclaimed listing",
    side: "provider",
    icon: "📌",
    summary: "Just like Happity: auto-imported camp listings that nobody manages show a " +
      "“Claim this listing” button. Clicking it creates a provider account and emails a " +
      "verification link; once verified, the existing listing is bound to the new account so the " +
      "organiser can log in and edit it whenever they like. One owner per listing.",
    render: render,
    selfTest: selfTest
  });
})();
