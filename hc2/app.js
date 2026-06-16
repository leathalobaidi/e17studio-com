/* HolidayCamp mockup — Happity playbook + E17 planner, on live camp data.
   Sign-in & bookings are SIMULATED (localStorage). No backend, no real accounts/payments. */

const DIR = (window.E17_DIRECTORY && window.E17_DIRECTORY.providers) || [];
const PL  = (window.E17_PLANNER) || { byId:{}, weeks:[], keyDates:{} };
const WEEKS = PL.weeks || [];
const KEY = PL.keyDates || {};
const plannerOf = p => (PL.byId && PL.byId[p.id]) || {};

/* ---------- helpers ---------- */
const THEMES = [
  {k:["drama","theatre","perform"], e:"🎭", g:["#F0E8F4","#E5D2F0"]},
  {k:["dance","ballet"],            e:"💃", g:["#FCE8F0","#F7D2E6"]},
  {k:["art","craft","creative","make","fashion"], e:"🎨", g:["#FFF3D6","#FCE8C0"]},
  {k:["forest","outdoor","nature","adventure","sustain"], e:"🌲", g:["#E1F0E4","#CDE7D6"]},
  {k:["music","sing","song"],       e:"🎵", g:["#E6EEFB","#D5E4F7"]},
  {k:["science","stem","tech","lego","code","coding"], e:"🔬", g:["#E6EEFB","#DCE9F6"]},
  {k:["sport","football","multi-activity","active","tennis","gym","martial","swim"], e:"⚽", g:["#E1F0E4","#D2E9DB"]},
  {k:["cook","food","chef"],        e:"👩‍🍳", g:["#FFF3D6","#FBE6C4"]},
  {k:["haf","free","council"],      e:"🍎", g:["#FCE8F0","#F4D7E6"]},
  {k:["childcare","playscheme","play","early years"], e:"🧸", g:["#F0E8F4","#E7D6F2"]},
];
function theme(p){
  const hay=((p.categories||[]).join(" ")+" "+(p.kind||"")+" "+(p.name||"")).toLowerCase();
  for(const t of THEMES){ if(t.k.some(w=>hay.includes(w))) return t; }
  return {e:"⭐", g:["#F0E8F4","#E5D6F0"]};
}
const isFree = p => (p.funding||[]).some(f=>/free|haf/i.test(f));
const hasTFC = p => (p.funding||[]).includes("Tax-Free Childcare") || plannerOf(p).tfc;
const hasSibling = p => (p.funding||[]).includes("Sibling discount");
const hasSEND = p => (p.categories||[]).includes("SEND aware") || plannerOf(p).sendAware;
const mealsIncl = p => { const l=plannerOf(p).lunch; return l && l.policy==="included"; };
const isWorking = p => plannerOf(p).coverage==="working";
const money = n => "£"+(Number.isInteger(n)?n:n.toFixed(2));

