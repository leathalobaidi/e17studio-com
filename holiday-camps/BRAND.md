# E17 Kids — beta brand system

_Brand strategy + design system for the Walthamstow children's-activities planner._
_Prepared 14 June 2026. The implemented beta lives at `holiday-camps/` and `e17studio.com/holiday-camps/`._

---

## 1. Recommendation at a glance

| | Recommendation |
|---|---|
| **Master brand** | **E17 Kids** |
| **This product** | **E17 Kids — Holiday Camp Planner** |
| **Backup name** | **Walthamstow Kids** (register defensively, see §4) |
| **Tagline** | **Children's activities in Walthamstow & E17 — checked, compared, planned.** |
| **Trust signature** | _By a local parent, not a directory._ |
| **Domain route** | Stay on `e17studio.com/holiday-camps` for beta → buy `e17kids.co.uk` + `.com` now as insurance → migrate to **`e17kids.co.uk`** once demand is proven |

**Why this route:** "E17 Kids" is short, distinctive, ownable and emotionally local — the hallmarks of a *brand* rather than a *directory*. It sits naturally under the founder's existing **E17 Studio** identity, it expands cleanly from holiday camps to term-time clubs, baby classes, weekend activities and a paid-listings marketplace, and every candidate domain is currently free. Local SEO is handled by the page **title and headings** (which keep "Walthamstow", "E17" and "holiday camps"), *not* by the brand name — so we get distinctiveness **and** search relevance instead of trading one for the other.

---

## 2. The strategic question: should this stay "holiday camps"?

**No — the master brand should be broader.** Three reasons:

1. The product roadmap (term-time clubs, after-school, weekend classes, baby & toddler, HAF, SEND-friendly, childcare planning, local guides, paid listings) is a **local children's-activities marketplace**, not a holiday-camp page.
2. The founder is **already** building the next vertical — there is a term-time prototype in the repo (`holiday-camps2test/`). The brand needs to hold both.
3. A name baked to "holiday camps" caps the asset. "E17 Kids" lets *Holiday Camp Planner* be the first **product line** under a master brand, with *After-School Clubs*, *Baby & Toddler* and *Term-Time* slotting in later with zero rebrand.

**Brand architecture:** `E17 Kids` (master) → `Holiday Camp Planner` (product line, live now) → future: `After-School`, `Term-Time`, `Baby & Toddler`, `Weekends`.

---

## 3. Brand name — evaluation & decision

Scored High / Med / Low against the founder's criteria. SEO is **judgement, not measured** — the Ahrefs keyword API was gated ("Insufficient plan") on 14 Jun 2026, so no verified volumes were available; reasoning is based on standard search patterns (town-name + activity generally out-searches postcode + activity, but postcode carries local-identity weight).

| Name | Parent trust | Local SEO | Memorable | Domain | Expansion | Other verticals | Marketplace | Verdict |
|---|---|---|---|---|---|---|---|---|
| **E17 Kids** | High | Med–High | **High** | **High** | **High** | **High** | **High** | ✅ **Recommended master** |
| Walthamstow Kids | Med–High | **High** | Med | High | High | High | Med | ⭐ Backup / defensive |
| E17 Kids Planner | High | Med | High | High | Med | Med | Med | Good, but "Planner" caps a marketplace |
| Walthamstow Kids Planner | Med | High | Low | High | Med | Med | Low | Descriptive, long, directory-ish |
| E17 Holiday Camp Planner _(current)_ | High | High (for camps) | Med | n/a | **Low** | **Low** | Low | Too narrow to be the master |
| Walthamstow Holiday Camps | Med | **High** | Low | High | **Low** | Low | Low | Pure SEO string, not a brand |
| Camp Compass E17 | Med | Low | Med | — | Low | Low | Med | Cute; ties to "camps"; weak local signal |
| E17 Family / E17 Family Planner | Med | Low | Med | High | High | High | Med | "Family" drifts from the kids-activity core |
| Local Kids E17 / Mini E17 | Med | Low | Med | High | Med | Med | Med | Weaker, more generic |

