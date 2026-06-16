/* HolidayCamp feature — provider-help-centre
 *
 * Provider help centre / how-to guides  (provider side)
 *
 * Replicates Happity's provider-facing help centre, which is split across three
 * "how-to" collections plus a troubleshooting FAQ:
 *   - How-to guides: basics              (collection 1402726)
 *       Setting up bookings, ticket/capacity, activate/deactivate bookings,
 *       custom confirmation emails, using Happity as your main / alongside
 *       another booking system.
 *   - How-to guide: advanced             (collection 2584155)
 *       Manual bookings, sharing a register, photo/video consent, discount
 *       codes, embedding the bookings widget.
 *   - Membership features & benefits     (collection 2990590)
 *       Marketing platform, donations / pay-what-you-want, Followers for
 *       zero-effort email marketing, Venue finder, logo & banner, referrals,
 *       "top 5 tips to keep getting found".
 *   - FAQs / troubleshooting             (collection 2959913)
 *       "When will I receive my money from Stripe?", "I have not received my
 *       login details yet", hide phone number, "Why am I being asked to verify
 *       my classes?", booking cut-off, etc.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): the guides are about
 * listing a holiday-camp week, taking camp bookings, marketing a camp to local
 * Waltham Forest families, and the common problems a camp organiser hits.
 * Answers are grounded in the LIVE HolidayCamp directory (HC.data.providers /
 * HC.data.planner) and cross-link to the sibling provider feature modules that
 * are already built (price wizard, discount codes, followers, refund, etc.).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   "A searchable help section covers setup, bookings, marketing and
 *    troubleshooting." We assert there is a help category for EACH of those
 *    four topics, each holding real answered how-to guides, AND that the search
 *    can surface a guide in each of those four topics.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-help-centre: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // localStorage (namespaced) keys.
  var STORE_STATE = "provider_help_state";       // { votes:{ gid:'up'|'down' }, tickets:{ gid:true }, lastTopic }
  var STORE_TOPIC = "provider_help_last_topic";  // remember which topic tab was open

  // The four canonical topics from the acceptance criterion.
  var REQUIRED_TOPICS = ["setup", "bookings", "marketing", "troubleshooting"];

  /* ================================================================
     Live-data helpers (read HC.data defensively).
     ================================================================ */

  function safeProviders() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }
  function safePlanner() {
    try { return HC.data.planner || {}; } catch (e) { return {}; }
  }
  function providerCount() {
    var ps = safeProviders();
    return Array.isArray(ps) ? ps.length : 0;
  }

  // Count providers that already take bookings in-platform (a "bookings" stat).
  function bookableCount() {
    var ps = safeProviders();
    var n = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i] || {};
      var booking = String(p.booking || "").toLowerCase();
      // treat anything mentioning "book" / "open" as bookable; conservative.
      if (booking && (booking.indexOf("book") >= 0 || booking.indexOf("open") >= 0)) n += 1;
    }
    return n;
  }

  // Count distinct venues across the directory (a "venue finder" marketing stat).
  function venueCount() {
    var ps = safeProviders();
    var seen = {};
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i] || {};
      var v = String(p.venue || p.area || p.location || "").trim().toLowerCase();
      if (v) seen[v] = true;
    }
    return Object.keys(seen).length;
  }

  // A live count of summer weeks the planner knows about (setup / scheduling).
  function summerWeeksCount() {
    var pl = safePlanner();
    var weeks = (pl && Array.isArray(pl.weeks)) ? pl.weeks : [];
    return weeks.filter(function (w) { return w && !w.stub; }).length;
  }

  /* ================================================================
     The help-centre content model.

     The acceptance criterion is ENCODED here: exactly one category per
     required topic (setup / bookings / marketing / troubleshooting),
     each carrying real answered how-to guides.

     Each category: { id, topic, title, icon, intro, items:[ guide ] }
     Each guide:    { gid, q, a, steps?:[String], links?:[{id,label}] }
     ================================================================ */

  function buildCategories() {
    var nCamps = providerCount();
    var nVenues = venueCount();
    var nWeeks = summerWeeksCount();

    return [
      {
        id: "help-setup",
        topic: "setup",
        title: "Setup & getting started",
        icon: "🚀",
        intro: "List your holiday camp and switch bookings on. Equivalent to Happity's " +
          "\"How-to guides: basics\" — first listing, tickets, capacity and confirmation emails.",
        items: [
          {
            gid: "setup-first-camp",
            q: "How do I list my first holiday camp?",
            a: "Create your organiser profile, then add a camp listing with its dates, age range, venue and what a typical day looks like. " +
               "Across Waltham Forest there are already " + nCamps + " camp providers listed, so a clear, specific listing helps yours stand out. " +
               "Once saved, your camp appears in the Find directory and on your own page.",
            steps: [
              "Add your organiser name, logo and a short description.",
              "Create a camp and set its age range (e.g. 5–11) and venue.",
              "Add the camp week(s) — there are " + (nWeeks || "several") + " summer weeks in the planner this year.",
              "Save and preview your listing in the directory."
            ],
            links: [
              { id: "provider-venue-create", label: "Create a venue" },
              { id: "provider-edit-camp", label: "Edit camp details" }
            ]
          },
          {
            gid: "setup-tickets",
            q: "How do I set up tickets, prices and capacity?",
            a: "Each camp week is sold as tickets. Set a price per child (single day, full week, or a term/multi-week block), then cap how many " +
               "places are available so the week closes automatically when it sells out. Use the price wizard to build day, week and sibling tickets in one pass.",
            steps: [
              "Open your camp and choose 'Tickets & prices'.",
              "Add a ticket type (single day / full week / multi-week block).",
              "Set the price per child and the capacity for that week.",
              "Add a sibling or early-bird ticket if you offer one."
            ],
            links: [
              { id: "provider-price-wizard", label: "Price wizard" },
              { id: "provider-capacity", label: "Set capacity" },
              { id: "provider-ticket-term", label: "Weekly & term tickets" }
            ]
          },
          {
            gid: "setup-activate",
            q: "How do I switch bookings on (or off)?",
            a: "Bookings are off until you activate them, so you can build a listing in private first. When the camp is ready, activate bookings " +
               "and parents can pay online; deactivate any week that's full or paused without deleting the listing.",
            steps: [
              "Finish your tickets, prices and capacity.",
              "Toggle 'Activate bookings' on the camp.",
              "Check the listing shows a 'Book now' button in the directory.",
              "Deactivate a week later if you need to pause it."
            ],
            links: [
              { id: "provider-activate-bookings", label: "Activate / deactivate bookings" },
              { id: "provider-stripe-connect", label: "Connect Stripe for payouts" }
            ]
          },
          {
            gid: "setup-confirmation",
            q: "How do I set a custom booking-confirmation email?",
            a: "Every camp booking sends parents an automatic confirmation. Add your own message — what to bring, drop-off and pick-up times, " +
               "kit, lunch arrangements and your contact details — so families arrive on day one fully prepared.",
            steps: [
              "Open 'Confirmation emails' for the camp.",
              "Write your welcome message and joining instructions.",
              "Add drop-off/pick-up times and what to bring.",
              "Save — it sends automatically on every new booking."
            ],
            links: [
              { id: "provider-custom-confirmation", label: "Custom confirmation emails" }
            ]
          }
        ]
      },
      {
        id: "help-bookings",
        topic: "bookings",
        title: "Taking & managing bookings",
        icon: "🎟️",
        intro: "Run the booking side of your camp. Equivalent to Happity's advanced how-to guides — " +
          "manual bookings, registers, discount codes, embedding a widget, refunds and rescheduling.",
        items: [
          {
            gid: "book-manual",
            q: "How do I add a manual booking to my register?",
            a: "If a parent pays you directly (cash, bank transfer, a school referral or a HAF place), add them as a manual booking so they appear " +
               "on the camp register alongside online bookings and your numbers stay correct.",
            steps: [
              "Open the camp week's register.",
              "Choose 'Add booking' and enter the child's details.",
              "Mark it paid / unpaid as appropriate.",
              "The child now appears on the printed register."
            ],
            links: [
              { id: "provider-manual-booking", label: "Add a manual booking" },
              { id: "provider-registers", label: "Camp registers" },
              { id: "provider-print-register", label: "Print a register" }
            ]
          },
          {
            gid: "book-discount",
            q: "How do I create discount or sibling codes?",
            a: "Set up codes for early birds, siblings or returning families. Choose a percentage or fixed amount, an optional usage limit and an " +
               "expiry. Parents enter the code at checkout and the camp total recalculates before they pay.",
            steps: [
              "Open 'Discount codes' for your camp.",
              "Create a code (percentage or fixed amount).",
              "Set a usage limit and expiry if you want one.",
              "Share the code with your families."
            ],
            links: [
              { id: "provider-discount-codes", label: "Discount codes" }
            ]
          },
          {
            gid: "book-questions",
            q: "Can I ask parents booking questions (allergies, needs, consent)?",
            a: "Yes. Add custom questions to the camp's booking flow — dietary needs and allergies, medical or SEND notes, an emergency contact, " +
               "and photo/video consent — so you have everything you need before day one. Answers show on the register.",
            steps: [
              "Open 'Booking questions' for the camp.",
              "Add questions (allergies, needs, emergency contact).",
              "Add a photo/video consent question.",
              "Answers appear against each child on the register."
            ],
            links: [
              { id: "provider-booking-questions-note", label: "Booking questions" },
              { id: "provider-photo-consent-register", label: "Photo consent on the register" }
            ]
          },
          {
            gid: "book-widget",
            q: "How do I embed bookings on my own website?",
            a: "Of the " + nCamps + " camp providers listed, many also have their own site. Copy the bookings widget code and paste it into your " +
               "website so families can book your camp without leaving your page, while you still manage everything in one place.",
            steps: [
              "Open 'Booking widget' for your organiser.",
              "Copy the embed snippet.",
              "Paste it into your own website's page.",
              "Test a booking flows through to your register."
            ],
            links: [
              { id: "provider-booking-widget", label: "Embed the bookings widget" }
            ]
          },
          {
            gid: "book-refund",
            q: "How do I issue a refund or reschedule a child?",
            a: "Open the booking and issue a full or partial refund under your own cancellation policy; the parent is notified automatically. To move " +
               "a child to a different week, reschedule or transfer the booking instead of refunding and rebooking.",
            steps: [
              "Find the booking on the register.",
              "Choose 'Refund' (full or partial) or 'Reschedule'.",
              "Confirm — the parent is emailed automatically.",
              "Your numbers and payout update accordingly."
            ],
            links: [
              { id: "provider-refund", label: "Issue a refund" },
              { id: "provider-reschedule", label: "Reschedule a booking" },
              { id: "provider-transfer-customer", label: "Transfer to another week" }
            ]
          },
          {
            gid: "book-breakdown",
            q: "Where do I see a breakdown of my camp bookings?",
            a: "Your bookings breakdown shows how each camp week is selling — places booked, places left and revenue — so you can spot a week that " +
               "needs a marketing push or one that's about to sell out and may need a waiting list.",
            steps: [
              "Open the bookings breakdown / insights.",
              "Review places sold vs capacity per week.",
              "Spot quiet weeks to market and full weeks to grow.",
              "Open a waiting list on sold-out weeks."
            ],
            links: [
              { id: "provider-bookings-breakdown", label: "Bookings breakdown" },
              { id: "provider-insights", label: "Insights" }
            ]
          }
        ]
      },
      {
        id: "help-marketing",
        topic: "marketing",
        title: "Marketing & growing your camp",
        icon: "📣",
        intro: "Get found and fill your weeks. Equivalent to Happity's \"Membership features & benefits\" — " +
          "followers, donations, referrals, venue finder, logo/banner and the top tips to keep getting found.",
        items: [
          {
            gid: "mkt-found",
            q: "How do I get found by local families?",
            a: "Complete your profile, add real photos, tag your camp with the right categories and keep your dates current — listings with full " +
               "details and photos rank higher in the Find directory and get clicked more. A clear age range and venue help parents searching this borough.",
            steps: [
              "Add a logo, banner and real camp photos.",
              "Tag the camp's categories (sports, arts, SEND-friendly, HAF…).",
              "Keep dates, prices and capacity up to date.",
              "Write a specific, parent-friendly description."
            ],
            links: [
              { id: "provider-logo-banner", label: "Add a logo & banner" },
              { id: "provider-categories", label: "Tag categories" },
              { id: "provider-profile-content", label: "Profile content" }
            ]
          },
          {
            gid: "mkt-followers",
            q: "How do I use Followers for zero-effort email marketing?",
            a: "Parents can follow your camp from your listing. Whenever you publish new holiday-camp dates, your followers are emailed automatically — " +
               "so a half-term or summer release markets itself to families who already chose you. Export your followers to see your reach.",
            steps: [
              "Encourage parents to 'Follow' your camp.",
              "Publish new half-term / summer dates.",
              "Followers are emailed automatically.",
              "Export your follower list to track growth."
            ],
            links: [
              { id: "provider-followers", label: "Followers" },
              { id: "provider-contact-customers", label: "Contact customers" },
              { id: "provider-followers-export", label: "Export followers" }
            ]
          },
          {
            gid: "mkt-venue-finder",
            q: "How do I use the venue finder to expand?",
            a: "Running across " + (nVenues || "several") + " venues already? The venue finder helps you discover new spaces — halls, schools and " +
               "centres in Waltham Forest — so you can add a camp in a new area and reach families you can't reach today.",
            steps: [
              "Open the venue finder.",
              "Search for halls / schools near a target area.",
              "Add a new venue to your organiser.",
              "List a camp there to reach a new neighbourhood."
            ],
            links: [
              { id: "provider-venue-finder", label: "Venue finder" },
              { id: "provider-multi-venue", label: "Run multiple venues" }
            ]
          },
          {
            gid: "mkt-donations",
            q: "Can I offer donations / pay-what-you-want places?",
            a: "Yes — useful for community or charity camps. Offer a pay-what-you-want or suggested-donation place so families on a budget can still " +
               "come, while others contribute more. Great for HAF-adjacent or subsidised holiday provision.",
            steps: [
              "Open 'Donations / pay-what-you-want'.",
              "Set a suggested amount (or leave it open).",
              "Add it as a ticket on the camp week.",
              "Parents choose what they can pay at checkout."
            ],
            links: [
              { id: "provider-donations-setup", label: "Donations setup" }
            ]
          },
          {
            gid: "mkt-referrals",
            q: "How do referrals work (give £10, get £10)?",
            a: "Refer another camp organiser you know and you both get credit when they join. It's a simple way to bring more local activities onto " +
               "the platform and earn toward your own featured listings or membership.",
            steps: [
              "Open the referrals page and copy your link.",
              "Share it with another activity provider.",
              "They join using your link.",
              "You both receive credit."
            ],
            links: [
              { id: "provider-referrals", label: "Referrals" }
            ]
          }
        ]
      },
      {
        id: "help-troubleshooting",
        topic: "troubleshooting",
        title: "Troubleshooting & FAQs",
        icon: "🛠️",
        intro: "Fix the common problems. Equivalent to Happity's FAQ collection — payouts, login, " +
          "hiding your phone number, class verification and booking cut-offs.",
        items: [
          {
            gid: "trouble-payout",
            q: "When will I receive my money from Stripe?",
            a: "Camp payments are taken by Stripe and paid into your bank on a rolling schedule (typically a few working days after each booking), " +
               "minus fees. If a payout looks missing, check your Stripe account is fully connected and verified — an unverified Stripe account holds funds.",
            steps: [
              "Open 'Payments' and confirm Stripe is connected.",
              "Check Stripe shows your account as verified.",
              "Review the payout schedule in Stripe.",
              "Contact support if a verified payout is overdue."
            ],
            links: [
              { id: "provider-stripe-connect", label: "Connect / fix Stripe" }
            ]
          },
          {
            gid: "trouble-login",
            q: "I haven't received my login details / can't log in",
            a: "New accounts get login details by email, which can take a few minutes or land in spam. Make sure you're using the email you signed up " +
               "with, check spam/promotions, and request a password reset. If it still fails, your account may need verifying first.",
            steps: [
              "Check spam / promotions for the welcome email.",
              "Confirm you're using the sign-up email address.",
              "Request a password reset.",
              "Contact support if your account isn't activated."
            ],
            links: [
              { id: "provider-extra-users", label: "Add or fix users" }
            ]
          },
          {
            gid: "trouble-phone",
            q: "My phone number is showing publicly — how do I hide it?",
            a: "By default a contact number can appear on your public camp page. If you'd rather parents contact you another way, switch your phone " +
               "number to hidden in your profile and offer enquiries or email instead.",
            steps: [
              "Open your organiser profile / company details.",
              "Find the phone-number visibility setting.",
              "Set the number to hidden.",
              "Save and check your public page."
            ],
            links: [
              { id: "provider-hide-phone", label: "Hide your phone number" },
              { id: "provider-company-details", label: "Company details" }
            ]
          },
          {
            gid: "trouble-verify",
            q: "Why am I being asked to verify my camp / classes?",
            a: "Verification keeps the directory trustworthy for families — it confirms a real, safe holiday-camp provider is behind the listing. " +
               "Complete the verification steps (and any safeguarding / venue checks) so your camp can take live bookings.",
            steps: [
              "Open the verification prompt on your account.",
              "Provide the requested details / documents.",
              "Confirm your venue and safeguarding info.",
              "Submit — bookings unlock once verified."
            ],
            links: [
              { id: "provider-verification", label: "Verify your account" },
              { id: "provider-verify-classes", label: "Verify camps" }
            ]
          },
          {
            gid: "trouble-cutoff",
            q: "When is the cut-off for booking my camp?",
            a: "You control how late parents can book each camp week — right up to the start, or a set number of hours/days before, so you can finalise " +
               "registers and staffing. Set the cut-off per week; after it, the week stops accepting new bookings automatically.",
            steps: [
              "Open the camp week's settings.",
              "Set the booking cut-off (hours/days before start).",
              "Save — late bookings close automatically.",
              "Open a waiting list if you still get demand."
            ],
            links: [
              { id: "provider-cutoff", label: "Booking cut-off" }
            ]
          },
          {
            gid: "trouble-cancel",
            q: "How do I cancel or hide a camp week that isn't running?",
            a: "If a week falls through, cancel or hide it rather than leaving a dead listing. Cancelling notifies anyone booked (and lets you refund); " +
               "hiding takes it off the directory while you decide. Your other weeks stay live.",
            steps: [
              "Open the camp week you need to stop.",
              "Choose 'Cancel' (notifies + refunds) or 'Hide'.",
              "Confirm the action.",
              "Your remaining weeks stay bookable."
            ],
            links: [
              { id: "provider-cancel-class", label: "Cancel a camp week" },
              { id: "provider-hidden-mode", label: "Hide a listing" }
            ]
          }
        ]
      }
    ];
  }

  /* ================================================================
     Pure, testable logic (DOM-free) — search, topic coverage, votes,
     "raise a ticket" support requests.
     ================================================================ */

  // Flatten categories to a searchable list of guides (each tagged with topic).
  function allGuides(categories) {
    var out = [];
    (categories || []).forEach(function (c) {
      (c.items || []).forEach(function (it) {
        out.push({
          topic: c.topic,
          categoryId: c.id,
          categoryTitle: c.title,
          gid: it.gid,
          q: it.q,
          a: it.a,
          steps: it.steps || [],
          links: it.links || []
        });
      });
    });
    return out;
  }

  // Case-insensitive AND-match search across question + answer + steps text.
  function searchHelp(categories, query) {
    var guides = allGuides(categories);
    var q = String(query == null ? "" : query).trim().toLowerCase();
    if (!q) return guides;
    var terms = q.split(/\s+/).filter(Boolean);
    return guides.filter(function (g) {
      var hay = (g.q + " " + g.a + " " + (g.steps || []).join(" ") + " " + g.categoryTitle).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
  }

  // Which required topics actually have >=1 answered guide. Returns { topic: count }.
  function coveredTopics(categories) {
    var seen = {};
    (categories || []).forEach(function (c) {
      var answered = (c.items || []).filter(function (it) {
        return it && it.q && it.a && String(it.a).trim().length > 0;
      });
      if (answered.length > 0 && c.topic) seen[c.topic] = (seen[c.topic] || 0) + answered.length;
    });
    return seen;
  }

  // True only if every required topic has at least one answered guide.
  function coversAllRequiredTopics(categories) {
    var seen = coveredTopics(categories);
    return REQUIRED_TOPICS.every(function (t) { return (seen[t] || 0) > 0; });
  }

  /* ---- provider help state (votes + raised support tickets), HC.store only ---- */

  function loadState() {
    var raw;
    try { raw = HC.store.get(STORE_STATE, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object") raw = {};
    if (!raw.votes || typeof raw.votes !== "object") raw.votes = {};
    if (!Array.isArray(raw.tickets)) raw.tickets = [];
    return raw;
  }
  function saveState(st) {
    try { HC.store.set(STORE_STATE, st); return true; } catch (e) { return false; }
  }

  // Record a "did this guide help?" vote against a guide id.
  function recordVote(st, gid, value) {
    var next = cloneJson(st);
    if (!next.votes) next.votes = {};
    if (value === "up" || value === "down") next.votes[gid] = value;
    else delete next.votes[gid];
    return next;
  }

  // Raise a support ticket ("Still stuck? Contact us"). Validates a message.
  // Returns { state, ticket, error }.
  function raiseTicket(st, payload) {
    var next = cloneJson(st);
    if (!Array.isArray(next.tickets)) next.tickets = [];
    payload = payload || {};
    var message = String(payload.message == null ? "" : payload.message).trim();
    if (!message) return { state: next, ticket: null, error: "Please describe the problem" };
    var topic = REQUIRED_TOPICS.indexOf(payload.topic) >= 0 ? payload.topic : "troubleshooting";
    var ticket = {
      id: safeUid(),
      topic: topic,
      gid: String(payload.gid || "").trim(),
      message: message,
      at: nowIso()
    };
    next.tickets.push(ticket);
    return { state: next, ticket: ticket, error: null };
  }

  function cloneJson(o) {
    try { return JSON.parse(JSON.stringify(o || {})); } catch (e) { return {}; }
  }
  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  /* ================================================================
     UI
     ================================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }

  // Map a feature id -> its registered title (for cross-link labels), defensive.
  function featureTitle(id) {
    try {
      var f = (HC.features || []).filter(function (x) { return x && x.id === id; })[0];
      return f ? (f.icon ? f.icon + " " + f.title : f.title) : null;
    } catch (e) { return null; }
  }

  function render(mountEl) {
    if (!mountEl) return;
    var categories = buildCategories();
    var st = loadState();

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Your provider how-to centre. Search a question or pick a topic — every guide has step-by-step " +
      "instructions. Covers setting up your camp, taking bookings, marketing to local families, and " +
      "troubleshooting the common problems."));

    // ---- search box ----
    var search = HC.util.el("input", {
      type: "search", placeholder: "Search how-to guides (e.g. discount code, Stripe payout, followers)…",
      style: "width:100%;max-width:460px;padding:10px 13px;border:1.5px solid var(--line,#E6E6E6);" +
        "border-radius:12px;font-size:14px;box-sizing:border-box;margin:0 0 16px"
    });
    wrap.appendChild(search);

    // ---- topic tabs ----
    var tabRow = HC.util.el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px" });
    wrap.appendChild(tabRow);

    var panel = HC.util.el("div", {});
    wrap.appendChild(panel);

    mountEl.appendChild(wrap);

    var openId = null;
    try { openId = HC.store.get(STORE_TOPIC, null); } catch (e) { openId = null; }
    if (!categories.some(function (c) { return c.id === openId; })) {
      openId = categories[0] && categories[0].id;
    }

    function tabButton(cat, active) {
      var b = HC.util.el("button", {
        type: "button",
        class: "hc-btn " + (active ? "" : "hc-btn-ghost"),
        "data-cat": cat.id
      }, esc(cat.icon + " " + cat.title));
      b.addEventListener("click", function () {
        openId = cat.id;
        try { HC.store.set(STORE_TOPIC, openId); } catch (e) {}
        search.value = "";
        paint();
      });
      return b;
    }

    function renderGuide(guide, voteState) {
      var gid = guide.gid, q = guide.q, a = guide.a;
      var det = HC.util.el("details", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:0;margin:0 0 10px;background:#fff;overflow:hidden"
      });
      var sum = HC.util.el("summary", {
        style: "cursor:pointer;list-style:none;padding:13px 16px;font-family:'Quicksand',system-ui,sans-serif;" +
          "font-weight:700;color:var(--purple,#603488);font-size:15px"
      }, esc(q));
      det.appendChild(sum);

      var body = HC.util.el("div", { style: "padding:0 16px 14px" });
      body.appendChild(HC.util.el("p", { style: "font-size:13.5px;line-height:1.6;margin:0 0 10px" }, esc(a)));

      // numbered steps
      var steps = guide.steps || [];
      if (steps.length) {
        var ol = HC.util.el("ol", {
          style: "margin:0 0 10px;padding-left:20px;font-size:13px;line-height:1.7;color:var(--text,#383838)"
        });
        steps.forEach(function (s) { ol.appendChild(HC.util.el("li", null, esc(s))); });
        body.appendChild(ol);
      }

      // cross-links to sibling provider features
      var links = (guide.links || []).map(function (l) {
        var label = featureTitle(l.id) || l.label || l.id;
        return '<button type="button" class="hc-btn hc-btn-ghost" data-help-link="' + attr(l.id) +
          '" style="font-size:11.5px;padding:6px 11px">' + esc(label) + "</button>";
      });
      if (links.length) {
        body.appendChild(HC.util.el("div",
          { style: "display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px" }, links.join("")));
      }

      // "did this help?" votes
      var voteRow = HC.util.el("div", {
        style: "display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--muted,#808080)"
      });
      voteRow.appendChild(HC.util.el("span", null, "Did this guide help?"));
      var current = (voteState && voteState[gid]) || null;
      var up = HC.util.el("button", {
        type: "button", class: "hc-btn hc-btn-ghost",
        style: "font-size:11.5px;padding:5px 10px" + (current === "up" ? ";background:var(--purple-tint,#F0E8F4)" : "")
      }, current === "up" ? "👍 Thanks" : "👍 Yes");
      var down = HC.util.el("button", {
        type: "button", class: "hc-btn hc-btn-ghost",
        style: "font-size:11.5px;padding:5px 10px" + (current === "down" ? ";background:var(--pink-tint,#FCE8F0)" : "")
      }, "👎 No");
      up.addEventListener("click", function () {
        st = recordVote(st, gid, current === "up" ? null : "up");
        saveState(st);
        try { HC.util.toast("Thanks for the feedback"); } catch (e) {}
        paint();
      });
      down.addEventListener("click", function () {
        st = recordVote(st, gid, current === "down" ? null : "down");
        saveState(st);
        try { HC.util.toast("Thanks — raise a ticket below if you're still stuck"); } catch (e) {}
        paint();
      });
      voteRow.appendChild(up);
      voteRow.appendChild(down);
      body.appendChild(voteRow);

      det.appendChild(body);
      return det;
    }

    // "Still stuck? Contact us" — raises a support ticket (Happity's Contact us).
    function buildContactBox(topic) {
      var box = HC.util.el("div", {
        style: "border:1.5px dashed var(--purple-tint,#D9C7E6);border-radius:12px;padding:12px 14px;margin:16px 0 0;background:#FBF8FD"
      });
      box.appendChild(HC.util.el("div", {
        style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:12px;color:var(--magenta,#F82488);" +
          "text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px"
      }, "Still stuck? Contact us"));

      var msgIn = HC.util.el("textarea", {
        placeholder: "Describe what you're trying to do and where you're stuck…",
        rows: "2",
        style: "width:100%;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px;box-sizing:border-box;margin:0 0 8px;resize:vertical"
      });
      box.appendChild(msgIn);

      var sendBtn = HC.util.el("button", { type: "button", class: "hc-btn", style: "font-size:12px" }, "Raise a support ticket");
      sendBtn.addEventListener("click", function () {
        var res = raiseTicket(st, { topic: topic, message: msgIn.value });
        if (res.error) {
          try { HC.util.toast(res.error); } catch (e) {}
          msgIn.focus();
          return;
        }
        st = res.state;
        saveState(st);
        try { HC.util.toast("Ticket raised (ref " + res.ticket.id.slice(-6) + ") — we'll be in touch"); } catch (e) {}
        paint();
      });
      box.appendChild(sendBtn);

      var count = (st.tickets || []).length;
      if (count) {
        box.appendChild(HC.util.el("div", { style: "font-size:11.5px;color:var(--muted,#808080);margin-top:8px" },
          count + " support ticket" + (count === 1 ? "" : "s") + " raised from this browser."));
      }
      return box;
    }

    function paint() {
      // tabs
      tabRow.innerHTML = "";
      categories.forEach(function (c) {
        tabRow.appendChild(tabButton(c, c.id === openId && !search.value));
      });

      panel.innerHTML = "";
      var query = (search.value || "").trim();

      if (query) {
        var hits = searchHelp(categories, query);
        panel.appendChild(HC.util.el("div", {
          style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);" +
            "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 10px"
        }, hits.length + " guide" + (hits.length === 1 ? "" : "s") + ' for "' + esc(query) + '"'));
        if (!hits.length) {
          panel.appendChild(HC.util.el("p", { style: "font-size:13.5px;color:var(--muted,#808080)" },
            "No how-to guides matched. Try fewer or different words — or browse the topics above."));
          panel.appendChild(buildContactBox("troubleshooting"));
          return;
        }
        hits.forEach(function (h) {
          var cat = categories.filter(function (c) { return c.id === h.categoryId; })[0];
          panel.appendChild(HC.util.el("div", { style: "font-size:11px;color:var(--muted,#808080);margin:0 0 2px" },
            (cat ? cat.icon + " " + cat.title : "")));
          panel.appendChild(renderGuide(h, st.votes));
        });
        return;
      }

      var open = categories.filter(function (c) { return c.id === openId; })[0] || categories[0];
      if (!open) {
        panel.appendChild(HC.util.el("p", { style: "color:var(--muted,#808080)" }, "No help topics available."));
        return;
      }
      panel.appendChild(HC.util.el("p", {
        style: "font-size:13px;color:var(--muted,#808080);margin:0 0 12px"
      }, esc(open.intro)));
      (open.items || []).forEach(function (it) {
        panel.appendChild(renderGuide(it, st.votes));
      });
      panel.appendChild(buildContactBox(open.topic));
    }

    search.addEventListener("input", paint);

    // cross-link clicks: open the named sibling feature via the hub's mechanism.
    panel.addEventListener("click", function (e) {
      var lk = e.target && e.target.closest ? e.target.closest("[data-help-link]") : null;
      if (!lk) return;
      e.preventDefault();
      var id = lk.getAttribute("data-help-link");
      try {
        var proxy = document.createElement("button");
        proxy.setAttribute("data-hc-open", id);
        proxy.style.display = "none";
        document.body.appendChild(proxy);
        proxy.click();
        document.body.removeChild(proxy);
      } catch (err) {
        try { HC.util.toast("Open the " + id + " feature from the Features hub"); } catch (e2) {}
      }
    });

    paint();
  }

  /* ================================================================
     selfTest — exercises the LOGIC and asserts the acceptance criterion.
     ================================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var cats = buildCategories();

    /* ---- THE ACCEPTANCE CRITERION ----
       "A searchable help section covers setup, bookings, marketing and
        troubleshooting." Assert a category for each topic, each with answered
        guides, AND that search surfaces a guide in each topic. */
    check("Help centre covers all four required topics (setup/bookings/marketing/troubleshooting)", function () {
      HC.assert(coversAllRequiredTopics(cats),
        "every required topic must have at least one answered how-to guide");
      var seen = coveredTopics(cats);
      REQUIRED_TOPICS.forEach(function (t) {
        HC.assert((seen[t] || 0) > 0, "topic '" + t + "' has no answered guides");
      });
    });

    // Each required topic individually — explicit per-topic assertions.
    REQUIRED_TOPICS.forEach(function (topic) {
      check("Topic '" + topic + "' has a category with answered how-to guides", function () {
        var cat = cats.filter(function (c) { return c.topic === topic; })[0];
        HC.assert(cat, "a category exists for topic '" + topic + "'");
        HC.assert(cat.title && cat.title.length, "the '" + topic + "' category has a title");
        var answered = (cat.items || []).filter(function (it) {
          return it.q && String(it.q).trim() && it.a && String(it.a).trim();
        });
        HC.assert(answered.length >= 1,
          "topic '" + topic + "' needs at least one answered guide, found " + answered.length);
      });
    });

    // Exactly one category per required topic (no missing, no accidental dupes).
    check("Exactly one category per required topic", function () {
      REQUIRED_TOPICS.forEach(function (t) {
        var n = cats.filter(function (c) { return c.topic === t; }).length;
        HC.assert(n === 1, "expected one category for '" + t + "', found " + n);
      });
    });

    // Every guide across the whole centre is genuinely answered + has steps.
    check("Every guide has a non-empty answer and step-by-step instructions", function () {
      var guides = allGuides(cats);
      HC.assert(guides.length >= 15, "expected a substantial guide set, got " + guides.length);
      guides.forEach(function (g) {
        HC.assert(g.q && g.q.length > 3, "a guide is missing its question: " + g.gid);
        HC.assert(g.a && g.a.length > 10, "answer too short / empty for: " + g.gid);
        HC.assert(Array.isArray(g.steps) && g.steps.length >= 2,
          "guide '" + g.gid + "' should have step-by-step instructions");
      });
    });

    // Search surfaces a guide in EACH required topic — proves the section is
    // genuinely SEARCHABLE and covers each topic (the acceptance criterion).
    check("Search surfaces a guide in each required topic", function () {
      var probes = {
        setup: "list my first camp",
        bookings: "discount code",
        marketing: "followers email marketing",
        troubleshooting: "stripe payout money"
      };
      Object.keys(probes).forEach(function (topic) {
        var hits = searchHelp(cats, probes[topic]);
        HC.assert(hits.length > 0, "search '" + probes[topic] + "' returned nothing for topic " + topic);
        var inTopic = hits.some(function (h) { return h.topic === topic; });
        HC.assert(inTopic, "search '" + probes[topic] + "' did not surface a '" + topic + "' guide");
      });
    });

    // Search: empty query returns the full set; AND-matching narrows it; nonsense matches nothing.
    check("Search returns all on empty query, narrows on terms, empty on nonsense", function () {
      var all = searchHelp(cats, "");
      HC.assert(all.length === allGuides(cats).length, "empty query should return everything");
      var narrowed = searchHelp(cats, "stripe payout");
      HC.assert(narrowed.length >= 1, "expected a Stripe payout result");
      HC.assert(narrowed.length < all.length, "a specific query should narrow the set");
      var none = searchHelp(cats, "zzgibberishzz");
      HC.assert(none.length === 0, "nonsense query should match nothing, got " + none.length);
    });

    // Search matches step text too, not just question/answer.
    check("Search matches text inside the step-by-step instructions", function () {
      // "capacity" appears in a setup step; "register" appears in booking steps.
      var capacity = searchHelp(cats, "capacity");
      HC.assert(capacity.length >= 1, "expected a 'capacity' guide via step text");
      var register = searchHelp(cats, "register");
      HC.assert(register.length >= 1, "expected a 'register' guide via step text");
    });

    // Search is case-insensitive.
    check("Search is case-insensitive", function () {
      var lower = searchHelp(cats, "stripe").length;
      var upper = searchHelp(cats, "STRIPE").length;
      HC.assert(lower > 0 && lower === upper, "case should not change result count (" + lower + " vs " + upper + ")");
    });

    // "Did this guide help?" votes record, change and clear.
    check("Helpful votes record, change and clear", function () {
      var st = blankState();
      st = recordVote(st, "setup-first-camp", "up");
      HC.assert(st.votes["setup-first-camp"] === "up", "an up-vote is recorded");
      st = recordVote(st, "setup-first-camp", "down");
      HC.assert(st.votes["setup-first-camp"] === "down", "a vote can be changed");
      st = recordVote(st, "setup-first-camp", null);
      HC.assert(!st.votes["setup-first-camp"], "a vote can be cleared");
      st = recordVote(st, "setup-first-camp", "sideways");
      HC.assert(!st.votes["setup-first-camp"], "an invalid vote value is ignored");
    });

    // Raising a support ticket ("Contact us") works and validates an empty message.
    check("Raising a support ticket works and validates", function () {
      var st = blankState();
      var bad = raiseTicket(st, { topic: "bookings", message: "   " });
      HC.assert(bad.ticket === null, "an empty message must be rejected");
      HC.assert(bad.error, "rejection carries an error message");
      var res = raiseTicket(st, { topic: "bookings", gid: "book-refund", message: "Refund button greyed out" });
      HC.assert(res.ticket, "a valid ticket is raised");
      HC.assert(res.ticket.topic === "bookings", "ticket topic captured");
      HC.assert(res.ticket.gid === "book-refund", "the guide id is captured");
      HC.assert(res.state.tickets.length === 1, "ticket appended to the list");
      var second = raiseTicket(res.state, { topic: "weird-topic", message: "Generic help please" });
      HC.assert(second.ticket.topic === "troubleshooting", "unknown topic defaults to troubleshooting");
      HC.assert(second.state.tickets.length === 2, "second ticket appended");
    });

    // Cross-links point at real provider-side feature ids (and resolve when the
    // registry is populated — proving the help centre wires to real features).
    check("Help cross-links reference real provider feature ids", function () {
      var ids = {};
      cats.forEach(function (c) {
        (c.items || []).forEach(function (it) {
          (it.links || []).forEach(function (l) { ids[l.id] = true; });
        });
      });
      var linked = Object.keys(ids);
      HC.assert(linked.length >= 8, "help should cross-link to many features, got " + linked.length);
      linked.forEach(function (id) {
        HC.assert(/^provider-/.test(id), "cross-link id should be a provider feature: " + id);
      });
      var registry = {};
      try { (HC.features || []).forEach(function (f) { if (f) registry[f.id] = true; }); } catch (e) {}
      if (Object.keys(registry).length > 1) {
        var missing = linked.filter(function (id) { return !registry[id]; });
        HC.assert(missing.length === 0,
          "cross-linked features not registered: " + missing.join(", "));
      }
    });

    // Answers are grounded in LIVE data where it helps (the directory count).
    check("Guides are grounded in live directory data", function () {
      var nCamps = providerCount();
      var setupCat = cats.filter(function (c) { return c.topic === "setup"; })[0];
      var firstItem = (setupCat.items || []).filter(function (i) { return i.gid === "setup-first-camp"; })[0];
      HC.assert(firstItem, "the 'list my first camp' guide exists");
      if (nCamps > 0) {
        HC.assert(firstItem.a.indexOf(String(nCamps)) >= 0,
          "the setup guide should quote the live provider count (" + nCamps + ")");
        var nVenues = venueCount();
        HC.assert(nVenues >= 0 && nVenues <= nCamps + 1, "venue count must be sane vs the directory");
      }
    });

    // Persistence round-trips through HC.store (namespaced).
    check("Help state persists via HC.store (votes + tickets)", function () {
      var st = blankState();
      st = recordVote(st, "mkt-followers", "up");
      st = raiseTicket(st, { topic: "marketing", message: "Persist me" }).state;
      var ok = HC.store.set(STORE_STATE, st);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_STATE, null);
      HC.assert(got && got.votes && got.votes["mkt-followers"] === "up", "vote survives a round-trip");
      HC.assert(got.tickets && got.tickets.length === 1, "ticket survives a round-trip");
      // clean up the probe key.
      try { HC.store.remove ? HC.store.remove(STORE_STATE) : HC.store.set(STORE_STATE, null); } catch (e) {}
    });

    // Defensive: bad inputs never throw.
    check("Logic is defensive against bad inputs", function () {
      HC.assert(searchHelp(null, "x").length === 0, "searching with no categories is safe");
      HC.assert(searchHelp(cats, null).length === allGuides(cats).length, "null query treated as empty");
      HC.assert(coversAllRequiredTopics([]) === false, "empty categories fail coverage, not throw");
      var t = raiseTicket(null, { message: "" });
      HC.assert(t.ticket === null, "raising with null state + empty message is a safe no-op");
      var v = recordVote(null, "x", "up");
      HC.assert(v && v.votes && v.votes.x === "up", "recordVote from null state is safe");
    });

    return { pass: pass, fail: fail, log: log };
  }

  // Helper used only in tests: a fresh, blank state object.
  function blankState() {
    return { votes: {}, tickets: [] };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-help-centre",
    title: "Provider help centre & how-to guides",
    side: "provider",
    icon: "📚",
    summary: "A searchable how-to centre for camp organisers, mirroring Happity's provider help collections. " +
      "Four topic sections — setup & getting started, taking & managing bookings, marketing & growing your camp, " +
      "and troubleshooting/FAQs — each with step-by-step guides, search across questions/answers/steps, " +
      "helpful votes, a 'Still stuck? Contact us' ticket, and cross-links to the relevant HolidayCamp feature.",
    render: render,
    selfTest: selfTest
  });
})();
