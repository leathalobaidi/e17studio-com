/* HolidayCamp feature module — platform-unclaimed-listings
 *
 * Side: PLATFORM.
 * Replicates Happity's AUTO-AGGREGATED UNCLAIMED LISTINGS model: the directory
 * carries provider listings that the platform created (by aggregating public
 * info) rather than the provider authoring them. These "unclaimed" listings
 * still appear in search, and a provider can later CLAIM one — which converts it
 * into a normal provider-authored, registered/active listing.
 *
 * Evidence (Happity support corpus):
 *   - Article 8536511 ("What to do if your information is wrong"):
 *       "If you have an unclaimed listing and would like this updated you can
 *        either: 1. Click 'Claim this listing' which will prompt you to create
 *        an account, this will then give you the flexibility to log in and
 *        adjust this whenever you would like."
 *     -> proves: (a) listings exist that the provider did NOT author
 *        ("unclaimed"), (b) they are claimable via a "Claim this listing"
 *        action, (c) claiming creates the provider account and hands over edit
 *        rights.
 *   - Parent Referral T&Cs (Article 7176277):
 *       "A New Provider is an eligible organisation that is not currently
 *        registered with and has never registered with Happity before … some
 *        providers cannot yet be found in a public search but will not qualify
 *        as New Providers."
 *     -> proves a PRE-REGISTRATION state distinct from both "unclaimed/visible"
 *        and "registered": referred/processing providers that are NOT yet in
 *        public search. We model this as the "pending" status.
 *
 * The model (framed for school-age HOLIDAY CAMPS):
 *   A directory listing has a distinct LIFECYCLE STATUS:
 *     • "unclaimed"  — platform-aggregated, NOT provider-authored. Visible in
 *                      public search. Has a "Claim this listing" affordance.
 *     • "pending"    — pre-registration / referred / being processed. NOT yet in
 *                      public search (cannot yet be found). Becomes claimable
 *                      once the platform publishes it (-> unclaimed/visible).
 *     • "claimed"    — a provider has claimed an aggregated listing; an account
 *                      now exists and the provider can edit it. Visible.
 *     • "active"     — provider-authored from the start (organic signup).
 *                      Visible. (Distinct origin from "claimed".)
 *   searchable(status)  -> true for unclaimed | claimed | active; false pending.
 *   isProviderAuthored  -> true for claimed | active; false for unclaimed |
 *                          pending  (the acceptance criterion's "aggregated, not
 *                          provider-authored" distinction).
 *
 *   claim(listing)   -> only an unclaimed (or just-published) listing can be
 *                       claimed; transitions unclaimed -> claimed, stamps a
 *                       claimedAt + creates a (mock) provider account, and the
 *                       listing keeps appearing in search throughout.
 *   publish(listing) -> pending -> unclaimed (now findable in public search,
 *                       and therefore now claimable).
 *
 * The live E17 directory (HC.data.providers) has no status field — every camp
 * there is an organically-authored "active" listing. This feature OVERLAYS a
 * status model on top: it derives a working set where a handful of real camps
 * are treated as platform-aggregated "unclaimed" seeds (deterministic by id) so
 * the directory genuinely contains not-provider-authored listings that show in
 * search and can be claimed. Overlay state (which have been claimed) persists in
 * HC.store, never raw localStorage.
 *
 * Acceptance criterion (asserted in selfTest, multiple cases):
 *   The directory model supports provider listings in an 'unclaimed' state
 *   (aggregated, not provider-authored) that appear in search and can later be
 *   claimed; status is tracked distinctly from registered/active providers.
 *
 * Defensive throughout: every data read is guarded; a malformed record can never
 * throw at registration time or while building / mutating the working set.
 */
