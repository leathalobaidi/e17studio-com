/* HolidayCamp feature — parent-faq-help
 *
 * Parent help centre / FAQs  (parent side)
 *
 * Replicates Happity's "Parents & Carers FAQs" help centre. Happity splits the
 * parent help centre into five articles, each a category of question:
 *   - Finding classes on Happity            (article 8255669)
 *   - Support with bookings                 (article 8255720)
 *   - Login queries                         (article 8255740)
 *   - Giving us your feedback               (article 8255758)
 *   - Happity newsletters, apps and updates (article 8255771)
 * Each article opens with: "There is a table of contents on the right hand side
 * to help you find the answer to your questions. All you need to do is click on
 * the relevant question and you will be taken to the answer."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): questions are about
 * finding a holiday-camp week, booking/paying for a camp, signing in to manage a
 * booking, leaving feedback / reporting a listing mistake, and the camp-alerts
 * newsletter. Answers are grounded in the LIVE HolidayCamp directory + planner
 * data (HC.data) and cross-link to the sibling feature modules already built
 * (Quick Check, waiting list, discount code, refund, follow, etc.).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   A help section answers FINDING, BOOKING, LOGIN, FEEDBACK and NEWSLETTER
 *   questions — i.e. the help centre has a category for each of those five
 *   topics and each category contains real answered Q&A entries, and the
 *   search can surface an answer in each of those five topics.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-faq-help: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // localStorage (namespaced) keys — feedback/report drafts + "was this helpful".
  var STORE_FEEDBACK = "parent_faq_feedback";   // { reports:[], votes:{ qid: 'up'|'down' } }
  var STORE_OPEN = "parent_faq_last_category";   // remember which category was open

  /* ================================================================
     The five required help categories. The acceptance criterion is
     encoded here: there is exactly one category per required topic,
     and each carries real answered Q&A entries.
     ================================================================ */

  // Each category: { id, topic, title, icon, intro, items:[ {qid,q,a,links?} ] }
  // `topic` is the canonical acceptance-criterion key.
  // `a` is built with the live directory/planner where it helps, via answer fns.
  var REQUIRED_TOPICS = ["finding", "booking", "login", "feedback", "newsletter"];

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

  // Count providers flagged free/HAF, used in a "finding" answer.
  function freeCampCount() {
    var ps = safeProviders();
    var n = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i] || {};
      var funding = (p.funding || []).join(" ").toLowerCase();
      var cats = (p.categories || []).join(" ").toLowerCase();
      if (funding.indexOf("free") >= 0 || funding.indexOf("haf") >= 0 ||
          cats.indexOf("haf") >= 0 || cats.indexOf("free") >= 0) {
        n += 1;
      }
    }
    return n;
  }

  // A live "bookings open" date string for the finding/booking answers.
  function bookingsOpenLine() {
    var ps = safeProviders();
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i] || {};
      if (p.booking && /open/i.test(p.booking)) {
        return String(p.booking);
      }
    }
    return "Booking dates vary by camp — each listing shows when its dates open.";
  }

  function summerWeeksLine() {
    var pl = safePlanner();
    var weeks = (pl && Array.isArray(pl.weeks)) ? pl.weeks : [];
    var real = weeks.filter(function (w) { return w && !w.stub; });
    if (!real.length) return "the summer holidays";
    var first = real[0], last = real[real.length - 1];
    return (real.length) + " weeks of summer camp" +
      (first && first.dates ? ", from " + first.dates : "") +
      (last && last.dates ? " to " + last.dates : "");
  }

  /* ---------------- the FAQ content model ---------------- */

  function buildCategories() {
    var nCamps = providerCount();
    var nFree = freeCampCount();
    var weeksLine = summerWeeksLine();
    var openLine = bookingsOpenLine();

    return [
      {
        id: "faq-finding",
        topic: "finding",
        title: "Finding a holiday camp",
        icon: "🔍",
        intro: "Everything about searching the directory and finding the right camp week.",
        items: [
          {
            qid: "find-how",
            q: "How do I find a holiday camp?",
            a: "Use the Find tab to search the directory of " + nCamps + " Waltham Forest holiday-camp providers. " +
               "Filter by week, age, area and features (Free/HAF, SEND-friendly, early drop-off, food included), then sort by " +
               "distance, start time or price. Every result links straight to that camp's own booking page.",
            links: [
              { id: "parent-sort-results", label: "Sort results" },
              { id: "parent-map-view", label: "Map view" }
            ]
          },
          {
            qid: "find-free",
            q: "Are there free camps, and how do I find them?",
            a: "Yes. " + nFree + " listings include free or HAF (Holiday Activities and Food) places for children eligible for " +
               "benefit-related free school meals. Turn on the Free/HAF filter on the Find tab to show only those. The borough's HAF " +
               "route opens summer bookings separately — its listing shows the exact date.",
            links: []
          },
          {
            qid: "find-when",
            q: "When do summer camps run, and when do bookings open?",
            a: "There are " + weeksLine + ". Camps sell out fast, so book early — " + openLine,
            links: []
          },
          {
            qid: "find-running",
            q: "How can I check a camp is still running before I travel?",
            a: "Use Quick Check on any listing: it shows the camp's latest status (running / nearly full / cancelled) and lets you confirm " +
               "with the provider before you set off — handy for a one-off camp day.",
            links: [ { id: "parent-quick-check", label: "Quick Check" } ]
          },
          {
            qid: "find-full",
            q: "The camp week I want is full — can I join a waiting list?",
            a: "Yes. If a camp week is sold out you can join its waiting list and you'll be told your position; if a place frees up you're " +
               "offered it in order. If a provider has no list for that week, Follow them instead and you'll be emailed when new dates open.",
            links: [
              { id: "parent-waiting-list", label: "Join a waiting list" },
              { id: "parent-follow", label: "Follow a provider" }
            ]
          },
          {
            qid: "find-notbookable",
            q: "A camp isn't bookable online — what do I do?",
            a: "Some providers take bookings on their own site or by enquiry. When a listing isn't bookable in-platform you can send an " +
               "enquiry straight to the provider, or use the booking link on the listing.",
            links: [ { id: "parent-send-enquiry", label: "Send an enquiry" } ]
          }
        ]
      },
      {
        id: "faq-booking",
        topic: "booking",
        title: "Support with bookings",
        icon: "🎟️",
        intro: "Booking, paying, changing and cancelling a camp place.",
        items: [
          {
            qid: "book-multi",
            q: "How do I book for more than one child?",
            a: "At checkout you can add several children to the same camp week and add their details (age, school year, any needs) for each " +
               "one. The total updates as you add children.",
            links: [
              { id: "parent-multi-child", label: "Book for multiple children" },
              { id: "parent-child-details", label: "Child details" }
            ]
          },
          {
            qid: "book-discount",
            q: "Can I use a discount or sibling code?",
            a: "Yes — enter your code in the discount box at checkout and the total recalculates before you pay. Invalid or expired codes are " +
               "rejected with a message.",
            links: [ { id: "parent-discount-code", label: "Apply a discount code" } ]
          },
          {
            qid: "book-confirmation",
            q: "I haven't received my booking confirmation / where is my reference?",
            a: "Every confirmed booking gets a confirmation with a booking reference. If it hasn't arrived, check your spam folder, then open " +
               "the booking from your account where the reference is always shown.",
            links: [ { id: "parent-booking-confirmation", label: "Booking confirmation & reference" } ]
          },
          {
            qid: "book-cancel",
            q: "How do I cancel or reschedule a camp booking?",
            a: "Cancellations and date changes are handled by the camp provider under their own policy. Open your booking and use the " +
               "cancel / reschedule option, which routes your request to the provider.",
            links: [ { id: "parent-cancel-reschedule-route", label: "Cancel / reschedule" } ]
          },
          {
            qid: "book-refund",
            q: "How do I request a refund?",
            a: "Refunds are issued by the provider according to their terms. Submit a refund request against your booking and it's sent to the " +
               "provider to action.",
            links: [ { id: "parent-refund-request", label: "Request a refund" } ]
          },
          {
            qid: "book-payment",
            q: "I had a payment problem — what now?",
            a: "If a card payment fails the place isn't held, so try again or use another card. Some camps also allow pay-on-the-door or a " +
               "pay-what-you-want donation; the listing shows which.",
            links: [
              { id: "parent-pay-on-door", label: "Pay on the door" },
              { id: "parent-donation", label: "Pay-what-you-want" }
            ]
          }
        ]
      },
      {
        id: "faq-login",
        topic: "login",
        title: "Account & login queries",
        icon: "🔑",
        intro: "Creating an account and getting back in.",
        items: [
          {
            qid: "login-create",
            q: "How do I create an account?",
            a: "You can create an account with your email the first time you book, or from the Sign in link. Your account keeps your bookings, " +
               "references and the camps you follow in one place.",
            links: []
          },
          {
            qid: "login-reset",
            q: "I'm not receiving my password reset email — why?",
            a: "Reset emails can take a few minutes and sometimes land in spam or promotions. Make sure you used the same email you booked with, " +
               "check those folders, and request the reset again if needed.",
            links: []
          },
          {
            qid: "login-find-bookings",
            q: "Where are my camp bookings once I'm logged in?",
            a: "Signed-in, your bookings (with their references) and any waiting-list places or followed providers all live in your account, so " +
               "you can manage a camp without digging through emails.",
            links: [ { id: "parent-booking-confirmation", label: "Booking confirmation & reference" } ]
          }
        ]
      },
      {
        id: "faq-feedback",
        topic: "feedback",
        title: "Giving us your feedback",
        icon: "💬",
        intro: "Reviewing a camp, reporting a listing mistake, and feedback on the site.",
        items: [
          {
            qid: "feedback-review",
            q: "How do I leave a review for a camp we attended?",
            a: "After a camp you can leave a review on the provider's listing to help other parents. Reviews are about the camp itself — the " +
               "activities, staff and how your child got on.",
            links: []
          },
          {
            qid: "feedback-report",
            q: "I spotted a mistake in a listing — how do I report it?",
            a: "Use the 'Report a listing mistake' form below. Tell us the camp and what's wrong (wrong dates, price, age range or venue) and " +
               "we'll get it corrected. The directory is checked, but camps change their plans.",
            links: [],
            report: true
          },
          {
            qid: "feedback-site",
            q: "How do I give feedback on the HolidayCamp site itself?",
            a: "Feedback on the website or app — something confusing, broken, or an idea — goes through the same feedback form below. Pick " +
               "'Website / app feedback' as the type.",
            links: [],
            report: true
          }
        ]
      },
      {
        id: "faq-newsletter",
        topic: "newsletter",
        title: "Newsletter, alerts & updates",
        icon: "📧",
        intro: "Camp-alert emails, our newsletter, and how to unsubscribe.",
        items: [
          {
            qid: "news-signup",
            q: "How do I sign up for camp alerts / the newsletter?",
            a: "Add your email to the newsletter box below for term-by-term camp news. For alerts about one provider's new dates, Follow that " +
               "provider — you'll be emailed their timetable the moment new holiday-camp dates go live.",
            links: [ { id: "parent-follow", label: "Follow a provider" } ],
            newsletter: true
          },
          {
            qid: "news-prefs",
            q: "How do I change what emails I get?",
            a: "You control it from the newsletter box below — tick the camp-alerts and/or what's-on emails you want. Following or unfollowing a " +
               "provider changes that provider's own alerts separately.",
            links: [ { id: "parent-follow", label: "Follow a provider" } ],
            newsletter: true
          },
          {
            qid: "news-unsub",
            q: "How do I unsubscribe?",
            a: "Untick everything in the newsletter box below (or use the unsubscribe link in any email) and we'll stop sending. Unsubscribing " +
               "from the newsletter doesn't cancel any camp booking.",
            links: [],
            newsletter: true
          }
        ]
      }
    ];
  }

  /* ================================================================
     Pure, testable logic (DOM-free) — search, topic coverage, votes,
     reports and newsletter preferences.
     ================================================================ */

  // Flatten categories to a searchable list of Q&A entries (each tagged topic).
  function allEntries(categories) {
    var out = [];
    (categories || []).forEach(function (c) {
      (c.items || []).forEach(function (it) {
        out.push({
          topic: c.topic,
          categoryId: c.id,
          categoryTitle: c.title,
          qid: it.qid,
          q: it.q,
          a: it.a
        });
      });
    });
    return out;
  }

  // Case-insensitive search across question + answer text. Returns entries.
  function searchFaq(categories, query) {
    var entries = allEntries(categories);
    var q = String(query == null ? "" : query).trim().toLowerCase();
    if (!q) return entries;
    var terms = q.split(/\s+/).filter(Boolean);
    return entries.filter(function (e) {
      var hay = (e.q + " " + e.a + " " + e.categoryTitle).toLowerCase();
      // every term must appear (AND match) — keeps results tight
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
  }

  // Which of the five required topics are actually covered (>=1 answered item).
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

  // True only if every required topic has at least one answered question.
  function answersAllRequiredTopics(categories) {
    var seen = coveredTopics(categories);
    return REQUIRED_TOPICS.every(function (t) { return (seen[t] || 0) > 0; });
  }

  /* ---- feedback store (votes + reports), via HC.store only ---- */

  function loadFeedback() {
    var raw;
    try { raw = HC.store.get(STORE_FEEDBACK, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object") raw = {};
    if (!Array.isArray(raw.reports)) raw.reports = [];
    if (!raw.votes || typeof raw.votes !== "object") raw.votes = {};
    if (!raw.newsletter || typeof raw.newsletter !== "object") {
      raw.newsletter = { email: "", campAlerts: false, whatsOn: false };
    }
    return raw;
  }
  function saveFeedback(fb) {
    try { HC.store.set(STORE_FEEDBACK, fb); return true; } catch (e) { return false; }
  }

  // Record a "was this helpful" vote against a question id. Pure-ish on `fb`.
  function recordVote(fb, qid, value) {
    var next = cloneJson(fb);
    if (!next.votes) next.votes = {};
    if (value === "up" || value === "down") next.votes[qid] = value;
    else delete next.votes[qid];
    return next;
  }

  // File a listing-mistake / website-feedback report. Returns { state, report }.
  function fileReport(fb, payload) {
    var next = cloneJson(fb);
    if (!Array.isArray(next.reports)) next.reports = [];
    payload = payload || {};
    var type = payload.type === "site" ? "site" : "listing";
    var message = String(payload.message == null ? "" : payload.message).trim();
    if (!message) return { state: next, report: null, error: "A description is required" };
    var report = {
      id: safeUid(),
      type: type,                       // 'listing' | 'site'
      camp: String(payload.camp || "").trim(),
      message: message,
      at: nowIso()
    };
    next.reports.push(report);
    return { state: next, report: report, error: null };
  }

  // Update newsletter preferences. Returns new fb.
  function setNewsletterPrefs(fb, prefs) {
    var next = cloneJson(fb);
    prefs = prefs || {};
    next.newsletter = {
      email: String(prefs.email == null ? (next.newsletter && next.newsletter.email) || "" : prefs.email).trim(),
      campAlerts: !!prefs.campAlerts,
      whatsOn: !!prefs.whatsOn
    };
    return next;
  }

  // Is the parent subscribed to anything?
  function isSubscribed(fb) {
    var n = fb && fb.newsletter;
    return !!(n && n.email && (n.campAlerts || n.whatsOn));
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
    var fb = loadFeedback();

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Your help centre for booking holiday camps. Pick a topic or search your question — " +
      "click a question to read the answer. These cover finding a camp, booking and paying, " +
      "signing in, giving feedback, and camp-alert emails."));

    // ---- search box ----
    var search = HC.util.el("input", {
      type: "search", placeholder: "Search help (e.g. refund, full week, password)…",
      style: "width:100%;max-width:420px;padding:10px 13px;border:1.5px solid var(--line,#E6E6E6);" +
        "border-radius:12px;font-size:14px;box-sizing:border-box;margin:0 0 16px"
    });
    wrap.appendChild(search);

    // ---- category tabs ----
    var tabRow = HC.util.el("div", {
      style: "display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px"
    });
    wrap.appendChild(tabRow);

    var panel = HC.util.el("div", {});
    wrap.appendChild(panel);

    mountEl.appendChild(wrap);

    var openId = null;
    try { openId = HC.store.get(STORE_OPEN, null); } catch (e) { openId = null; }
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
        try { HC.store.set(STORE_OPEN, openId); } catch (e) {}
        search.value = "";
        paint();
      });
      return b;
    }

    function renderQA(entry, voteState) {
      // entry shape from allEntries (search) OR from category item — normalise.
      var qid = entry.qid, q = entry.q, a = entry.a;
      var item = entry; // category item carries links/report/newsletter flags
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

      // cross-links to sibling features
      var links = (item.links || []).map(function (l) {
        var label = featureTitle(l.id) || l.label || l.id;
        return '<button type="button" class="hc-btn hc-btn-ghost" data-faq-link="' + attr(l.id) +
          '" style="font-size:11.5px;padding:6px 11px">' + esc(label) + "</button>";
      });
      if (links.length) {
        var linkRow = HC.util.el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px" }, links.join(""));
        body.appendChild(linkRow);
      }

      // inline newsletter mini-form on newsletter items
      if (item.newsletter) {
        body.appendChild(buildNewsletterForm());
      }
      // inline report form on feedback items
      if (item.report) {
        body.appendChild(buildReportForm(item));
      }

      // "was this helpful?" votes
      var voteRow = HC.util.el("div", {
        style: "display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--muted,#808080)"
      });
      voteRow.appendChild(HC.util.el("span", null, "Was this helpful?"));
      var current = (voteState && voteState[qid]) || null;
      var up = HC.util.el("button", {
        type: "button", class: "hc-btn hc-btn-ghost",
        style: "font-size:11.5px;padding:5px 10px" + (current === "up" ? ";background:var(--purple-tint,#F0E8F4)" : "")
      }, current === "up" ? "👍 Thanks" : "👍 Yes");
      var down = HC.util.el("button", {
        type: "button", class: "hc-btn hc-btn-ghost",
        style: "font-size:11.5px;padding:5px 10px" + (current === "down" ? ";background:var(--pink-tint,#FCE8F0)" : "")
      }, "👎 No");
      up.addEventListener("click", function () {
        fb = recordVote(fb, qid, current === "up" ? null : "up");
        saveFeedback(fb);
        try { HC.util.toast("Thanks for the feedback"); } catch (e) {}
        paint();
      });
      down.addEventListener("click", function () {
        fb = recordVote(fb, qid, current === "down" ? null : "down");
        saveFeedback(fb);
        try { HC.util.toast("Thanks — we'll improve this answer"); } catch (e) {}
        paint();
      });
      voteRow.appendChild(up);
      voteRow.appendChild(down);
      body.appendChild(voteRow);

      det.appendChild(body);
      return det;
    }

    function buildNewsletterForm() {
      var box = HC.util.el("div", {
        style: "border:1.5px dashed var(--purple-tint,#D9C7E6);border-radius:12px;padding:12px 14px;margin:0 0 10px;background:#FBF8FD"
      });
      box.appendChild(HC.util.el("div", {
        style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:12px;color:var(--magenta,#F82488);" +
          "text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px"
      }, "Camp-alert emails"));

      var emailIn = HC.util.el("input", {
        type: "email", placeholder: "you@example.com", value: (fb.newsletter && fb.newsletter.email) || "",
        style: "width:100%;max-width:280px;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px;box-sizing:border-box;margin:0 0 8px"
      });
      box.appendChild(emailIn);

      var alertsLab = HC.util.el("label", { style: "display:flex;gap:7px;align-items:center;font-size:13px;margin:0 0 5px;cursor:pointer" });
      var alertsCb = HC.util.el("input", { type: "checkbox" });
      alertsCb.checked = !!(fb.newsletter && fb.newsletter.campAlerts);
      alertsLab.appendChild(alertsCb);
      alertsLab.appendChild(HC.util.el("span", null, "Term-by-term holiday-camp alerts"));
      box.appendChild(alertsLab);

      var wonLab = HC.util.el("label", { style: "display:flex;gap:7px;align-items:center;font-size:13px;margin:0 0 10px;cursor:pointer" });
      var wonCb = HC.util.el("input", { type: "checkbox" });
      wonCb.checked = !!(fb.newsletter && fb.newsletter.whatsOn);
      wonLab.appendChild(wonCb);
      wonLab.appendChild(HC.util.el("span", null, "What's-on in Waltham Forest this holiday"));
      box.appendChild(wonLab);

      var saveBtn = HC.util.el("button", { type: "button", class: "hc-btn", style: "font-size:12px" }, "Save email preferences");
      saveBtn.addEventListener("click", function () {
        fb = setNewsletterPrefs(fb, {
          email: emailIn.value, campAlerts: alertsCb.checked, whatsOn: wonCb.checked
        });
        saveFeedback(fb);
        if (isSubscribed(fb)) {
          try { HC.util.toast("Subscribed to camp alerts"); } catch (e) {}
        } else {
          try { HC.util.toast("Email preferences updated (unsubscribed)"); } catch (e) {}
        }
        paint();
      });
      box.appendChild(saveBtn);
      return box;
    }

    function buildReportForm(item) {
      var isSite = /site|website|app/i.test(item.qid) || /site|website|app/i.test(item.q);
      var box = HC.util.el("div", {
        style: "border:1.5px dashed var(--purple-tint,#D9C7E6);border-radius:12px;padding:12px 14px;margin:0 0 10px;background:#FBF8FD"
      });
      box.appendChild(HC.util.el("div", {
        style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:12px;color:var(--magenta,#F82488);" +
          "text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px"
      }, isSite ? "Website / app feedback" : "Report a listing mistake"));

      var campIn = null;
      if (!isSite) {
        campIn = HC.util.el("input", {
          type: "text", placeholder: "Which camp / listing?",
          style: "width:100%;max-width:320px;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px;box-sizing:border-box;margin:0 0 8px"
        });
        box.appendChild(campIn);
      }
      var msgIn = HC.util.el("textarea", {
        placeholder: isSite ? "Tell us what's confusing or broken…" : "What's wrong? (wrong dates, price, age range, venue…)",
        rows: "2",
        style: "width:100%;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px;box-sizing:border-box;margin:0 0 8px;resize:vertical"
      });
      box.appendChild(msgIn);

      var sendBtn = HC.util.el("button", { type: "button", class: "hc-btn", style: "font-size:12px" }, "Send feedback");
      sendBtn.addEventListener("click", function () {
        var res = fileReport(fb, {
          type: isSite ? "site" : "listing",
          camp: campIn ? campIn.value : "",
          message: msgIn.value
        });
        if (res.error) {
          try { HC.util.toast(res.error); } catch (e) {}
          msgIn.focus();
          return;
        }
        fb = res.state;
        saveFeedback(fb);
        try { HC.util.toast("Thanks — feedback sent (ref " + res.report.id.slice(-6) + ")"); } catch (e) {}
        paint();
      });
      box.appendChild(sendBtn);

      // show how many reports filed (so the demo has visible state)
      var count = (fb.reports || []).length;
      if (count) {
        box.appendChild(HC.util.el("div", { style: "font-size:11.5px;color:var(--muted,#808080);margin-top:8px" },
          count + " feedback item" + (count === 1 ? "" : "s") + " sent from this browser."));
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
        var hits = searchFaq(categories, query);
        var head = HC.util.el("div", {
          style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);" +
            "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 10px"
        }, hits.length + " result" + (hits.length === 1 ? "" : "s") + ' for "' + esc(query) + '"');
        panel.appendChild(head);
        if (!hits.length) {
          panel.appendChild(HC.util.el("p", { style: "font-size:13.5px;color:var(--muted,#808080)" },
            "No help articles matched. Try fewer or different words — or browse the topics above."));
          return;
        }
        // For search results we need the original item (with links/forms), look it up.
        hits.forEach(function (h) {
          var cat = categories.filter(function (c) { return c.id === h.categoryId; })[0];
          var item = cat && (cat.items || []).filter(function (i) { return i.qid === h.qid; })[0];
          if (!item) item = h;
          // tag which category the hit is from
          var tag = HC.util.el("div", { style: "font-size:11px;color:var(--muted,#808080);margin:0 0 2px" },
            (cat ? cat.icon + " " + cat.title : ""));
          panel.appendChild(tag);
          panel.appendChild(renderQA(item, fb.votes));
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
        panel.appendChild(renderQA(it, fb.votes));
      });
    }

    search.addEventListener("input", paint);

    // cross-link clicks: open the named sibling feature via the hub's mechanism.
    panel.addEventListener("click", function (e) {
      var lk = e.target && e.target.closest ? e.target.closest("[data-faq-link]") : null;
      if (!lk) return;
      e.preventDefault();
      var id = lk.getAttribute("data-faq-link");
      // Re-dispatch to the core hub's delegated [data-hc-open] handler by
      // creating a transient button — keeps us decoupled from core internals.
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
       "A help section answers finding, booking, login, feedback and newsletter
        questions." We assert there's a category for each of the five topics and
        each holds real answered Q&A entries. */
    check("Help centre answers all five required topics (finding/booking/login/feedback/newsletter)", function () {
      HC.assert(answersAllRequiredTopics(cats),
        "every required topic must have at least one answered question");
      var seen = coveredTopics(cats);
      REQUIRED_TOPICS.forEach(function (t) {
        HC.assert((seen[t] || 0) > 0, "topic '" + t + "' has no answered questions");
      });
    });

    // Each required topic individually — explicit per-topic assertions.
    REQUIRED_TOPICS.forEach(function (topic) {
      check("Topic '" + topic + "' has a category with answered questions", function () {
        var cat = cats.filter(function (c) { return c.topic === topic; })[0];
        HC.assert(cat, "a category exists for topic '" + topic + "'");
        HC.assert(cat.title && cat.title.length, "the '" + topic + "' category has a title");
        var answered = (cat.items || []).filter(function (it) {
          return it.q && String(it.q).trim() && it.a && String(it.a).trim();
        });
        HC.assert(answered.length >= 1,
          "topic '" + topic + "' needs at least one answered Q&A, found " + answered.length);
      });
    });

    // Exactly one category per required topic (no missing / no accidental dupes
    // collapsing a topic away).
    check("Exactly one category per required topic", function () {
      REQUIRED_TOPICS.forEach(function (t) {
        var n = cats.filter(function (c) { return c.topic === t; }).length;
        HC.assert(n === 1, "expected one category for '" + t + "', found " + n);
      });
    });

    // Every Q&A entry across the whole centre is genuinely answered.
    check("Every question in the help centre has a non-empty answer", function () {
      var entries = allEntries(cats);
      HC.assert(entries.length >= 15, "expected a substantial FAQ set, got " + entries.length);
      entries.forEach(function (e) {
        HC.assert(e.q && e.q.length > 3, "a question is missing text: " + e.qid);
        HC.assert(e.a && e.a.length > 10, "answer too short / empty for: " + e.qid);
      });
    });

    // Search can surface an answer in EACH of the five topics — proves the help
    // section actually *answers* those questions to a searching parent.
    check("Search surfaces an answer in each required topic", function () {
      var probes = {
        finding: "find camp",
        booking: "refund",
        login: "password reset",
        feedback: "report listing mistake",
        newsletter: "newsletter unsubscribe"
      };
      Object.keys(probes).forEach(function (topic) {
        var hits = searchFaq(cats, probes[topic]);
        HC.assert(hits.length > 0, "search '" + probes[topic] + "' returned nothing for topic " + topic);
        var inTopic = hits.some(function (h) { return h.topic === topic; });
        HC.assert(inTopic, "search '" + probes[topic] + "' did not surface a '" + topic + "' answer");
      });
    });

    // Search: empty query returns the full set; AND-matching narrows it.
    check("Search returns all entries on empty query and narrows on terms", function () {
      var all = searchFaq(cats, "");
      HC.assert(all.length === allEntries(cats).length, "empty query should return everything");
      var narrowed = searchFaq(cats, "waiting list full");
      HC.assert(narrowed.length >= 1, "expected a waiting-list result");
      HC.assert(narrowed.length < all.length, "a specific query should narrow the set");
      var none = searchFaq(cats, "zzgibberishzz");
      HC.assert(none.length === 0, "nonsense query should match nothing, got " + none.length);
    });

    // Search is case-insensitive.
    check("Search is case-insensitive", function () {
      var lower = searchFaq(cats, "refund").length;
      var upper = searchFaq(cats, "REFUND").length;
      HC.assert(lower > 0 && lower === upper, "case should not change result count (" + lower + " vs " + upper + ")");
    });

    // "Was this helpful" votes record and toggle off.
    check("Helpful votes record, change and clear", function () {
      var fb = { reports: [], votes: {}, newsletter: { email: "", campAlerts: false, whatsOn: false } };
      fb = recordVote(fb, "find-how", "up");
      HC.assert(fb.votes["find-how"] === "up", "an up-vote is recorded");
      fb = recordVote(fb, "find-how", "down");
      HC.assert(fb.votes["find-how"] === "down", "a vote can be changed");
      fb = recordVote(fb, "find-how", null);
      HC.assert(!fb.votes["find-how"], "a vote can be cleared");
      fb = recordVote(fb, "find-how", "sideways");
      HC.assert(!fb.votes["find-how"], "an invalid vote value is ignored");
    });

    // Reporting a listing mistake / site feedback files a report; empty rejected.
    check("Filing a listing-mistake / site report works and validates", function () {
      var fb = loadFeedbackBlank();
      var bad = fileReport(fb, { type: "listing", camp: "Lloyd Park Camp", message: "   " });
      HC.assert(bad.report === null, "an empty message must be rejected");
      HC.assert(bad.error, "rejection carries an error message");
      var res = fileReport(fb, { type: "listing", camp: "Lloyd Park Camp", message: "Wrong age range — it's 5-11 not 4-7" });
      HC.assert(res.report, "a valid report is filed");
      HC.assert(res.report.type === "listing", "report type captured");
      HC.assert(res.report.camp === "Lloyd Park Camp", "the camp name is captured");
      HC.assert(res.state.reports.length === 1, "report appended to the list");
      var site = fileReport(res.state, { type: "site", message: "The week filter is confusing" });
      HC.assert(site.report.type === "site", "site feedback recorded as type 'site'");
      HC.assert(site.state.reports.length === 2, "second report appended");
    });

    // Newsletter sign-up / preferences / unsubscribe (the newsletter topic logic).
    check("Newsletter sign-up, preference change and unsubscribe", function () {
      var fb = loadFeedbackBlank();
      HC.assert(isSubscribed(fb) === false, "starts unsubscribed");
      fb = setNewsletterPrefs(fb, { email: "leath@example.com", campAlerts: true, whatsOn: false });
      HC.assert(isSubscribed(fb) === true, "subscribing with an email + an alert type subscribes them");
      HC.assert(fb.newsletter.email === "leath@example.com", "email recorded");
      fb = setNewsletterPrefs(fb, { email: "leath@example.com", campAlerts: true, whatsOn: true });
      HC.assert(fb.newsletter.whatsOn === true, "preferences can be widened");
      // unsubscribe = no boxes ticked
      fb = setNewsletterPrefs(fb, { email: "leath@example.com", campAlerts: false, whatsOn: false });
      HC.assert(isSubscribed(fb) === false, "unticking all alert types unsubscribes");
      // an email with no ticked types is not 'subscribed'
      fb = setNewsletterPrefs(fb, { email: "", campAlerts: true, whatsOn: true });
      HC.assert(isSubscribed(fb) === false, "no email means not subscribed even if boxes ticked");
    });

    // Cross-links point at real, registered sibling features (where present).
    check("FAQ cross-links reference real feature ids", function () {
      var ids = {};
      cats.forEach(function (c) {
        (c.items || []).forEach(function (it) {
          (it.links || []).forEach(function (l) { ids[l.id] = true; });
        });
      });
      var linked = Object.keys(ids);
      HC.assert(linked.length >= 5, "FAQ should cross-link to several features, got " + linked.length);
      // All linked ids should look like parent-side feature ids.
      linked.forEach(function (id) {
        HC.assert(/^parent-/.test(id), "cross-link id should be a parent feature: " + id);
      });
      // If the registry is populated, every link must resolve to a real feature.
      var registry = {};
      try { (HC.features || []).forEach(function (f) { if (f) registry[f.id] = true; }); } catch (e) {}
      if (Object.keys(registry).length > 1) {
        linked.forEach(function (id) {
          HC.assert(registry[id], "cross-linked feature not registered: " + id);
        });
      }
    });

    // Answers are grounded in LIVE data when present (the directory count, the
    // free-camp count, the summer-weeks line all read HC.data).
    check("Finding answers are grounded in live directory/planner data", function () {
      var nCamps = providerCount();
      var findCat = cats.filter(function (c) { return c.topic === "finding"; })[0];
      var howItem = (findCat.items || []).filter(function (i) { return i.qid === "find-how"; })[0];
      HC.assert(howItem, "the 'how do I find a camp' answer exists");
      if (nCamps > 0) {
        HC.assert(howItem.a.indexOf(String(nCamps)) >= 0,
          "the finding answer should quote the live provider count (" + nCamps + ")");
        // free-camp count must be a subset of total, and non-negative
        var nFree = freeCampCount();
        HC.assert(nFree >= 0 && nFree <= nCamps, "free-camp count must be within the directory");
      }
    });

    // Persistence round-trips through HC.store (namespaced).
    check("Feedback state persists via HC.store (votes, reports, newsletter)", function () {
      var fb = loadFeedbackBlank();
      fb = recordVote(fb, "news-signup", "up");
      fb = fileReport(fb, { type: "listing", camp: "Test Camp", message: "Persist me" }).state;
      fb = setNewsletterPrefs(fb, { email: "persist@x.com", campAlerts: true, whatsOn: false });
      var ok = HC.store.set(STORE_FEEDBACK, fb);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_FEEDBACK, null);
      HC.assert(got && got.votes && got.votes["news-signup"] === "up", "vote survives a round-trip");
      HC.assert(got.reports && got.reports.length === 1, "report survives a round-trip");
      HC.assert(got.newsletter && got.newsletter.email === "persist@x.com", "newsletter email survives");
      // clean up the probe key so we don't leave state lying around
      try { HC.store.remove ? HC.store.remove(STORE_FEEDBACK) : HC.store.set(STORE_FEEDBACK, null); } catch (e) {}
    });

    // Defensive: bad inputs never throw.
    check("Logic is defensive against bad inputs", function () {
      HC.assert(searchFaq(null, "x").length === 0, "searching with no categories is safe");
      HC.assert(searchFaq(cats, null).length === allEntries(cats).length, "null query treated as empty");
      HC.assert(answersAllRequiredTopics([]) === false, "empty categories fail coverage, not throw");
      var fb = fileReport(null, { message: "" });
      HC.assert(fb.report === null, "filing with null state + empty message is a safe no-op");
      var fb2 = setNewsletterPrefs(null, null);
      HC.assert(fb2 && fb2.newsletter && isSubscribed(fb2) === false, "newsletter prefs from null inputs are safe");
    });

    return { pass: pass, fail: fail, log: log };
  }

  // Helper used only in tests: a fresh, blank feedback object.
  function loadFeedbackBlank() {
    return { reports: [], votes: {}, newsletter: { email: "", campAlerts: false, whatsOn: false } };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-faq-help",
    title: "Parent help centre & FAQs",
    side: "parent",
    icon: "❓",
    summary: "A searchable help centre for parents, mirroring Happity's Parents & Carers FAQs. Five topic " +
      "sections — finding a camp, booking support, account/login, giving feedback (incl. reporting a listing " +
      "mistake) and the camp-alerts newsletter — each with answered questions, search, helpful votes, and " +
      "cross-links to the relevant HolidayCamp feature.",
    render: render,
    selfTest: selfTest
  });
})();
