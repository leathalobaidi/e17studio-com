#!/usr/bin/env node
/* Weekly link rot check for the holiday camp planner.
 * Extracts every external URL from camps.js, planner-data.js and index.html,
 * fetches each one, and fails if any are hard-dead (404/410/5xx or repeated
 * network failure). Bot-hostile responses (403/405/429) and known
 * bot-blocking domains are reported as warnings, not failures.
 *
 *   node holiday-camps/tests/check-links.mjs [--site-dir <path>]
 */
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const SITE = path.resolve(argVal("--site-dir") || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

const SKIP_DOMAINS = ["instagram.com", "facebook.com", "wa.me"]; // hard bot-blockers — skip entirely
const WARN_STATUS = new Set([401, 403, 405, 406, 429, 999]);     // likely bot-defence, not rot
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 (E17HolidayCampPlanner-linkcheck; +https://e17studio.com/holiday-camps/)";

const sources = ["assets/camps.js", "assets/planner-data.js", "index.html"]
  .map((f) => readFileSync(path.join(SITE, f), "utf8")).join("\n");
const urls = [...new Set((sources.match(/https?:\/\/[^\s"'<>\\)]+/g) || [])
  .map((u) => u.replace(/[",;]+$/, ""))
  .filter((u) => !u.includes("fonts.g") && !u.includes("w3.org") && !u.includes("e17studio.com")))]
  .sort();

const skipped = urls.filter((u) => SKIP_DOMAINS.some((d) => u.includes(d)));
const toCheck = urls.filter((u) => !skipped.includes(u));
console.log(`Checking ${toCheck.length} URLs (${skipped.length} skipped as bot-hostile)\n`);

async function probe(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UA, accept: "text/html,*/*" } });
      clearTimeout(timer);
      return { url, status: res.status };
    } catch (e) {
      if (attempt === 3) return { url, status: 0, err: String(e.cause?.code || e.message).slice(0, 60) };
      await new Promise((r) => setTimeout(r, 2500 * attempt));
    }
  }
}

const results = [];
const queue = [...toCheck];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) results.push(await probe(queue.shift()));
}));

const dead = results.filter((r) => r.status === 0 || r.status === 404 || r.status === 410 || r.status >= 500);
const warn = results.filter((r) => WARN_STATUS.has(r.status));
const fine = results.length - dead.length - warn.length;

console.log(`OK: ${fine}   warn (bot-defence?): ${warn.length}   DEAD: ${dead.length}\n`);
warn.forEach((r) => console.log(`  ⚠ ${r.status} ${r.url}`));
dead.forEach((r) => console.log(`  ✗ ${r.status || r.err} ${r.url}`));

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = [...dead.map((r) => `| ✗ DEAD | ${r.status || r.err} | ${r.url} |`),
                ...warn.map((r) => `| ⚠ warn | ${r.status} | ${r.url} |`)];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Holiday camps link check\n\n${fine} OK, ${warn.length} warnings, ${dead.length} dead of ${toCheck.length} checked.\n\n` +
    (rows.length ? `| state | status | url |\n|---|---|---|\n${rows.join("\n")}\n` : "All links healthy.\n"));
}

process.exit(dead.length ? 1 : 0);