**Decision: E17 Kids.** It is the only option that scores well on *every* axis. The one place it trails ("Walthamstow" reads clearer to total newcomers and likely out-searches "E17" on raw volume) is fully recovered by the SEO copy in the title/H1 and by registering `walthamstowkids.co.uk` defensively.

**Name-collision check (14 Jun 2026):** a web search surfaced **no** existing "E17 Kids" business; the competitors that exist are generic national directories (ClubHub UK, ClassForKids, all4kids, the Waltham Forest Directory) — exactly what the positioning differentiates against. Combined with all domains being free, the name is clear to adopt. **Founder to do** the standard final checks: UK IPO trade-mark search and Instagram/Facebook handle availability (`@e17kids`).

---

## 4. Domain strategy

**Availability verified via the GoDaddy domains API on 14 June 2026 — all of the following were AVAILABLE** (re-confirm at point of purchase; availability changes):

| Domain | Status (14 Jun 2026) | Role |
|---|---|---|
| `e17kids.co.uk` | ✅ Available | **Primary — buy now** |
| `e17kids.com` | ✅ Available | **Buy now** (defensive + email) |
| `walthamstowkids.co.uk` | ✅ Available | **Buy now** (backup name + SEO) |
| `walthamstowkids.com` | ✅ Available | Optional defensive |
| `e17kidsplanner.co.uk` | ✅ Available | Optional |
| `e17family.co.uk` | ✅ Available | Optional (if "family" ever wins) |
| `e17kids.org.uk` | ✅ Available | Optional defensive |
| `localkidse17.co.uk` | ✅ Available | Not recommended |

**Three-stage plan:**

1. **Beta (now):** keep the product at **`e17studio.com/holiday-camps`**. It is already indexed, GitHub-Pages-hosted, zero migration risk, and the rebrand-in-place (this PR) is enough to look like a real product.
2. **Insurance (this week, ~£20–40 total):** register `e17kids.co.uk` + `e17kids.com` + `walthamstowkids.co.uk`. Park them or 301-redirect to the live page. This is cheap and stops anyone else taking the name once you start telling parents about it.
3. **Migrate (once demand is proven** — e.g. repeat traffic, newsletter sign-ups, or the first paid listing**):** move the product to **`e17kids.co.uk`** as its own home: planner at the root, `e17kids.co.uk/holiday-camps`, `e17kids.co.uk/after-school`, etc. Keep a permanent 301 from `e17studio.com/holiday-camps` so no traffic or link equity is lost.

**Rejected:** a subdomain (`kids.e17studio.com`) as the *destination* — it keeps the product tethered to the agency brand and is weaker for a standalone marketplace. Fine only as a throwaway intermediate; skip it and go straight to the apex domain when you move.

---

## 5. Positioning

> **E17 Kids** is the local planning tool that helps Walthamstow and E17 parents **find, compare and organise children's activities** — holiday camps now, clubs and classes next — with dates, prices, ages and funding **checked by a local parent**, not scraped into a generic directory.

It is: local · trusted · verified · practical · parent-built · time-saving · cost-aware · **not** a generic directory · designed for Walthamstow families.

---

## 6. Tone of voice

Simple British English. Useful before clever. Parent-to-parent, warm but not childish. Plain about what's checked and what isn't. No corporate waffle, no exaggerated claims, no American spelling.