function minDayPrice(p){
  const pr = plannerOf(p).price || {};
  if(Number.isFinite(pr.day)) return pr.day;
  if(Number.isFinite(pr.week)) return Math.round(pr.week/5);
  if(pr.weekByWeek){ const v=Object.values(pr.weekByWeek).filter(Number.isFinite); if(v.length) return Math.round(Math.min(...v)/5); }
  return null;
}
function runsWeek(p,wid){
  const pl=plannerOf(p);
  if((pl.weeks||[]).includes(wid)) return "yes";
  if(pl.weeksLikely || pl.haf || pl.plannerRole==="route") return "maybe";
  return "no";
}
function runsDay(p,day){ // day 1=Mon..5=Fri
  const pl=plannerOf(p);
  if(pl.dayPattern){ return Object.values(pl.dayPattern).some(arr=>arr.includes(day)); }
  return true; // assume Mon–Fri unless a pattern says otherwise
}
function priceFact(p){
  if(isFree(p)) return "Free (HAF, if eligible)";
  const pr=plannerOf(p).price||{}; const bits=[];
  if(Number.isFinite(pr.day)) bits.push(money(pr.day)+"/day");
  if(Number.isFinite(pr.dayExtended)) bits.push(money(pr.dayExtended)+"/ext day");
  if(Number.isFinite(pr.week)) bits.push(money(pr.week)+"/wk");
  if(!bits.length) return (p.price||"Check provider").replace(/GBP/g,"£").slice(0,40);
  return bits.join(" · ");
}
function badgeRow(p){
  const pl=plannerOf(p), f=p.funding||[], b=[]; const wk=pl.weeks||[];
  if(wk.length) b.push(`<span class="badge badge-confirmed">2026 dates ✓ wk ${wk.filter(w=>w<=6).join("·")}</span>`);
  else if(pl.weeksLikely||pl.haf) b.push(`<span class="badge badge-tbc">Dates TBC</span>`);
  if(f.includes("Free/HAF")) b.push(`<span class="badge badge-haf">HAF free places</span>`);
  if(hasTFC(p)) b.push(`<span class="badge badge-tfc">Tax-Free Childcare</span>`);
  if(pl.ofsted) b.push(`<span class="badge badge-ofsted">Ofsted-registered</span>`);
  if(hasSibling(p)) b.push(`<span class="badge badge-sibling">Sibling discount</span>`);
  if(hasSEND(p)) b.push(`<span class="badge badge-send">SEND aware</span>`);
  if(mealsIncl(p)) b.push(`<span class="badge badge-food">Meals included</span>`);
  return b.join("");
}
const truncate=(s,n)=>{s=s||"";return s.length>n?s.slice(0,n-1).trim()+"…":s;};
const bookUrl=p=>(p.source&&p.source.url)||"#";
const FEATURED = DIR.filter(p=>!isFree(p)).slice(0,2).map(p=>p.id);

/* ---------- state ---------- */
const state = {
  view:"find", tab:"find",
  flags:new Set(),
  session: JSON.parse(localStorage.getItem("hc_session")||"null"),
  saved: new Set(JSON.parse(localStorage.getItem("hc_saved")||"[]")),
};
const persist=()=>{ localStorage.setItem("hc_session",JSON.stringify(state.session));
                    localStorage.setItem("hc_saved",JSON.stringify([...state.saved])); };
const $=id=>document.getElementById(id);

/* ---------- filtering ---------- */
function matches(p){
  const q=$("q").value.trim().toLowerCase();
  if(q && !JSON.stringify(p).toLowerCase().includes(q)) return false;
  const cat=$("fCat").value; if(cat && !(p.categories||[]).includes(cat)) return false;
  const area=$("fArea").value; if(area && !((p.areas||[p.area]).includes(area))) return false;
  const age=$("fAge").value; if(age){ const[lo,hi]=age.split("-").map(Number); if(p.ageMax<lo||p.ageMin>hi) return false; }
  const wk=$("fWeek").value; if(wk){ if(runsWeek(p,+wk)==="no") return false; }
  const day=$("fDay").value; if(day && !runsDay(p,+day)) return false;
  const pmax=$("fPrice").value; if(pmax){ const m=minDayPrice(p); if(m!=null && m>+pmax) return false; }
  for(const fl of state.flags){
    if(fl==="free"&&!isFree(p))return false;
    if(fl==="tfc"&&!hasTFC(p))return false;
    if(fl==="sibling"&&!hasSibling(p))return false;
    if(fl==="send"&&!hasSEND(p))return false;
    if(fl==="ofsted"&&!plannerOf(p).ofsted)return false;
    if(fl==="meals"&&!mealsIncl(p))return false;
    if(fl==="working"&&!isWorking(p))return false;
  }
  return true;
}
function filtered(){
  return DIR.filter(matches).sort((a,b)=>(FEATURED.includes(b.id)?1:0)-(FEATURED.includes(a.id)?1:0));
}