(function () {
  "use strict";

  /* ---------------- status model ---------------- */
  var STATUS = {
    UNCLAIMED: "unclaimed", // aggregated by platform, not provider-authored, visible
    PENDING: "pending",     // pre-registration / referred, NOT in public search
    CLAIMED: "claimed",     // provider claimed an aggregated listing (now authored)
    ACTIVE: "active"        // provider-authored from signup (registered)
  };
  var VALID_STATUSES = [STATUS.UNCLAIMED, STATUS.PENDING, STATUS.CLAIMED, STATUS.ACTIVE];

  var STORE_KEY = "unclaimedListings.overlay";

  // Deterministically seed a few real camps as platform-aggregated "unclaimed"
  // and one as "pending" (pre-registration), so the directory genuinely holds
  // not-provider-authored listings. Chosen by a stable hash of the id, so the
  // demo is reproducible without hard-coding ids that may change.
  var UNCLAIMED_SEED_EVERY = 5; // ~1 in 5 real camps treated as aggregated
  var PENDING_SEED_EVERY = 7;   // rarer: a pre-registration / referred camp
  // After deriving statuses we GUARANTEE at least one unclaimed and one pending
  // listing exist (so the directory always demonstrates both aggregated states,
  // regardless of how the underlying camp ids hash). See ensureSeedCoverage().

  /* ---------------- small guards ---------------- */
  function safeArr(v) { return Array.isArray(v) ? v : []; }
  function safeStr(v) { return v == null ? "" : String(v); }

  function hashInt(id) {
    var s = safeStr(id);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
    return h;
  }

  /* ---------------- status predicates ---------------- */
  function isValidStatus(status) {
    return VALID_STATUSES.indexOf(status) !== -1;
  }

  // A listing is searchable (appears in the public directory) unless it is still
  // pre-registration ("pending" / cannot yet be found in a public search).
  function searchable(status) {
    return status === STATUS.UNCLAIMED ||
           status === STATUS.CLAIMED ||
           status === STATUS.ACTIVE;
  }

  // Provider-authored == registered with the platform under an account. Unclaimed
  // and pending listings are aggregated / referred, NOT provider-authored.
  function isProviderAuthored(status) {
    return status === STATUS.CLAIMED || status === STATUS.ACTIVE;
  }

  // Claimable == an aggregated listing the provider hasn't taken over yet, and
  // which is actually in public search (you can't claim what isn't published).
  function isClaimable(status) {
    return status === STATUS.UNCLAIMED;
  }

  function statusLabel(status) {
    switch (status) {
      case STATUS.UNCLAIMED: return "Unclaimed";
      case STATUS.PENDING: return "Pre-registration";
      case STATUS.CLAIMED: return "Claimed";
      case STATUS.ACTIVE: return "Registered";
      default: return "Unknown";
    }
  }

  /* ---------------- working set (directory overlay) ---------------- */
  // Build a listing record from a real camp, assigning a derived status. The
  // overlay map (id -> { status, claimedAt, accountId }) can override the derived
  // status for camps the user has claimed in this demo.
  function deriveSeedStatus(camp) {
    var id = camp && camp.id;
    var h = hashInt(id);
    if (h % PENDING_SEED_EVERY === 0) return STATUS.PENDING;
    if (h % UNCLAIMED_SEED_EVERY === 0) return STATUS.UNCLAIMED;
    return STATUS.ACTIVE;
  }

  function loadOverlay() {
    var ov = HC.store.get(STORE_KEY, {});
    return (ov && typeof ov === "object") ? ov : {};
  }
  function saveOverlay(ov) {
    HC.store.set(STORE_KEY, ov && typeof ov === "object" ? ov : {});
  }

  // Guarantee the demo directory always contains at least one unclaimed AND one
  // pending listing, whatever the underlying ids hash to. We pick deterministic
  // camps (lowest hashInt) to force into each state, so the result is stable.
  // `seeds` is an array of { camp, id, status }; mutated in place.
  function ensureSeedCoverage(seeds) {
    function hasStatus(s) {
      return seeds.some(function (x) { return x.status === s; });
    }
    // Order camps deterministically by hash so "force" picks are reproducible.
    var byHash = seeds.slice().sort(function (a, b) {
      var d = hashInt(a.id) - hashInt(b.id);
      return d !== 0 ? d : (a.id < b.id ? -1 : 1);
    });
    // Force a pending listing if none derived (prefer a currently-active camp).
    if (!hasStatus(STATUS.PENDING)) {
      var pTarget = byHash.filter(function (x) { return x.status === STATUS.ACTIVE; })[0] || byHash[0];
      if (pTarget) pTarget.status = STATUS.PENDING;
    }
    // Force an unclaimed listing if none derived (prefer a currently-active camp).
    if (!hasStatus(STATUS.UNCLAIMED)) {
      var uTarget = byHash.filter(function (x) { return x.status === STATUS.ACTIVE; })[0] ||
        byHash.filter(function (x) { return x.status !== STATUS.PENDING; })[0] || byHash[0];
      if (uTarget) uTarget.status = STATUS.UNCLAIMED;
    }
    return seeds;
  }

  // Returns the full directory as listing records with a status each. Pure with
  // respect to an explicit overlay so selfTest can pass its own.
  function buildListings(overlay) {
    var ov = overlay && typeof overlay === "object" ? overlay : {};
    var providers = safeArr(HC.data.providers);

    // 1. Derive raw seed statuses (platform-aggregated overlay on real camps).
    var seeds = [];
    for (var i = 0; i < providers.length; i++) {
      var camp = providers[i];
      if (!camp || typeof camp !== "object") continue;
      var id = safeStr(camp.id) || ("idx-" + i);
      seeds.push({ camp: camp, id: id, status: deriveSeedStatus(camp) });
    }
    // 2. Guarantee both aggregated states are represented.
    ensureSeedCoverage(seeds);

    // 3. Apply overrides (claims persisted in the overlay) and build records.
    var out = [];
    for (var j = 0; j < seeds.length; j++) {
      var s = seeds[j];
      var status = s.status;
      var claimedAt = null;
      var accountId = null;
      var override = ov[s.id];
      if (override && typeof override === "object") {
        if (isValidStatus(override.status)) status = override.status;
        claimedAt = override.claimedAt || null;
        accountId = override.accountId || null;
      }
      out.push({
        id: s.id,
        name: safeStr(s.camp.name) || "(unnamed camp)",
        area: safeStr(s.camp.area),
        status: status,
        claimedAt: claimedAt,
        accountId: accountId,
        // convenience flags (the acceptance-criterion distinctions)
        inSearch: searchable(status),
        providerAuthored: isProviderAuthored(status),
        claimable: isClaimable(status)
      });
    }
    return out;
  }

  // The public search projection: only searchable listings appear. This is what
  // a parent would see in the directory.
  function searchListings(listings) {
    return safeArr(listings).filter(function (l) { return l && l.inSearch; });
  }

  /* ---------------- transitions ---------------- */
  // publish: pending -> unclaimed (now findable in public search & claimable).
  // Returns a NEW status string; throws if the transition is illegal.
  function publish(status) {
    if (status !== STATUS.PENDING) {
      throw new Error("only a pending (pre-registration) listing can be published");
    }
    return STATUS.UNCLAIMED;
  }

  // claim: unclaimed -> claimed. Creates a mock provider account + timestamp.
  // Throws if the listing is not claimable (already authored, or still pending).
  function claim(listing) {
    if (!listing || typeof listing !== "object") {
      throw new Error("claim: a listing is required");
    }
    if (!isClaimable(listing.status)) {
      if (isProviderAuthored(listing.status)) {
        throw new Error("listing is already provider-authored (" + listing.status + ")");
      }
      if (listing.status === STATUS.PENDING) {
        throw new Error("pre-registration listing must be published before it can be claimed");
      }
      throw new Error("listing is not claimable (status " + listing.status + ")");
    }
    return {
      status: STATUS.CLAIMED,
      claimedAt: new Date().toISOString(),
      accountId: "acct_" + (HC.util && HC.util.uid ? HC.util.uid() : Date.now())
    };
  }

  // Apply a claim to the persisted overlay for a given id and return the result.
  function commitClaim(id) {
    var listings = buildListings(loadOverlay());
    var listing = null;
    for (var i = 0; i < listings.length; i++) {
      if (listings[i].id === id) { listing = listings[i]; break; }
    }
    if (!listing) throw new Error("no listing with id " + id);
    var res = claim(listing); // throws if not claimable
    var ov = loadOverlay();
    ov[id] = { status: res.status, claimedAt: res.claimedAt, accountId: res.accountId };
    saveOverlay(ov);
    return res;
  }

  /* ---------------- counts (for the UI summary) ---------------- */
  function tally(listings) {
    var t = { unclaimed: 0, pending: 0, claimed: 0, active: 0, inSearch: 0, authored: 0, total: 0 };
    safeArr(listings).forEach(function (l) {
      if (!l) return;
      t.total += 1;
      if (l.status === STATUS.UNCLAIMED) t.unclaimed += 1;
      else if (l.status === STATUS.PENDING) t.pending += 1;
      else if (l.status === STATUS.CLAIMED) t.claimed += 1;
      else if (l.status === STATUS.ACTIVE) t.active += 1;
      if (l.inSearch) t.inSearch += 1;
      if (l.providerAuthored) t.authored += 1;
    });
    return t;
  }

  /* ---------------- render ---------------- */
  function statusPill(status) {
    var bg = "#F0E8F4", fg = "#603488";
    if (status === STATUS.UNCLAIMED) { bg = "#FFF3D6"; fg = "#8a6d00"; }
    else if (status === STATUS.PENDING) { bg = "#EDEDED"; fg = "#666"; }
    else if (status === STATUS.CLAIMED) { bg = "#E1F0E4"; fg = "#2f7d4f"; }
    else if (status === STATUS.ACTIVE) { bg = "#E6EEFB"; fg = "#2b5cb8"; }
    return '<span style="display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;' +
      'background:' + bg + ';color:' + fg + ';text-transform:uppercase;letter-spacing:.3px">' +
      esc(statusLabel(status)) + "</span>";
  }

  function esc(s) {
    return safeStr(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var listings = buildListings(loadOverlay());
      var t = tally(listings);
      var search = searchListings(listings);

      var html =
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 12px">' +
          "The directory carries listings the <strong>platform aggregated</strong> for camps that never signed up " +
          "(<em>unclaimed</em>), plus referred camps still being processed (<em>pre-registration</em>, not yet in search). " +
          "A camp owner can <strong>Claim this listing</strong> to take it over — turning it into a registered, " +
          "provider-authored listing.</p>" +

        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px">' +
          statBox("Unclaimed", t.unclaimed, "#FFF3D6", "#8a6d00") +
          statBox("Pre-reg", t.pending, "#EDEDED", "#666") +
          statBox("Claimed", t.claimed, "#E1F0E4", "#2f7d4f") +
          statBox("Registered", t.active, "#E6EEFB", "#2b5cb8") +
          statBox("In public search", t.inSearch, "#F0E8F4", "#603488") +
        "</div>" +

        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 8px">' +
          "Showing the " + t.unclaimed + " unclaimed + " + t.pending + " pre-registration listings " +
          "(the not-provider-authored records). " + t.inSearch + " of " + t.total +
          " total listings appear in public search; pre-registration ones do not.</p>" +

        '<div id="hcUnclaimedList" style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto">';

      var aggregated = listings.filter(function (l) {
        return l.status === STATUS.UNCLAIMED || l.status === STATUS.PENDING || l.status === STATUS.CLAIMED;
      });
      if (!aggregated.length) {
        html += '<p style="color:var(--muted,#808080);font-size:13px">No aggregated listings in this directory.</p>';
      }
      for (var i = 0; i < aggregated.length; i++) {
        var l = aggregated[i];
        var canClaim = l.claimable;
        var inSearchTag = l.inSearch
          ? '<span style="color:#2f7d4f">● in search</span>'
          : '<span style="color:#b85c00">○ not yet in search</span>';
        html +=
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:10px 12px;' +
            'display:flex;align-items:center;gap:10px;justify-content:space-between">' +
            '<div style="min-width:0">' +
              '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);' +
                'font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(l.name) + "</div>" +
              '<div style="font-size:11.5px;color:var(--muted,#808080);margin-top:2px">' +
                (l.area ? esc(l.area) + " · " : "") + inSearchTag +
                (l.claimedAt ? ' · claimed' : '') + "</div>" +
            "</div>" +
            '<div style="display:flex;align-items:center;gap:8px;flex:0 0 auto">' +
              statusPill(l.status) +
              (canClaim
                ? '<button class="hc-btn" type="button" data-hc-claim="' + esc(l.id) + '">Claim this listing</button>'
                : "") +
            "</div>" +
          "</div>";
      }
      html += "</div>";

      mountEl.innerHTML = html;

      // Wire the Claim buttons (scoped to this mount, not global delegation).
      var btns = mountEl.querySelectorAll("[data-hc-claim]");
      for (var b = 0; b < btns.length; b++) {
        btns[b].addEventListener("click", function (e) {
          var id = e.currentTarget.getAttribute("data-hc-claim");
          try {
            var res = commitClaim(id);
            if (HC.util && HC.util.toast) {
              HC.util.toast("Listing claimed — account " + (res.accountId || "created") + ". It stays in search.");
            }
            render(mountEl); // re-render to reflect the new claimed state
          } catch (err) {
            if (HC.util && HC.util.toast) HC.util.toast("Could not claim: " + (err && err.message ? err.message : err));
          }
        });
      }
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Unclaimed-listings preview failed: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function statBox(label, n, bg, fg) {
    return '<div style="background:' + bg + ';color:' + fg + ';border-radius:12px;padding:8px 12px;min-width:78px;text-align:center">' +
      '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:20px;line-height:1">' + Number(n || 0) + "</div>" +
      '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;margin-top:2px">' + esc(label) + "</div>" +
    "</div>";
  }

  /* ---------------- selfTest ---------------- */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // CASE A: status predicates encode the searchable / authored distinctions.
    check("CASE A: 'unclaimed' is searchable but NOT provider-authored", function () {
      HC.assert(searchable(STATUS.UNCLAIMED) === true, "unclaimed must appear in search");
      HC.assert(isProviderAuthored(STATUS.UNCLAIMED) === false, "unclaimed is aggregated, not authored");
      HC.assert(isClaimable(STATUS.UNCLAIMED) === true, "unclaimed must be claimable");
    });

    // CASE B: pre-registration is distinct — not in search, not authored, not claimable yet.
    check("CASE B: 'pending' pre-registration is NOT in public search and not yet claimable", function () {
      HC.assert(searchable(STATUS.PENDING) === false, "pre-registration cannot be found in a public search");
      HC.assert(isProviderAuthored(STATUS.PENDING) === false, "pending is referred, not authored");
      HC.assert(isClaimable(STATUS.PENDING) === false, "pending must be published before it can be claimed");
    });

    // CASE C: registered/active and claimed are provider-authored and in search.
    check("CASE C: 'active' (registered) and 'claimed' are provider-authored and in search", function () {
      HC.assert(isProviderAuthored(STATUS.ACTIVE) === true, "active is registered/authored");
      HC.assert(isProviderAuthored(STATUS.CLAIMED) === true, "claimed becomes authored after takeover");
      HC.assert(searchable(STATUS.ACTIVE) === true && searchable(STATUS.CLAIMED) === true, "both in search");
      HC.assert(isClaimable(STATUS.ACTIVE) === false && isClaimable(STATUS.CLAIMED) === false, "already-owned listings aren't claimable");
    });

    // CASE D: statuses are tracked DISTINCTLY from registered/active. The four
    // statuses are distinct strings; the aggregated (not-authored) states
    // partition cleanly from the registered/authored states; and 'claimed' is
    // tracked as a status distinct from 'active' even though both are authored
    // (they differ by ORIGIN: claimed-from-aggregation vs organic signup).
    check("CASE D: status is tracked distinctly from registered/active", function () {
      // (i) four genuinely distinct status values.
      var uniq = {};
      VALID_STATUSES.forEach(function (s) { uniq[s] = true; });
      HC.assert(Object.keys(uniq).length === 4, "expected 4 distinct status values");

      // (ii) aggregated/not-authored states are exactly {unclaimed, pending} and
      //      are disjoint from the authored states {claimed, active}.
      var aggregated = VALID_STATUSES.filter(function (s) { return !isProviderAuthored(s); });
      var authored = VALID_STATUSES.filter(function (s) { return isProviderAuthored(s); });
      HC.assert(aggregated.indexOf(STATUS.UNCLAIMED) !== -1 && aggregated.indexOf(STATUS.PENDING) !== -1,
        "unclaimed + pending must be the aggregated states");
      HC.assert(aggregated.indexOf(STATUS.ACTIVE) === -1 && aggregated.indexOf(STATUS.CLAIMED) === -1,
        "active/claimed must NOT be aggregated");
      HC.assert(authored.length === 2, "exactly two authored states");

      // (iii) 'claimed' is a distinct status from registered 'active'.
      HC.assert(STATUS.CLAIMED !== STATUS.ACTIVE, "claimed and active are different statuses");
      // an unclaimed listing that gets claimed becomes 'claimed', never 'active'
      // — so we can always tell a claimed-from-aggregation listing apart from an
      // organically-registered one.
      var becameAfterClaim = claim({ status: STATUS.UNCLAIMED }).status;
      HC.assert(becameAfterClaim === STATUS.CLAIMED && becameAfterClaim !== STATUS.ACTIVE,
        "claiming yields 'claimed', tracked distinctly from registered/active");
    });

    // CASE E: the live directory genuinely contains unclaimed (aggregated) listings.
    var liveListings = buildListings({});
    check("CASE E: directory model yields unclaimed listings from live camp data", function () {
      HC.assert(liveListings.length > 0, "no listings built from HC.data.providers");
      var unclaimed = liveListings.filter(function (l) { return l.status === STATUS.UNCLAIMED; });
      HC.assert(unclaimed.length > 0, "directory has no unclaimed (aggregated) listings");
      // and at least one pre-registration listing to prove the distinct hidden state
      var pending = liveListings.filter(function (l) { return l.status === STATUS.PENDING; });
      HC.assert(pending.length > 0, "directory has no pre-registration listings");
    });

    // CASE F: an unclaimed listing APPEARS IN SEARCH; a pending one does NOT.
    check("CASE F: unclaimed listings appear in search; pending listings are excluded", function () {
      var search = searchListings(liveListings);
      var anyUnclaimedInSearch = search.some(function (l) { return l.status === STATUS.UNCLAIMED; });
      var anyPendingInSearch = search.some(function (l) { return l.status === STATUS.PENDING; });
      HC.assert(anyUnclaimedInSearch === true, "an unclaimed listing must show in search results");
      HC.assert(anyPendingInSearch === false, "no pre-registration listing may show in search results");
      HC.assert(search.length < liveListings.length, "search must hide at least the pending listings");
    });

    // CASE G: claim() converts unclaimed -> claimed; it is NOW authored, STILL in search.
    check("CASE G: claiming an unclaimed listing makes it provider-authored, still searchable", function () {
      var anUnclaimed = liveListings.filter(function (l) { return l.status === STATUS.UNCLAIMED; })[0];
      HC.assert(anUnclaimed, "need an unclaimed listing to claim");
      HC.assert(anUnclaimed.providerAuthored === false, "precondition: unclaimed is not authored");
      var res = claim(anUnclaimed);
      HC.assert(res.status === STATUS.CLAIMED, "claim must yield 'claimed' status");
      HC.assert(!!res.accountId, "claiming creates a provider account");
      HC.assert(!!res.claimedAt, "claiming stamps claimedAt");
      // status now reads as authored + still searchable
      HC.assert(isProviderAuthored(res.status) === true, "claimed listing is now provider-authored");
      HC.assert(searchable(res.status) === true, "claimed listing stays in public search");
    });

    // CASE H: you cannot claim a pending listing, nor an already-authored one.
    check("CASE H: claim is rejected for pre-registration and already-authored listings", function () {
      var threwPending = false, threwActive = false;
      try { claim({ status: STATUS.PENDING }); } catch (e) { threwPending = true; }
      try { claim({ status: STATUS.ACTIVE }); } catch (e) { threwActive = true; }
      HC.assert(threwPending, "claiming a pre-registration listing must throw");
      HC.assert(threwActive, "claiming a registered listing must throw");
    });

    // CASE I: publish() moves pending -> unclaimed (now in search AND claimable).
    check("CASE I: publishing a pre-registration listing makes it an unclaimed, claimable, searchable listing", function () {
      var newStatus = publish(STATUS.PENDING);
      HC.assert(newStatus === STATUS.UNCLAIMED, "publish must yield 'unclaimed'");
      HC.assert(searchable(newStatus) === true, "published listing now appears in search");
      HC.assert(isClaimable(newStatus) === true, "published listing is now claimable");
      var threw = false;
      try { publish(STATUS.ACTIVE); } catch (e) { threw = true; }
      HC.assert(threw, "publish must reject a non-pending status");
    });

    // CASE J: end-to-end via the persisted overlay — claim, then verify the
    // directory now reports that listing as claimed/authored and still in search,
    // and the unclaimed count dropped by one. Restores state afterwards.
    check("CASE J: committed claim updates the directory and persists distinctly (then restores)", function () {
      var before = HC.store.get(STORE_KEY, {});
      try {
        var baseline = buildListings({});
        var target = baseline.filter(function (l) { return l.status === STATUS.UNCLAIMED; })[0];
        HC.assert(target, "need a claimable listing for the e2e case");
        var unclaimedBefore = tally(baseline).unclaimed;

        HC.store.set(STORE_KEY, {}); // start from clean overlay
        var res = commitClaim(target.id);
        HC.assert(res.status === STATUS.CLAIMED, "commitClaim should claim it");

        var after = buildListings(loadOverlay());
        var nowRow = after.filter(function (l) { return l.id === target.id; })[0];
        HC.assert(nowRow && nowRow.status === STATUS.CLAIMED, "directory must now show the listing as claimed");
        HC.assert(nowRow.providerAuthored === true, "claimed listing is provider-authored in the directory");
        HC.assert(nowRow.inSearch === true, "claimed listing remains visible in search");
        HC.assert(tally(after).unclaimed === unclaimedBefore - 1, "unclaimed count must drop by exactly one");

        // claiming the same listing again must now be rejected (it's authored).
        var threwAgain = false;
        try { commitClaim(target.id); } catch (e) { threwAgain = true; }
        HC.assert(threwAgain, "re-claiming an already-claimed listing must be rejected");
      } finally {
        HC.store.set(STORE_KEY, before && typeof before === "object" ? before : {});
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "platform-unclaimed-listings",
    title: "Auto-aggregated unclaimed listings",
    side: "platform",
    icon: "📍",
    summary: "The directory carries platform-aggregated listings the provider never authored (unclaimed) plus referred pre-registration camps not yet in search. Unclaimed listings appear in search and can be claimed — converting them into registered, provider-authored listings. Status is tracked distinctly.",
    render: render,
    selfTest: selfTest
  });
})();
