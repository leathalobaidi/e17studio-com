/* HolidayCamp feature: parent-child-details
 * --------------------------------------------------------------------------
 * Replicates Happity's booking-questions behaviour (support article 6172207,
 * "Can I add questions to the bookings process?"): during checkout parents are
 * asked for their contact information, information on the child(ren) attending,
 * and a free-text box to "detail anything else you might need to know (known
 * allergies, medical conditions)".
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: we validate the child's age against the
 * camp's published age band (ageMin/ageMax from the live E17 directory) and let
 * a parent register several children on one booking, each carrying its own
 * free-text medical / allergy note.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Checkout captures child name, age and a free-text medical/allergy field.
 *
 * Self-contained, defensive plain-browser JS. No imports/exports.
 * Persists only via HC.store (namespaced "hc_"). Never throws at registration.
 * -------------------------------------------------------------------------- */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — nothing to register against. Fail silent & safe.
    return;
  }

  var HC = window.HC;
  var STORE_KEY = "checkout:child-details";

  /* ---------------------------------------------------------------------- *
   * Pure logic (no DOM) — this is what selfTest exercises.
   * ---------------------------------------------------------------------- */

  // Coerce a free-typed age into a whole number of years, or null if unusable.
  function parseAge(raw) {
    if (raw === 0) return 0;
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var n = parseInt(s, 10);
    if (!isFinite(n)) return null;
    return n;
  }

  // The camp's age band. Tolerates partial / missing data on a provider.
  function ageBand(camp) {
    var min = camp && isFinite(Number(camp.ageMin)) ? Number(camp.ageMin) : 0;
    var max = camp && isFinite(Number(camp.ageMax)) ? Number(camp.ageMax) : 120;
    if (min > max) { var t = min; min = max; max = t; }
    return { min: min, max: max };
  }

  // Validate ONE child record against a camp. Returns { ok, errors:[], warnings:[] }.
  // - name: required, non-empty after trim.
  // - age: required, a whole number 0..18 (school-age product, but we accept any
  //        plausible child age and only *warn* when outside the camp's band).
  // - medical: free text, optional, but we record whether it was supplied.
  function validateChild(child, camp) {
    var errors = [];
    var warnings = [];
    child = child || {};

    var name = (child.name == null ? "" : String(child.name)).trim();
    if (!name) errors.push("Child's name is required.");

    var age = parseAge(child.age);
    if (age === null) {
      errors.push("Child's age is required.");
    } else if (age < 0 || age > 18) {
      errors.push("Enter an age in years (0-18).");
    } else {
      var band = ageBand(camp);
      if (age < band.min || age > band.max) {
        warnings.push(
          "This camp is for ages " + band.min + "-" + band.max +
          "; " + (name || "this child") + " is " + age + "."
        );
      }
    }

    // Free-text medical / allergy field — never required, always captured.
    var medical = (child.medical == null ? "" : String(child.medical)).trim();

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      normalised: { name: name, age: age, medical: medical, hasMedical: medical.length > 0 }
    };
  }

  // Validate the whole checkout submission: parent contact + >=1 child.
  function validateSubmission(submission, camp) {
    var errors = [];
    var childResults = [];
    submission = submission || {};

    var contact = submission.contact || {};
    var pName = (contact.name == null ? "" : String(contact.name)).trim();
    var pEmail = (contact.email == null ? "" : String(contact.email)).trim();
    if (!pName) errors.push("Your name is required.");
    if (!pEmail || pEmail.indexOf("@") < 1) errors.push("A valid contact email is required.");

    var children = Array.isArray(submission.children) ? submission.children : [];
    if (!children.length) errors.push("Add at least one child to the booking.");

    for (var i = 0; i < children.length; i++) {
      var r = validateChild(children[i], camp);
      childResults.push(r);
      for (var e = 0; e < r.errors.length; e++) {
        errors.push("Child " + (i + 1) + ": " + r.errors[e]);
      }
    }

    var warnings = [];
    for (var w = 0; w < childResults.length; w++) {
      warnings = warnings.concat(childResults[w].warnings);
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      children: childResults,
      // The captured booking record, only meaningful when ok === true.
      record: {
        campId: camp && camp.id ? camp.id : null,
        campName: camp && camp.name ? camp.name : null,
        contact: { name: pName, email: pEmail, phone: (contact.phone == null ? "" : String(contact.phone)).trim() },
        children: childResults.map(function (cr) { return cr.normalised; }),
        savedAt: Date.now()
      }
    };
  }

  // Persist a completed booking record (defensive; never throws).
  function saveBooking(record) {
    try {
      var all = HC.store.get(STORE_KEY, []);
      if (!Array.isArray(all)) all = [];
      var id = (HC.util && HC.util.uid) ? HC.util.uid() : ("bk_" + Date.now());
      var entry = { id: id, record: record };
      all.push(entry);
      HC.store.set(STORE_KEY, all);
      return entry;
    } catch (e) {
      return null;
    }
  }

  function loadBookings() {
    var all = HC.store.get(STORE_KEY, []);
    return Array.isArray(all) ? all : [];
  }

  // Pick a sensible demo camp from the live directory (prefer a school-age band).
  function demoCamp() {
    var providers = (HC.data && HC.data.providers) || [];
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (p && isFinite(Number(p.ageMin)) && isFinite(Number(p.ageMax))) return p;
    }
    return providers[0] || { id: "demo", name: "Demo Holiday Camp", ageMin: 5, ageMax: 12 };
  }

  /* ---------------------------------------------------------------------- *
   * UI — render(mountEl). A working, interactive checkout child-details form.
   * ---------------------------------------------------------------------- */

  function render(mountEl) {
    try {
      var el = HC.util.el;
      var camp = demoCamp();
      var band = ageBand(camp);

      // Local working state: list of child rows.
      var children = [{ name: "", age: "", medical: "" }];

      mountEl.innerHTML = "";

      var intro = el("div", { style: "margin:0 0 14px" },
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 6px">' +
          'Booking <strong>' + esc(camp.name || "this camp") + '</strong> ' +
          '<span style="color:var(--muted,#808080)">(ages ' + band.min + '-' + band.max + ')</span>.</p>' +
        '<p style="font-size:13px;color:var(--muted,#808080);margin:0">' +
          'Just like Happity checkout: we collect your contact details, each child’s ' +
          'name and age, and a free-text box for allergies or medical conditions.</p>');
      mountEl.appendChild(intro);

      // ---- contact block ----
      var contactWrap = el("div", { style: fieldGroupStyle() });
      contactWrap.innerHTML =
        '<div style="' + legendStyle() + '">Your contact details</div>' +
        row(
          input("hc-cd-pname", "Your name", "text") +
          input("hc-cd-pemail", "Email", "email")
        ) +
        input("hc-cd-pphone", "Phone (optional)", "tel");
      mountEl.appendChild(contactWrap);

      // ---- children block ----
      var childrenWrap = el("div", { style: fieldGroupStyle() });
      var childrenHead = el("div", { style: "display:flex;align-items:center;justify-content:space-between" });
      childrenHead.innerHTML = '<div style="' + legendStyle() + ';margin:0">Children attending</div>';
      var addBtn = el("button", { type: "button", class: "hc-btn hc-btn-ghost", style: "padding:6px 12px" }, "+ Add child");
      childrenHead.appendChild(addBtn);
      childrenWrap.appendChild(childrenHead);

      var childList = el("div", { style: "margin-top:10px;display:flex;flex-direction:column;gap:12px" });
      childrenWrap.appendChild(childList);
      mountEl.appendChild(childrenWrap);

      function renderChildren() {
        childList.innerHTML = "";
        children.forEach(function (c, idx) {
          var card = el("div", {
            style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px;background:#fff"
          });
          var head = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
            '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:13px">Child ' + (idx + 1) + '</span>' +
            (children.length > 1
              ? '<button type="button" data-cd-remove="' + idx + '" style="background:none;border:none;color:var(--magenta,#F82488);font-size:12px;cursor:pointer">Remove</button>'
              : '') +
            '</div>';
          card.innerHTML = head +
            row(
              labelledInput("cd-name-" + idx, "Child’s name", "text", c.name) +
              labelledInput("cd-age-" + idx, "Age (years)", "number", c.age)
            ) +
            '<label style="' + labelStyle() + '">Allergies / medical conditions ' +
              '<span style="color:var(--muted,#808080);font-weight:400">(anything we should know)</span>' +
              '<textarea data-cd-field="medical" data-cd-idx="' + idx + '" rows="2" ' +
              'placeholder="e.g. nut allergy, asthma inhaler, EpiPen, none" ' +
              'style="' + textareaStyle() + '">' + esc(c.medical || "") + '</textarea></label>';
          childList.appendChild(card);
        });
        // wire field inputs to working state
        childList.querySelectorAll("[data-cd-field]").forEach(function (f) {
          f.addEventListener("input", function () {
            var i = Number(f.getAttribute("data-cd-idx"));
            var key = f.getAttribute("data-cd-field");
            if (children[i]) children[i][key] = f.value;
          });
        });
        // name + age use data-cd-id fields; bind them by index
        children.forEach(function (c, idx) {
          var nameEl = childList.querySelector('[data-cd-id="cd-name-' + idx + '"]');
          var ageEl = childList.querySelector('[data-cd-id="cd-age-' + idx + '"]');
          if (nameEl) nameEl.addEventListener("input", function () { children[idx].name = nameEl.value; });
          if (ageEl) ageEl.addEventListener("input", function () { children[idx].age = ageEl.value; });
        });
        childList.querySelectorAll("[data-cd-remove]").forEach(function (b) {
          b.addEventListener("click", function () {
            var i = Number(b.getAttribute("data-cd-remove"));
            children.splice(i, 1);
            if (!children.length) children.push({ name: "", age: "", medical: "" });
            renderChildren();
          });
        });
      }
      renderChildren();

      addBtn.addEventListener("click", function () {
        children.push({ name: "", age: "", medical: "" });
        renderChildren();
      });

      // ---- submit + feedback ----
      var feedback = el("div", { style: "margin-top:12px" });
      var submit = el("button", { type: "button", class: "hc-btn", style: "margin-top:14px" }, "Confirm booking details");
      mountEl.appendChild(submit);
      mountEl.appendChild(feedback);

      submit.addEventListener("click", function () {
        var submission = {
          contact: {
            name: valOf(mountEl, "hc-cd-pname"),
            email: valOf(mountEl, "hc-cd-pemail"),
            phone: valOf(mountEl, "hc-cd-pphone")
          },
          children: children.slice()
        };
        var result = validateSubmission(submission, camp);
        feedback.innerHTML = "";

        if (!result.ok) {
          feedback.appendChild(banner(
            "Please fix the following:",
            result.errors,
            "#9a1f5e",
            "var(--pink-tint,#FCE8F0)"
          ));
          return;
        }

        var saved = saveBooking(result.record);
        var lines = result.record.children.map(function (c) {
          return esc(c.name) + " (age " + c.age + ") — " +
            (c.hasMedical ? "medical: " + esc(c.medical) : "no medical notes");
        });
        feedback.appendChild(banner(
          "Booking details captured" + (saved ? " (ref " + esc(saved.id) + ")" : "") + ":",
          lines,
          "#2f7d4f",
          "#E1F0E4"
        ));
        if (result.warnings.length) {
          feedback.appendChild(banner("Heads up:", result.warnings, "#7a5b00", "#FFF6D6"));
        }
        if (HC.util && HC.util.toast) HC.util.toast("Child details saved ✓");
      });
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Could not render checkout form: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ---- tiny DOM helpers (string-based, escaped) ---- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fieldGroupStyle() {
    return "border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:14px;margin:0 0 14px;background:var(--purple-tint,#F7F3FA)";
  }
  function legendStyle() {
    return "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px;margin:0 0 8px";
  }
  function labelStyle() {
    return "display:block;font-size:12px;font-weight:700;color:var(--text,#383838);margin:8px 0 4px;font-family:Quicksand,system-ui,sans-serif";
  }
  function inputBaseStyle() {
    return "width:100%;box-sizing:border-box;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;padding:9px 11px;font-size:14px;font-family:inherit;background:#fff";
  }
  function textareaStyle() { return inputBaseStyle() + ";resize:vertical;min-height:48px"; }
  function row(inner) { return '<div style="display:flex;gap:10px;flex-wrap:wrap">' + inner + "</div>"; }
  function input(id, label, type) {
    return '<label style="' + labelStyle() + ';flex:1;min-width:140px">' + esc(label) +
      '<input id="' + esc(id) + '" type="' + esc(type) + '" style="' + inputBaseStyle() + '"></label>';
  }
  function labelledInput(idKey, label, type, value) {
    return '<label style="' + labelStyle() + ';flex:1;min-width:120px">' + esc(label) +
      '<input data-cd-id="' + esc(idKey) + '" type="' + esc(type) + '" value="' + esc(value) +
      '" style="' + inputBaseStyle() + '"></label>';
  }
  function valOf(root, id) {
    var n = root.querySelector("#" + id);
    return n ? n.value : "";
  }
  function banner(title, items, color, bg) {
    var ul = "<ul style=\"margin:6px 0 0;padding-left:18px;font-size:13px\">" +
      (items || []).map(function (i) { return "<li>" + i + "</li>"; }).join("") + "</ul>";
    return HC.util.el("div", {
      style: "background:" + bg + ";color:" + color + ";border-radius:12px;padding:10px 12px;margin-top:10px;" +
        "font-size:13.5px;font-family:'Nunito Sans',system-ui,sans-serif"
    }, '<strong>' + esc(title) + '</strong>' + ul);
  }

  /* ---------------------------------------------------------------------- *
   * selfTest — exercises the LOGIC and asserts the acceptance criterion.
   * ---------------------------------------------------------------------- */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var camp = { id: "test-camp", name: "Test Holiday Camp", ageMin: 5, ageMax: 12 };

    // 1. ACCEPTANCE CRITERION: a valid child carries name, age AND medical text.
    check("Checkout captures child name, age and a free-text medical/allergy field", function () {
      var r = validateChild({ name: "Ava Smith", age: "7", medical: "Nut allergy - carries EpiPen" }, camp);
      HC.assert(r.ok, "valid child should pass: " + r.errors.join("; "));
      HC.assert(r.normalised.name === "Ava Smith", "name not captured");
      HC.assert(r.normalised.age === 7, "age not captured as number 7, got " + r.normalised.age);
      HC.assert(r.normalised.medical === "Nut allergy - carries EpiPen", "medical free-text not captured");
      HC.assert(r.normalised.hasMedical === true, "hasMedical should flag a non-empty note");
    });

    // 2. Medical field is free-text and OPTIONAL (empty is allowed, flagged false).
    check("Medical/allergy field is optional free text", function () {
      var r = validateChild({ name: "Ben", age: 9, medical: "" }, camp);
      HC.assert(r.ok, "child with no medical note should still be valid");
      HC.assert(r.normalised.medical === "", "empty medical should normalise to empty string");
      HC.assert(r.normalised.hasMedical === false, "hasMedical should be false when blank");
    });

    // 3. Missing name is rejected.
    check("Missing child name is rejected", function () {
      var r = validateChild({ name: "   ", age: 8, medical: "asthma" }, camp);
      HC.assert(!r.ok, "blank name must fail");
      HC.assert(r.errors.join(" ").toLowerCase().indexOf("name") >= 0, "error should mention name");
    });

    // 4. Missing / non-numeric age is rejected.
    check("Missing or non-numeric age is rejected", function () {
      var r1 = validateChild({ name: "Cara", age: "", medical: "" }, camp);
      HC.assert(!r1.ok, "blank age must fail");
      var r2 = validateChild({ name: "Cara", age: "abc", medical: "" }, camp);
      HC.assert(!r2.ok, "non-numeric age must fail");
    });

    // 5. Age outside the camp band is accepted but WARNED (school-age framing).
    check("Age outside camp band produces a warning, not an error", function () {
      var r = validateChild({ name: "Dee", age: 16, medical: "none" }, camp); // camp is 5-12
      HC.assert(r.ok, "out-of-band age should still validate (warn only)");
      HC.assert(r.warnings.length === 1, "expected one age-band warning, got " + r.warnings.length);
      HC.assert(r.warnings[0].indexOf("5-12") >= 0, "warning should cite the 5-12 band");
    });

    // 6. Full submission: contact + multiple children, each with own medical note.
    check("Full checkout captures contact + multiple children with medical notes", function () {
      var sub = {
        contact: { name: "Parent One", email: "parent@example.com", phone: "07700 900000" },
        children: [
          { name: "Ava", age: "7", medical: "Nut allergy" },
          { name: "Ben", age: "9", medical: "" }
        ]
      };
      var res = validateSubmission(sub, camp);
      HC.assert(res.ok, "valid submission should pass: " + res.errors.join("; "));
      HC.assert(res.record.children.length === 2, "should capture both children");
      HC.assert(res.record.children[0].name === "Ava" && res.record.children[0].age === 7, "child 1 name/age");
      HC.assert(res.record.children[0].medical === "Nut allergy", "child 1 medical free-text captured");
      HC.assert(res.record.children[1].hasMedical === false, "child 2 has no medical note");
      HC.assert(res.record.contact.email === "parent@example.com", "contact email captured");
    });

    // 7. Submission with no children, or bad contact email, is rejected.
    check("Submission rejects empty child list and invalid email", function () {
      var r1 = validateSubmission({ contact: { name: "P", email: "p@x.com" }, children: [] }, camp);
      HC.assert(!r1.ok, "no children must fail");
      var r2 = validateSubmission({ contact: { name: "P", email: "not-an-email" }, children: [{ name: "A", age: 6 }] }, camp);
      HC.assert(!r2.ok, "invalid email must fail");
    });

    // 8. Persistence round-trip through HC.store (mock localStorage).
    check("Saving a booking persists the captured child details via HC.store", function () {
      var before = loadBookings().length;
      var rec = {
        campId: camp.id, campName: camp.name,
        contact: { name: "P", email: "p@x.com", phone: "" },
        children: [{ name: "Eli", age: 6, medical: "Hay fever", hasMedical: true }],
        savedAt: Date.now()
      };
      var saved = saveBooking(rec);
      HC.assert(saved && saved.id, "saveBooking should return an entry with an id");
      var all = loadBookings();
      HC.assert(all.length === before + 1, "store length should grow by 1");
      var last = all[all.length - 1];
      HC.assert(last.record.children[0].name === "Eli", "persisted child name");
      HC.assert(last.record.children[0].age === 6, "persisted child age");
      HC.assert(last.record.children[0].medical === "Hay fever", "persisted medical free-text");
      // tidy up so repeated runs don't grow the store unbounded
      try {
        var trimmed = all.slice(0, before);
        HC.store.set(STORE_KEY, trimmed);
      } catch (e) { /* ignore cleanup failure */ }
    });

    // 9. Runs against the LIVE directory: demoCamp yields a real age band.
    check("Validates against a live E17 directory camp age band", function () {
      var live = demoCamp();
      HC.assert(live && (live.name || live.id), "should pick a live camp");
      var band = ageBand(live);
      HC.assert(band.min <= band.max, "live camp should yield a sane age band");
      var r = validateChild({ name: "Test Child", age: band.min, medical: "test note" }, live);
      HC.assert(r.ok, "a child at the camp's min age should validate");
      HC.assert(r.normalised.medical === "test note", "medical captured against live camp");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------------------------------------------------------------- */
  HC.registerFeature({
    id: "parent-child-details",
    title: "Child details at checkout",
    side: "parent",
    icon: "🧒",
    summary: "Collects each child’s name and age plus a free-text allergies / medical box during checkout, validated against the camp’s age band — Happity’s booking-questions flow for school-age camps.",
    render: render,
    selfTest: selfTest
  });
})();