/* ---------- card + directory ---------- */
function card(p){
  const t=theme(p), feat=FEATURED.includes(p.id), on=state.saved.has(p.id);
  return `<article class="card" data-open="${p.id}">
    <div class="media" style="background:linear-gradient(135deg,${t.g[0]},${t.g[1]})">
      ${feat?`<div class="ribbon"><span class="star">★</span> Featured</div>`:""}
      <button class="heart ${on?'on':''}" data-save="${p.id}" title="Save">${on?'♥':'♡'}</button>
      <span class="emoji">${t.e}</span>
    </div>
    <div class="card-body">
      <h3 class="card-title">${p.name}</h3>
      <div class="card-kind">${p.kind||""}${p.area?` · ${p.area}`:""}</div>
      <div class="badges">${badgeRow(p)}</div>
      <ul class="meta">
        <li><span class="mi">🎂</span><span>Ages ${(p.ageLabel||"").replace(/ages?\s*/i,"")||`${p.ageMin}–${p.ageMax}`}</span></li>
        <li><span class="mi">💷</span><span>${priceFact(p)}</span></li>
        <li><span class="mi">📍</span><span>${truncate(p.venue||p.address,42)}</span></li>
      </ul>
    </div>
    <div class="card-foot"><a class="btn" href="${bookUrl(p)}" target="_blank" rel="noopener" data-stop>Book now</a></div>
  </article>`;
}
function renderFind(){
  const list=filtered();
  $("grid").innerHTML=list.map(card).join("")||`<p style="color:var(--muted);grid-column:1/-1">No camps match — try clearing a filter.</p>`;
  $("count").textContent=`${list.length} camp${list.length!==1?"s":""}`;
}