**Avoid:** overly cute language · generic startup-speak · American spelling (it's "mum", "neighbourhood", "organise") · over-designed mum-blog aesthetic · cheap-directory feel · AI marketing fluff.

**Examples**
- ✅ "Every holiday camp in and around E17 — with verified dates, prices and free council-funded places."
- ✅ "Camps still change plans and sell out, so always confirm before you book."
- ❌ "Discover the ultimate one-stop solution for your little ones' summer adventures!"

---

## 7. Visual identity & design system

**Feel:** a Walthamstow summer fete / local noticeboard / school timetable — warm paper, green ink, marigold and tomato accents, friendly editorial type, honest planner cards. Premium enough to trust, playful enough for families. **Not** a cheap affiliate page, SEO landing page, nursery brand, toy shop, council website or Silicon-Valley app.

**Type:** **Fraunces** (display, warm editorial serif) · **Atkinson Hyperlegible** (body — chosen for legibility, an accessibility win).

**Design tokens** (in `assets/styles.css` `:root`; semantic aliases + spacing scale added this PR):

| Token | Value | Use |
|---|---|---|
| `--ink` / `--ink-soft` / `--muted` | `#1d2b22` / `#44544b` / `#5f6e66` | Text (primary / secondary / tertiary) |
| `--paper` / `--panel` | `#faf5e9` / `#fffdf6` | Page background / card surface |
| `--line` / `--line-strong` | `#ded8c4` / `#c9c2aa` | Borders |
| `--green` / `--green-deep` / `--green-tint` | `#1e5e46` / `#14402f` / `#e4eee6` | **Primary** brand colour |
| `--marigold` / `--marigold-deep` / `--marigold-tint` | `#f4b942` / `#9a6a10` / `#fdf0d3` | **Secondary** / warmth / warning |
| `--tomato` / `--tomato-bright` / `--tomato-tint` | `#c93e20` / `#e2502f` / `#fbe9e2` | Accent / danger / shortlist |
| `--sky` / `--sky-deep` | `#cfe7e3` / `#145f63` | Info accent |
| `--plum` | `#7c4070` | SEND badge |
| `--color-success/warning/info/danger` | aliases → green/marigold-deep/sky-deep/tomato | Semantic naming |
| `--space-1…8` | 4 → 64px | Spacing scale |
| `--radius` / `--radius-sm` | 14px / 9px | Corner radius |
| `--shadow-pop` / `--shadow-soft` | offset hard shadow / soft | "Stuck-on-the-noticeboard" vs lifted |

**Contrast:** body and heading text are dark ink on paper/panel (well above WCAG AA). Badges use dark text on light tints. Status is **never colour-only** — every badge and the verification label carry text (e.g. "Confirmed", "HAF", "Ofsted").

---

## 8. Logo / brand mark

**The "E17" stamp tile** — a rounded square (calendar/timetable square + local noticeboard stamp), green with a cream "E17" and a small marigold "summer-fete sun" dot in the corner. It reads as *planning + local + trusted + summer* in one mark, and is deliberately implementable in CSS and a tiny SVG (no illustration).

- **Header logo:** tile + "E17 Kids" wordmark + "Holiday Camp Planner" product label (pure CSS, `.brand` lockup).
- **Favicon / avatar / mobile icon:** `favicon.svg` — the tile alone (the green block + marigold dot carry recognition even at 16px).
- **Small trust mark:** the tile reused in the footer brand block.

Lockup rule: **mark + "E17 Kids"** is the brand; the product name ("Holiday Camp Planner") is a smaller label beneath, swappable per product line.

---

## 9. UI components, badges & verification labels

Existing components (cards, filters, planner grid, budget cards, picker dialog) are kept — they're the product's real value. Branding additions this PR:

- **Buttons:** solid (marigold, primary CTA), ghost (outline), danger (tomato), book (ink), add (green) — all with visible `:focus-visible` rings and ≥42–46px tap targets.
- **Badges:** HAF (green), Tax-Free Childcare (sky), Ofsted (marigold), sibling (tomato), SEND (plum), food, **Confirmed** (solid green), TBC (grey). Each is text + colour, never colour alone.
- **Verification labels:** the **Confirmed** badge = "seen on an official source on the checked date". The editorial section (§10) defines this in plain English on-page.
- **Proof chips** (new): hero trust row — "Checked June 2026 / Built by a Walthamstow parent / Prices & hours shown upfront".
- **Trust cards** (new): the "How we check information" grid, incl. a marigold correction card.

---

## 10. Trust & editorial policy (on-page: "How we check information")

Implemented as a dedicated section + footer copy:

- **What we do** — read provider websites, booking pages, council listings and public social media; record dates, prices, hours, ages, funding; link back to sources.
- **What "verified" means** — a Confirmed badge = seen on an official source on the date shown; confirm with the provider before booking.
- **Independent & free** — not affiliated with any provider; **any future paid/featured listing will be clearly labelled as an advert, never dressed up as a recommendation.**
- **Spot something wrong?** — one-click `mailto:` correction/listing link (pre-filled subject + body).
- **Last-checked date** and **source links** are already shown throughout.

---

## 11. Commercial model (monetise without breaking trust)

The brand can carry, in roughly this order, **provided the trust wall holds**:

1. **Free listings** (default — grows the directory).
2. **Verified provider profiles** (claim-your-listing; richer info).
3. **Featured placements** — *must* be visually labelled "Ad"/"Featured" and excluded from default relevance sorting.
4. **Sponsorship** of a section or the newsletter (labelled).
5. **Booking referral links** (disclosed).
6. **Premium planning tools** (multi-term planner, reminders).
7. **Local family newsletter** ("E17 Kids weekly").
8. **Term-time club database** (next vertical).
9. **Baby & toddler activity guide.**

**Hard rule (already stated on-page):** paid listings never look like editorial recommendations. Labelling is non-negotiable — it *is* the moat.

---

## 12. Metadata / SEO

- **Title:** `Walthamstow & E17 Holiday Camps 2026 — Compare & Plan | E17 Kids`
- **Description:** verified dates/prices/hours/ages/HAF + "Checked by a local parent".
- **OG/Twitter:** branded `og:site_name = E17 Kids`, summary_large_image, banner image.
- Naturally targets: _Walthamstow holiday camps, E17 holiday clubs, Walthamstow summer camps, Waltham Forest HAF, Walthamstow kids activities_ — in headings and body, **not** keyword-stuffed. Future verticals add _after-school clubs Walthamstow_, _baby classes Walthamstow_.
- Consider adding `Event`/`ItemList` structured data later for rich results (not in this beta PR).

---

## 13. What this PR implements

See the PR description / commit. In short: rebrand to **E17 Kids — Holiday Camp Planner** across the page (title, meta, OG/Twitter, header lockup, hero, footer, print pack, calendar export, copy-summary); add the **proof-point** hero row, the **"How we check information"** editorial section, a **correction** mechanism, a CSS **brand mark + favicon.svg**, consolidated **design tokens** (semantic aliases + spacing scale), and **mobile header** polish — with **no change to the planner's data or functionality**.

---

## 14. Open decisions for the founder

1. **Commit to the name?** Recommended: yes, **E17 Kids**. Do the IPO trade-mark + `@e17kids` social-handle check first.
2. **Buy the domains?** Recommended: `e17kids.co.uk` + `.com` + `walthamstowkids.co.uk` now (cheap insurance), even while staying on `e17studio.com/holiday-camps`.
3. **Working-copy sync:** these presentation changes were made in the deploy repo (`~/e17studio-com`). The next *data* refresh deploys from `~/Documents/E17 Holiday Camp` via `tools/deploy.mjs` — **mirror this branch's `index.html`, `assets/styles.css`, `assets/app.js` and `favicon.svg` back into that working copy after merge**, or the next data deploy will revert the rebrand. (Happy to do this as a follow-up.)
4. **Branded OG/social card (optional):** the current OG image is the photo banner. A dedicated 1200×630 card with the wordmark would sharpen link-shares; and a 180×180 PNG `apple-touch-icon` + 512 maskable PNG would complete the icon set for iOS/Android home-screen.
5. **When to migrate** off `e17studio.com` — trigger on proven demand (traffic / sign-ups / first paid listing), not before.