/* ---------- planner view ---------- */
function renderPlanner(){
  const list=filtered();
  const dates = KEY.lastSchoolDay ? `<div class="datesbar">📌 <b>Summer holidays:</b> most Waltham Forest schools break up <b>${KEY.lastSchoolDay.label}</b> and return <b>${KEY.backToSchool?KEY.backToSchool.label:"early Sep"}</b>. Tap a camp to see details.</div>`:"";
  const legend=`<div class="legend"><span><span class="yes">✓</span> Confirmed 2026 dates</span><span><span class="maybe">~</span> Runs summer — week TBC</span><span>Blank = not this week</span></div>`;
  const head=`<tr><th class="camp">Camp</th>${WEEKS.map(w=>`<th>${w.label}<small>${w.dates}</small></th>`).join("")}</tr>`;
  const rows=list.map(p=>{
    const cells=WEEKS.map(w=>{const r=runsWeek(p,w.id);return `<td>${r==="yes"?'<span class="yes">✓</span>':r==="maybe"?'<span class="maybe">~</span>':''}</td>`;}).join("");
    return `<tr data-open="${p.id}"><td class="camp">${p.name}<small>${truncate(p.kind||"",30)} · ${priceFact(p)}</small></td>${cells}</tr>`;
  }).join("");
  $("plannerView").innerHTML=`${dates}${legend}<div class="planner-wrap"><table class="planner"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  $("count").textContent=`${list.length} camp${list.length!==1?"s":""} · ${WEEKS.length} weeks`;
}
function renderBrowse(){ if(state.tab==="find"){renderFind();$("findView").classList.remove("hidden");$("plannerView").classList.add("hidden");$("resTitle").textContent="Holiday camps near E17";}
                         else {renderPlanner();$("plannerView").classList.remove("hidden");$("findView").classList.add("hidden");$("resTitle").textContent="Your summer, week by week";} }

/* ---------- camp detail modal ---------- */
function openCamp(id){
  const p=DIR.find(x=>x.id===id); if(!p)return; const t=theme(p), pl=plannerOf(p), on=state.saved.has(p.id);
  const wks=(pl.weeks||[]).map(id=>{const w=WEEKS.find(x=>x.id===id);return w?w.dates:null;}).filter(Boolean);
  const hours = pl.hours ? `${pl.hours.start}–${pl.hours.end}${pl.hours.extStart?` (wrap-around ${pl.hours.extStart}–${pl.hours.extEnd})`:""}` : (p.hours||"Check provider");
  modal(`<div class="dhead" style="background:linear-gradient(135deg,${t.g[0]},${t.g[1]})"><span class="emoji">${t.e}</span></div>
    <button class="x" data-close>×</button>
    <div class="dbody">
      <h2>${p.name}</h2>
      <div class="card-kind" style="margin-bottom:10px">${p.kind||""}${p.area?` · ${p.area}`:""}</div>
      <div class="badges" style="margin-bottom:14px">${badgeRow(p)}</div>
      <p style="color:var(--text);font-size:15px">${p.summary||p.goodFor||""}</p>
      <ul class="meta" style="margin:14px 0">
        <li><span class="mi">🎂</span><span>Ages ${(p.ageLabel||"").replace(/ages?\s*/i,"")||`${p.ageMin}–${p.ageMax}`}</span></li>
        <li><span class="mi">🕘</span><span>${hours}</span></li>
        <li><span class="mi">💷</span><span>${priceFact(p)}${pl.priceBasis?` — <span style="color:var(--muted)">${pl.priceBasis}</span>`:""}</span></li>
        <li><span class="mi">📍</span><span>${p.address||p.venue||""}</span></li>
        ${wks.length?`<li><span class="mi">📅</span><span>Confirmed weeks: ${wks.join("; ")}</span></li>`:""}
      </ul>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
        <a class="btn" href="${bookUrl(p)}" target="_blank" rel="noopener">Book now</a>
        <button class="btn btn-ghost" data-save="${p.id}">${on?"♥ Saved":"♡ Save camp"}</button>
      </div>
      ${p.source?`<p class="auth note" style="text-align:left">Source: <a href="${p.source.url}" target="_blank" rel="noopener">${p.source.label}</a>${p.confidence?` · ${p.confidence}`:""}</p>`:""}
    </div>`);
}

/* ---------- auth (simulated) ---------- */
function renderAuth(){
  const a=$("authArea");
  if(state.session){
    const s=state.session, initial=(s.name||"U").trim()[0].toUpperCase();
    a.innerHTML=`<button class="acct-chip" id="acctBtn"><span class="avatar">${initial}</span>${s.name.split(" ")[0]} ▾</button>`;
    $("acctBtn").onclick=toggleMenu;
  } else {
    a.innerHTML=`<button class="linkbtn" data-auth="login">Log in</button> <button class="btn btn-sm" data-auth="signup">Sign up</button>`;
  }
}
function toggleMenu(){
  let m=$("acctMenu"); if(m){m.remove();return;}
  const s=state.session;
  const html=`<div class="menu" id="acctMenu">
    <button data-view="saved">♥ Saved camps (${state.saved.size})</button>
    ${s.role==="provider"?`<button data-view="dash">📊 Provider dashboard</button>`:`<button data-auth="provider">＋ List my camp</button>`}
    <div class="sep"></div>
    <button id="logoutBtn">Log out</button></div>`;
  document.body.insertAdjacentHTML("beforeend",html);
  $("logoutBtn").onclick=()=>{state.session=null;persist();$("acctMenu").remove();renderAuth();setView("find");};
}
function openAuth(mode){
  const provider = mode==="provider";
  const sso=(cls,icon,label)=>`<button class="sso ${cls}" data-sso="${label}"><span class="g">${icon}</span> Continue with ${label}</button>`;
  modal(`<button class="x" data-close>×</button>
    <div class="auth">
      <div class="mascot">⛺</div>
      <h2>${provider?"List your camp":(mode==="signup"?"Create your account":"Welcome back")}</h2>
      <p class="s">${provider?"Reach thousands of local parents — free to list.":"Save camps and plan your summer in seconds."}</p>
      <div class="seg"><button class="${mode!=='login'?'active':''}" data-mode="signup">Sign up</button><button class="${mode==='login'?'active':''}" data-mode="login">Log in</button></div>
      ${sso("apple","","Apple")}
      ${sso("google","G","Google")}
      ${sso("facebook","f","Facebook")}
      <div class="divider">or</div>
      <div class="field"><input id="authName" placeholder="Your name" /></div>
      <div class="field"><input id="authEmail" type="email" placeholder="Email address" /></div>
      <button class="btn" style="width:100%" id="authEmailBtn">Continue with email</button>
      <p class="note">🔒 Demo sign-in — this is a local prototype. No real account is created, nothing is sent, no password needed.</p>
    </div>`);
  modalRoot.dataset.provider = provider?"1":"";
}
function doLogin(name, via){
  const provider = modalRoot.dataset.provider==="1";
  state.session={ name:name||"Guest Parent", via, role:provider?"provider":"parent" };
  persist(); closeModal(); renderAuth();
  setView(provider?"dash":"find");
}

/* ---------- providers view ---------- */
function renderProviders(){
  $("providersView").innerHTML=`
    <h2>Get your camp in front of E17 parents</h2>
    <p class="lead">List your holiday camp for <strong>free</strong> and reach thousands of local families searching right now. Take all the hassle out of admin — led by human beings, never robots.</p>
    <div class="pricing">
      <div class="price-card"><h3>Free</h3><div class="amt">£0</div>
        <ul><li>Full camp listing</li><li>Appear in search &amp; planner</li><li>Link to your booking page</li><li>"Listed on HolidayCamp" badge</li></ul>
        <button class="btn btn-ghost" data-auth="provider">List for free</button></div>
      <div class="price-card featured"><h3>Membership</h3><div class="amt">£8<small>/mo</small></div>
        <ul><li>Everything in Free</li><li>Priority in search results</li><li>Photo gallery + rich profile</li><li>Booking widget for your site</li><li>Customer messaging</li></ul>
        <button class="btn" data-auth="provider">Start membership</button></div>
      <div class="price-card"><h3>Bookings</h3><div class="amt">2.5%<small>+VAT</small></div>
        <ul><li>Take bookings on HolidayCamp</li><li>One of the lowest fees around</li><li>Instant payouts via Stripe</li><li>Registers &amp; attendance</li></ul>
        <button class="btn btn-ghost" data-auth="provider">Take bookings</button></div>
      <div class="price-card"><h3>Featured</h3><div class="amt">1p<small>/view</small></div>
        <ul><li>Top of search with a ★ banner</li><li>Pay only when shown</li><li>Set your own daily budget</li><li>~6× more clicks</li></ul>
        <button class="btn btn-ghost" data-auth="provider">Promote my camp</button></div>
    </div>
    <div class="panel">
      <h3>Add your camp <span style="font-weight:600;color:var(--muted);font-size:13px">(demo form)</span></h3>
      <div class="field"><label>Camp name</label><input placeholder="e.g. Sunshine Drama Camp"/></div>
      <div class="field"><label>Area</label><input placeholder="e.g. Leyton, E10"/></div>
      <div class="field"><label>Age range</label><input placeholder="e.g. 5–11"/></div>
      <div class="field"><label>Price per day</label><input placeholder="e.g. £40"/></div>
      <div class="field"><label>About your camp</label><textarea rows="3" placeholder="What makes it great…"></textarea></div>
      <button class="btn" data-auth="provider">Submit &amp; create account</button>
    </div>
    <div class="panel">
      <h3>Your free promo badge</h3>
      <p style="font-size:14px;color:var(--text)">Members display this on their own website — every badge links back and boosts your search ranking (just like Happity's badge tactic).</p>
      <div class="badge-embed">⛺ Listed on HolidayCamp <span class="b-star">★</span></div>
      <div class="codebox">&lt;a href="https://holidaycamp.uk/c/your-camp"&gt;&lt;img src="badge.svg" alt="Listed on HolidayCamp"&gt;&lt;/a&gt;</div>
    </div>`;
}

/* ---------- saved view ---------- */
function renderSaved(){
  if(!state.session){ $("savedView").innerHTML=`<h2>Saved camps</h2><p class="lead">Log in to save camps and build your shortlist.</p><button class="btn" data-auth="login">Log in</button>`; return; }
  const list=DIR.filter(p=>state.saved.has(p.id));
  $("savedView").innerHTML=`<h2>Your saved camps</h2><p class="lead">${list.length?`${list.length} camp${list.length!==1?"s":""} on your shortlist.`:"No saved camps yet — tap the ♡ on any camp."}</p><div class="grid">${list.map(card).join("")}</div>`;
}

/* ---------- provider dashboard ---------- */
function renderDash(){
  const mine=DIR.slice(0,3); // demo: pretend the provider owns the first 3
  $("dashView").innerHTML=`<h2>Provider dashboard</h2><p class="lead">Welcome back${state.session?`, ${state.session.name.split(" ")[0]}`:""} — here's how your camps are doing (demo data).</p>
    <div class="pricing">
      <div class="price-card"><h3>This week</h3><div class="amt">1,284</div><ul><li>Listing views</li></ul></div>
      <div class="price-card"><h3>Click-throughs</h3><div class="amt">96</div><ul><li>To your booking page</li></ul></div>
      <div class="price-card"><h3>Saves</h3><div class="amt">37</div><ul><li>Parents shortlisted you</li></ul></div>
    </div>
    <div class="panel"><h3>Your listings</h3>
      ${mine.map(p=>`<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)">
        <span style="font-size:24px">${theme(p).e}</span>
        <div style="flex:1"><strong style="color:var(--purple)">${p.name}</strong><br><span style="color:var(--muted);font-size:13px">${priceFact(p)}</span></div>
        <label class="chip"><input type="checkbox" style="accent-color:var(--magenta)"> Featured ★</label>
        <button class="btn btn-ghost btn-sm">Edit</button></div>`).join("")}
    </div>`;
}

/* ---------- view router ---------- */
function setView(v){
  state.view=v;
  const m=$("acctMenu"); if(m)m.remove();
  $("browse").classList.toggle("hidden", !(v==="find"||v==="planner"));
  $("providersView").classList.toggle("hidden", v!=="providers");
  $("savedView").classList.toggle("hidden", v!=="saved");
  $("dashView").classList.toggle("hidden", v!=="dash");
  document.querySelectorAll("#nav a").forEach(a=>a.classList.toggle("active", a.dataset.view===v || (v==="planner"&&a.dataset.view==="find")));
  if(v==="planner"){ state.tab="planner"; syncTabs(); renderBrowse(); }
  else if(v==="find"){ state.tab="find"; syncTabs(); renderBrowse(); }
  else if(v==="providers") renderProviders();
  else if(v==="saved") renderSaved();
  else if(v==="dash") renderDash();
  window.scrollTo({top:0,behavior:"smooth"});
}
function syncTabs(){ document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===state.tab)); }

/* ---------- modal plumbing ---------- */
const modalRoot=$("modalRoot");
function modal(inner){ modalRoot.innerHTML=`<div class="overlay" data-overlay><div class="dialog">${inner}</div></div>`; }
function closeModal(){ modalRoot.innerHTML=""; modalRoot.dataset.provider=""; }

/* ---------- filter population ---------- */
function uniqSorted(a){return [...new Set(a)].sort((x,y)=>x.localeCompare(y));}
function buildFilters(){
  uniqSorted(DIR.flatMap(p=>p.categories||[])).forEach(c=>$("fCat").insertAdjacentHTML("beforeend",`<option>${c}</option>`));
  uniqSorted(DIR.flatMap(p=>p.areas||[p.area]).filter(Boolean)).forEach(a=>$("fArea").insertAdjacentHTML("beforeend",`<option>${a}</option>`));
  [[0,4,"Under 5"],[5,7,"5–7"],[8,11,"8–11"],[12,16,"12+"]].forEach(a=>$("fAge").insertAdjacentHTML("beforeend",`<option value="${a[0]}-${a[1]}">${a[2]}</option>`));
  WEEKS.forEach(w=>$("fWeek").insertAdjacentHTML("beforeend",`<option value="${w.id}">${w.label} · ${w.dates}</option>`));
  [[1,"Mondays"],[2,"Tuesdays"],[3,"Wednesdays"],[4,"Thursdays"],[5,"Fridays"]].forEach(d=>$("fDay").insertAdjacentHTML("beforeend",`<option value="${d[0]}">${d[1]}</option>`));
  [25,35,45,55].forEach(v=>$("fPrice").insertAdjacentHTML("beforeend",`<option value="${v}">≤ £${v}/day</option>`));
  const FLAGS=[["free","🎟️ Free / HAF"],["tfc","💳 Tax-Free Childcare"],["sibling","👨‍👩‍👧 Sibling discount"],["send","🧩 SEND aware"],["ofsted","✅ Ofsted"],["meals","🍽️ Meals included"],["working","🕘 Working-hours"]];
  $("flagChips").innerHTML=FLAGS.map(f=>`<button class="chip" data-flag="${f[0]}"><span class="dot">+</span>${f[1]}</button>`).join("");
}

/* ---------- events ---------- */
function toggleSave(id){
  if(!state.session){ openAuth("login"); return; }
  if(state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
  persist();
  renderBrowse(); if(state.view==="saved") renderSaved();
  const m=$("acctMenu"); if(m){m.remove();}
}
document.addEventListener("click",e=>{
  const t=e.target.closest("[data-view],[data-auth],[data-flag],[data-tab],[data-open],[data-save],[data-close],[data-overlay],[data-sso],[data-mode]");
  if(!t){ const m=$("acctMenu"); if(m && !e.target.closest("#acctBtn")) m.remove(); return; }
  if(t.hasAttribute("data-stop")) return;            // let Book-now link work
  if(t.matches("[data-save]")){ e.stopPropagation(); toggleSave(t.dataset.save); return; }
  if(t.matches("[data-open]")){ if(e.target.closest("[data-save],[data-stop]"))return; openCamp(t.dataset.open); return; }
  if(t.matches("[data-close],[data-overlay]")){ if(t.matches("[data-overlay]")&&e.target!==t)return; closeModal(); return; }
  if(t.matches("[data-view]")){ const v=t.dataset.view; setView(v); return; }
  if(t.matches("[data-auth]")){ openAuth(t.dataset.auth); return; }
  if(t.matches("[data-mode]")){ openAuth(t.dataset.mode); return; }
  if(t.matches("[data-sso]")){ doLogin(t.dataset.sso==="Apple"?"Apple User":t.dataset.sso==="Google"?"Google User":"Facebook User", t.dataset.sso); return; }
  if(t.matches("[data-flag]")){ const f=t.dataset.flag; if(state.flags.has(f)){state.flags.delete(f);t.classList.remove("active");} else {state.flags.add(f);t.classList.add("active");} renderBrowse(); return; }
  if(t.matches("[data-tab]")){ state.tab=t.dataset.tab; syncTabs(); renderBrowse(); return; }
});
document.addEventListener("click",e=>{ if(e.target.id==="authEmailBtn"){ doLogin($("authName").value||"Guest Parent","email"); } });
["q","fCat","fArea","fAge","fWeek","fDay","fPrice"].forEach(id=>{
  const el=$(id); el.addEventListener(id==="q"?"input":"change",renderBrowse);
});

/* ---------- boot ---------- */
buildFilters();
renderAuth();
setView("find");
