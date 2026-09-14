/* Liquidity MIS dashboard logic
   Flow: workbook grids (JSON)  ->  parse()   : clean deals, fees, cash, pipeline, companies
                                ->  compute() : metrics for the chosen as-of date and segment
                                ->  render*() : one function per tab
   The same parse() runs on the embedded snapshot and on any workbook loaded with
   "Load updated MIS", so both paths always give the same numbers. */
'use strict';
/* =========================================================
   Utilities
   ========================================================= */
const DAY = 864e5, MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sum = (a, f = x => x) => a.reduce((s, x) => s + (f(x) || 0), 0);
function num(v){ if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s$]/g, ''); return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null; }
function str(v){ return v == null ? '' : String(v).trim(); }
function nrm(v){ return str(v).toLowerCase().replace(/\s+/g, ' '); }
function ymd(y, m, d){ return Math.round(Date.UTC(y, m - 1, d) / DAY); }
function toDay(v){
  if (v == null || v === '') return null;
  if (typeof v === 'number') return (v > 20000 && v < 80000) ? Math.floor(v + 1e-9) - 25569 : null;
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/))) { const d = +m[1], mo = +m[2]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return ymd(+m[3], mo, d); }
  return null;
}
function todayDay(){ const t = new Date(); return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
const isoD = d => new Date(d * DAY).toISOString().slice(0, 10);
function fmtD(d){ if (d == null) return '—'; const t = new Date(d * DAY); return String(t.getUTCDate()).padStart(2, '0') + ' ' + MON[t.getUTCMonth()] + ' ' + t.getUTCFullYear(); }
const monKey = d => { const t = new Date(d * DAY); return t.getUTCFullYear() * 12 + t.getUTCMonth(); };
const monLabel = k => MON[k % 12] + ' ' + String(Math.floor(k / 12)).slice(2);
function usd(n){ if (n == null || !isFinite(n)) return '—'; const r = Math.round(n); return (r < 0 ? '-' : '') + Math.abs(r).toLocaleString('en-US'); }
function usdC(n){ if (n == null || !isFinite(n)) return '—'; const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(0) + 'K'; return s + '$' + a.toFixed(0); }
const pct = (x, dp = 1) => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(dp) + '%';
const plural = (n, w, p) => n + ' ' + (n === 1 ? w : (p || w + 's'));
const txnKey = s => str(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function findRow(g, tests, from = 0){
  for (let r = from; r < g.length; r++){ const row = (g[r] || []).map(nrm); if (tests.every(t => row.some(c => t.test(c)))) return r; }
  return -1;
}
function cols(g, r, spec){ const row = (g[r] || []).map(nrm); const m = {}; for (const [k, re] of Object.entries(spec)) m[k] = row.findIndex(c => re.test(c)); return m; }
const cell = (row, i) => (i >= 0 && row) ? row[i] : null;

/* =========================================================
   Company registry (normalises name variants)
   ========================================================= */
function ckey(s){ return str(s).toUpperCase().replace(/\bLLV\b/g, 'LLC').replace(/[^A-Z0-9]/g, ''); }
const GENERIC = new Set(['LLC','LTD','GOODS','GENERAL','TRADING','INTERNATIONAL','GLOBAL','WHOLESALERS','EXIM','TRADE','DYNAMICS','CO','INC','L','LL']);
function shortName(n){
  const w = str(n).replace(/[.,()]/g, ' ').split(/\s+/).filter(Boolean); if (!w.length) return '';
  const out = [w[0]]; for (let i = 1; i < w.length && out.length < 3; i++){ if (GENERIC.has(w[i].toUpperCase())) break; out.push(w[i]); }
  return out.map(x => x[0].toUpperCase() + x.slice(1).toLowerCase()).join(' ');
}
function makeRegistry(){
  const cos = new Map(), keys = [], unresolved = new Map(), variants = new Map();
  return {
    add(name, info = {}){ const k = ckey(name); if (!k) return null;
      if (!cos.has(k)){ cos.set(k, {name: str(name).replace(/\s+/g, ' '), key: k, short: shortName(name), comm: 'Unclassified', limit: null, seg: null, ...info}); keys.push(k); }
      else Object.assign(cos.get(k), info);
      return cos.get(k).name; },
    resolve(raw, record = true){ const k = ckey(raw); if (!k) return null; if (cos.has(k)) return cos.get(k).name;
      let best = null, bl = 0, tie = false;
      for (const kk of keys){ let i = 0; while (i < k.length && i < kk.length && k[i] === kk[i]) i++; if (i > bl){ bl = i; best = kk; tie = false; } else if (i === bl && i > 0) tie = true; }
      if (best && bl >= 10 && !tie){ if (record) variants.set(str(raw), cos.get(best).name); return cos.get(best).name; }
      if (record) unresolved.set(str(raw), (unresolved.get(str(raw)) || 0) + 1);
      return null; },
    get(name){ return cos.get(ckey(name)); },
    all(){ return [...cos.values()]; }, unresolved, variants
  };
}

/* =========================================================
   Parse workbook grids into a clean model
   ========================================================= */
function parse(raw){
  const S = raw.sheets || {}; const reg = makeRegistry();
  const tm = S['Transactions Master'];
  if (!tm) throw new Error("This workbook has no 'Transactions Master' sheet. Load the Liquidity MIS file.");

  // Company Master
  const cm = S['Company Master'] || []; let r = findRow(cm, [/^us company name$/]);
  if (r >= 0){
    const c = cols(cm, r, {id:/^company id$/, name:/^us company name$/, parent:/^parent company name$/, owner:/owner/, comm:/^commodit/, limit:/^facility limit$/, cur:/^currency$/, status:/^status$/, remarks:/^remarks$/});
    for (let i = r + 1; i < cm.length; i++){ const row = cm[i] || []; const nm = str(cell(row, c.name)); if (!nm) continue;
      reg.add(nm, {id: str(cell(row, c.id)), parent: str(cell(row, c.parent)), owner: str(cell(row, c.owner)), comm: str(cell(row, c.comm)) || 'Unclassified',
        limit: num(cell(row, c.limit)), cur: str(cell(row, c.cur)) || 'USD', mstatus: str(cell(row, c.status)), remarks: str(cell(row, c.remarks)), inMaster: true}); }
  }

  // Dashboard Data: segment membership + liquidation sales
  const dd = S['Dashboard Data'] || []; let sec = null, ddc = null, sc = null; const sold = [];
  for (let i = 0; i < dd.length; i++){
    const row = dd[i] || []; const a = nrm(row[0]);
    if (/dashboard/.test(a)){ sec = /liquidat/.test(a) ? (/not sold/.test(a) ? 'liq' : 'sold') : 'active'; sc = null; continue; }
    if (a === 'company'){ if (sec === 'sold') sc = cols(dd, i, {deal:/^deal no/, prin:/^principal/, out:/^outstanding/, comm:/^commodity/, buyer:/^buyer/, sell:/^selling/, adv:/^advance/, bal:/^balance/, due:/^due date/});
      else ddc = cols(dd, i, {limit:/^total limit/}); continue; }
    if (!a || a === 'total' || !sec) continue;
    const nm = reg.resolve(row[0], false); if (!nm) continue; const co = reg.get(nm);
    if (sec === 'active' || sec === 'liq'){ co.seg = sec; if (co.limit == null && ddc) co.limit = num(cell(row, ddc.limit)); }
    else if (sec === 'sold' && sc) sold.push({co: nm, deal: str(cell(row, sc.deal)), out: num(cell(row, sc.out)), comm: str(cell(row, sc.comm)), buyer: str(cell(row, sc.buyer)),
      sell: num(cell(row, sc.sell)), adv: num(cell(row, sc.adv)), bal: num(cell(row, sc.bal)), due: toDay(cell(row, sc.due))});
  }
  const segFromDD = reg.all().some(c => c.seg);

  // Transactions Master
  r = findRow(tm, [/^txn id$/, /^company$/, /^outstanding$/]);
  if (r < 0) throw new Error("Couldn't find the Transactions Master header row (Txn ID, Company, Outstanding).");
  let c = cols(tm, r, {id:/^txn id$/, co:/^company$/, ref:/^facility ref/, disb:/^disbursement date/, due:/^due date/, ten:/^tenure/, ev:/^evaluation/, deal:/^deal amount/,
    amt:/^disbursed amount/, inv:/^invoice/, rdate:/^repayment date/, out:/^outstanding/, pen:/^penalty/, status:/^status$/, prod:/^product/});
  const deals = [];
  for (let i = r + 1; i < tm.length; i++){
    const row = tm[i] || []; const rawCo = str(cell(row, c.co)); if (!rawCo) continue;
    let nm = reg.resolve(rawCo); if (!nm) nm = reg.add(rawCo, {inMaster: false});
    const rdRaw = cell(row, c.rdate), rd = toDay(rdRaw);
    let out = num(cell(row, c.out)) || 0; if (Math.abs(out) < 1) out = 0;
    deals.push({row: i + 1, id: str(cell(row, c.id)), co: nm, ref: str(cell(row, c.ref)), disb: toDay(cell(row, c.disb)), due: toDay(cell(row, c.due)),
      ten: num(cell(row, c.ten)), ev: num(cell(row, c.ev)), deal: num(cell(row, c.deal)), amt: num(cell(row, c.amt)), inv: str(cell(row, c.inv)),
      rd, rdText: (rd == null && str(rdRaw)) ? str(rdRaw) : '', out, penDue: num(cell(row, c.pen)), status: str(cell(row, c.status)),
      prod: str(cell(row, c.prod)).replace(/\s+/g, ' ')});
  }

  // Segment fallback when Dashboard Data is missing
  for (const co of reg.all()){
    if (co.seg) continue;
    const live = deals.some(d => d.co === co.name && d.out > 0);
    if (!segFromDD){ if (/retir/i.test(co.mstatus || '')) co.seg = 'liq'; else if (/^active/i.test(co.mstatus || '') || live) co.seg = 'active'; }
    else if (live) co.seg = 'active';
  }

  // Payment Receipts (Payment = repayments received, Receipts = disbursed to client)
  const pr = S['Payment Receipts'] || []; const cash = [];
  r = findRow(pr, [/^date$/, /^company$/, /^payment$/, /^receipts?$/]);
  if (r >= 0){ c = cols(pr, r, {date:/^date$/, co:/^company$/, deal:/^deal/, inv:/^invoice/, pay:/^payment$/, rec:/^receipts?$/});
    for (let i = r + 1; i < pr.length; i++){ const row = pr[i] || []; const coRaw = str(cell(row, c.co)); if (nrm(coRaw) === 'total') break;
      const d = toDay(cell(row, c.date)), pay = num(cell(row, c.pay)) || 0, rec = num(cell(row, c.rec)) || 0; if (d == null && !pay && !rec) continue;
      cash.push({row: i + 1, date: d, coRaw, co: reg.resolve(coRaw), deal: str(cell(row, c.deal)), inv: str(cell(row, c.inv)), pay, rec}); } }

  // Custodian Master (fee invoices)
  const cu = S['Custodian Master'] || []; const fees = [];
  r = findRow(cu, [/^txn id$/, /^company$/, /^invoice amount$/]);
  if (r >= 0){ c = cols(cu, r, {id:/^txn id$/, co:/^company$/, ref:/^facility ref/, inv:/^invoice number$/, our:/^our invoice/, type:/^payment type$/, due:/^due date$/,
      amt:/^invoice amount$/, pen:/^penalty$/, rd:/^repayment date$/, paid:/^payment made$/, rem:/^remarks$/});
    for (let i = r + 1; i < cu.length; i++){ const row = cu[i] || []; const coRaw = str(cell(row, c.co)); if (!coRaw) continue;
      const rem = str(cell(row, c.rem)), rdRaw = cell(row, c.rd), amt = num(cell(row, c.amt)) || 0, pen = num(cell(row, c.pen));
      const status = /settled/i.test(rem) ? 'Settled' : /outstanding/i.test(rem) ? 'Outstanding' : (str(rdRaw) ? 'Settled' : 'Outstanding');
      const cur = status === 'Outstanding' ? ((pen != null && pen > 0) ? pen : amt) : 0;
      fees.push({row: i + 1, id: str(cell(row, c.id)), co: reg.resolve(coRaw) || str(coRaw), known: !!reg.resolve(coRaw, false), ref: str(cell(row, c.ref)),
        inv: str(cell(row, c.inv)), our: str(cell(row, c.our)), type: str(cell(row, c.type)), due: toDay(cell(row, c.due)), amt, pen, cur,
        rd: toDay(rdRaw), rdRaw: str(rdRaw), paid: num(cell(row, c.paid)) || 0, status}); } }

  // Pending Deals + Inspection projection
  const pd = S['Pending Deals'] || []; const pending = [], projection = [];
  r = findRow(pd, [/^company$/, /^inspection value$/, /^pending/]);
  if (r >= 0){ c = cols(pd, r, {co:/^company$/, prospect:/^prospect/, idate:/^inspection date/, ival:/^inspection value$/, dval:/^deal value/, disb:/^disbursed/, pend:/^pending/, rem:/^remarks/});
    for (let i = r + 1; i < pd.length; i++){ const row = pd[i] || []; const raw = str(cell(row, c.co)); if (!raw) { if (pending.length) break; else continue; } if (nrm(raw) === 'total') break;
      const idRaw = cell(row, c.idate);
      pending.push({co: reg.resolve(raw) || raw, prospect: num(cell(row, c.prospect)), idate: toDay(idRaw), idateRaw: str(idRaw), ival: num(cell(row, c.ival)) || 0,
        dval: num(cell(row, c.dval)) || 0, disb: num(cell(row, c.disb)) || 0, pend: num(cell(row, c.pend)) || 0, rem: str(cell(row, c.rem))}); } }
  const r2 = findRow(pd, [/^company$/, /^expected inspection value$/], Math.max(0, r + 1));
  if (r2 >= 0){ c = cols(pd, r2, {co:/^company$/, avail:/^available limit/, edeal:/deal value/, einsp:/^expected inspection value$/, req:/^required asset/, when:/^expected inspection$/, prod:/^product/, status:/^status/});
    for (let i = r2 + 1; i < pd.length; i++){ const row = pd[i] || []; const raw = str(cell(row, c.co)); if (!raw || nrm(raw) === 'total') break;
      projection.push({co: reg.resolve(raw) || raw, avail: num(cell(row, c.avail)), edeal: num(cell(row, c.edeal)) || 0, einsp: num(cell(row, c.einsp)) || 0,
        req: num(cell(row, c.req)) || 0, when: str(cell(row, c.when)), prod: str(cell(row, c.prod)), status: str(cell(row, c.status))}); } }

  // Error values anywhere in the loaded sheets
  const errors = [];
  for (const [name, g] of Object.entries(S)){ let n = 0, sample = []; g.forEach((row, ri) => (row || []).forEach((v, ci) => {
      if (typeof v === 'string' && /^#(REF!|VALUE!|NAME\?|DIV\/0!|N\/A|NUM!|NULL!|ERR)/.test(v)){ n++; if (sample.length < 4) sample.push(String.fromCharCode(65 + ci) + (ri + 1)); } }));
    if (n) errors.push({sheet: name, n, sample}); }

  return {reg, deals, cash, fees, pending, projection, sold, errors, meta: raw.meta || {}};
}

/* =========================================================
   Derived metrics for the chosen as-of date and segment
   ========================================================= */
const BUCKETS = [
  {k:'Not yet due', c:'var(--teal)', hex:'#2F7F73'}, {k:'1–30 days', c:'var(--sand)', hex:'#D9B44A'}, {k:'31–60 days', c:'var(--amber)', hex:'#D99A1E'},
  {k:'61–90 days', c:'var(--orange)', hex:'#D0612A'}, {k:'91–180 days', c:'var(--red)', hex:'#B3261E'}, {k:'180+ days', c:'var(--maroon)', hex:'#6E1414'}];
function bucketOf(dpd, overdue){ if (!overdue) return 0; if (dpd <= 30) return 1; if (dpd <= 60) return 2; if (dpd <= 90) return 3; if (dpd <= 180) return 4; return 5; }

function compute(P, asof, seg, invRate){
  const reg = P.reg;
  const segOf = name => (reg.get(name) || {}).seg || null;
  const inScope = name => seg === 'all' || segOf(name) === seg;

  for (const d of P.deals){
    d.live = d.out > 0; d.seg = segOf(d.co);
    d.overdue = d.live && d.due != null && d.due < asof;
    d.dpd = (d.live && d.due != null) ? asof - d.due : null;
    d.due60 = d.live && d.due != null && d.due >= asof && d.due <= asof + 60;
    d.bucket = d.live ? bucketOf(d.dpd, d.overdue) : null;
    d.penComp = (d.live && d.penDue != null && d.penDue > d.out) ? d.penDue - d.out : 0;
  }
  const deals = P.deals.filter(d => inScope(d.co));
  const live = deals.filter(d => d.live);

  // facility rows
  const facCos = reg.all().filter(co => (co.seg === 'active' || co.seg === 'liq') && (seg === 'all' || co.seg === seg));
  const pendBy = {}; P.pending.forEach(p => { pendBy[p.co] = (pendBy[p.co] || 0) + p.pend; });
  const fac = facCos.map(co => {
    const L = live.filter(d => d.co === co.name);
    const exp = sum(L, d => d.out), od = sum(L.filter(d => d.overdue), d => d.out), d60 = sum(L.filter(d => d.due60), d => d.out);
    const withEv = L.filter(d => d.ev > 0);
    const limit = co.limit || 0;
    return {co: co.name, short: co.short, seg: co.seg, comm: co.comm, limit, exp, util: limit ? exp / limit : null, avail: limit - exp, od, d60,
      utilAfter: exp - od - d60, availAfter: limit - exp + od + d60, pend: pendBy[co.name] || 0, n: L.length,
      ev: sum(withEv, d => d.ev), evCov: sum(withEv, d => d.out), noEv: L.length - withEv.length,
      maxDpd: Math.max(0, ...L.filter(d => d.overdue).map(d => d.dpd)), pen: sum(L, d => d.penComp)};
  });
  const T = {limit: sum(fac, f => f.limit), exp: sum(live, d => d.out), od: sum(live.filter(d => d.overdue), d => d.out), d60: sum(live.filter(d => d.due60), d => d.out),
    nLive: live.length, nOd: live.filter(d => d.overdue).length, n60: live.filter(d => d.due60).length, pen: sum(live, d => d.penComp)};
  T.util = T.limit ? sum(fac, f => f.exp) / T.limit : null;
  T.avail = sum(fac, f => f.avail); T.breaches = fac.filter(f => f.limit && f.exp > f.limit);
  T.availAfter = sum(fac, f => f.availAfter);

  // ageing
  const buckets = BUCKETS.map((b, i) => ({...b, v: sum(live.filter(d => d.bucket === i), d => d.out), n: live.filter(d => d.bucket === i).length}));

  // maturity ladder
  const m0 = monKey(asof); const ladder = [{k: 'Overdue', a: 0, l: 0, od: true}];
  for (let i = 0; i < 8; i++) ladder.push({k: monLabel(m0 + i), a: 0, l: 0, mk: m0 + i});
  ladder.push({k: 'Later', a: 0, l: 0});
  for (const d of live){ let slot;
    if (d.overdue) slot = ladder[0]; else if (d.due == null) slot = ladder[ladder.length - 1];
    else { const off = monKey(d.due) - m0; slot = off >= 0 && off < 8 ? ladder[1 + off] : ladder[ladder.length - 1]; }
    if (d.seg === 'liq') slot.l += d.out; else slot.a += d.out; }

  // commodity & concentration
  const comm = {}; for (const d of live){ const k = (reg.get(d.co) || {}).comm || 'Unclassified'; comm[k] = (comm[k] || 0) + d.out; }
  const commRows = Object.entries(comm).sort((a, b) => b[1] - a[1]);
  const byCo = [...fac].sort((a, b) => b.exp - a.exp); const top5 = sum(byCo.slice(0, 5), f => f.exp);

  // fees
  const fees = P.fees.filter(f => seg === 'all' ? true : (f.known && inScope(f.co)));
  for (const f of fees){ f.overdue = f.status === 'Outstanding' && f.due != null && f.due < asof && f.cur > 0; f.dpd = f.overdue ? asof - f.due : null; }
  const feeOd = fees.filter(f => f.overdue);
  const feeSched = fees.filter(f => f.status === 'Outstanding' && f.due != null && f.due >= asof);
  const F = {od: sum(feeOd, f => f.cur), nOd: feeOd.length, next30: sum(feeSched.filter(f => f.due < asof + 30), f => f.amt), next90: sum(feeSched.filter(f => f.due < asof + 90), f => f.amt),
    n90: feeSched.filter(f => f.due < asof + 90).length, collected: sum(fees.filter(f => f.status === 'Settled'), f => f.paid), od90: sum(feeOd.filter(f => f.dpd > 90), f => f.cur)};

  // monthly fee rate per deal (from custodian invoices)
  const feeByTxn = {}; for (const f of P.fees){ if (!(f.amt > 0)) continue; const k = txnKey(f.id); (feeByTxn[k] = feeByTxn[k] || []).push(f.amt); }
  const modeOf = arr => { const m = {}; let best = null, bc = 0; for (const v of arr){ const k = Math.round(v * 100); m[k] = (m[k] || 0) + 1; if (m[k] > bc){ bc = m[k]; best = v; } } return best; };
  const inv = live.map(d => { const fm = feeByTxn[txnKey(d.id)] ? modeOf(feeByTxn[txnKey(d.id)]) : null; const prin = d.amt || d.deal || 0; const ten = d.ten || 0;
    return {d, prin, ten, fee: fm, feeRate: fm && d.deal ? fm / d.deal : null, feeTot: fm != null ? fm * ten : null, invInt: prin * (invRate / 100) * ten / 12}; });

  // cash
  const cash = P.cash.filter(x => seg === 'all' ? true : (x.co && inScope(x.co)));
  const pending = P.pending.filter(p => seg === 'all' || inScope(p.co));
  const projection = P.projection.filter(p => seg === 'all' || inScope(p.co));
  const sold = P.sold.filter(s => seg === 'all' || inScope(s.co));

  const M = {asof, seg, deals, live, fac, T, buckets, ladder, commRows, top5, byCo, fees, feeOd, feeSched, F, inv, cash, pending, projection, sold};
  M.checks = runChecks(P, M);
  return M;
}

/* =========================================================
   Data integrity checks
   ========================================================= */
function runChecks(P, M){
  const out = []; const all = P.deals;
  const tag = d => `${d.id || 'row ' + d.row} (${P.reg.get(d.co)?.short || d.co}, row ${d.row})`;

  const br = M.fac.filter(f => f.limit && f.exp > f.limit);
  if (br.length) out.push({sev: 'high', title: plural(br.length, 'facility', 'facilities') + ' above the approved limit', impact: sum(br, f => f.exp - f.limit),
    body: 'Outstanding exceeds the facility limit in Company Master. Needs credit approval for the excess or a paydown before the next drawdown.',
    items: br.map(f => `${f.short}: ${usd(f.exp)} vs limit ${usd(f.limit)} (+${usd(f.exp - f.limit)})`)});

  const ghost = all.filter(d => (d.amt || 0) > 0 && d.out === 0 && d.rd == null && !d.rdText && !/settled|outstanding/i.test(d.status));
  if (ghost.length) out.push({sev: 'high', title: 'Disbursed deals missing from exposure', impact: sum(ghost, d => d.amt),
    body: 'These rows show a disbursed amount and no repayment date, yet Outstanding is zero and Status is blank, so facility utilisation and the limit tables understate exposure. In the 3rd Sep file the Outstanding formula on rows 161 to 165 reads Total Repayment (column K) instead of Disbursed Amount (column I).',
    items: ghost.map(d => `${tag(d)}: disbursed ${usd(d.amt)}, Outstanding ${usd(d.out)}`)});

  const mism = all.filter(d => (/outstanding/i.test(d.status) && d.out === 0) || (/settled/i.test(d.status) && d.out > 0));
  const soldFor = d => { const n = (d.ref.match(/(\d+)[A-Z]?$/i) || [])[1]; return n ? P.sold.find(s => s.co === d.co && new RegExp('(^|\\D)' + n + '(\\D|$)').test(s.deal)) : null; };
  if (mism.length) out.push({sev: 'med', title: 'Status does not match the balance', impact: null,
    body: 'Marked Outstanding with a zero balance (or Settled with a balance). Where a liquidation sale covers the deal it is noted; either way, set Status and Repayment Date so the row stops showing as open.',
    items: mism.map(d => { const s = soldFor(d); return `${tag(d)}: status ${d.status || 'blank'}, balance ${usd(d.out)}${s ? `, covered by liquidation sale ${s.deal} to ${s.buyer}` : ''}`; })});

  const odNoPen = M.live.filter(d => d.overdue && d.penDue == null);
  if (odNoPen.length) out.push({sev: 'med', title: 'Overdue deals with no penalty figure', impact: sum(odNoPen, d => d.out),
    body: 'Past due but the Penalty Amount column is blank, so penalty-inclusive dues are understated on the repayment sheets.',
    items: odNoPen.map(d => `${tag(d)}: ${d.dpd} days past due, ${usd(d.out)}`)});

  for (const e of P.errors) out.push({sev: 'med', title: `Formula errors in ${e.sheet}`, impact: null,
    body: e.sheet === 'Dashboard Data' ? 'The Interest column references a deleted column and returns #REF!, which also breaks its totals. This dashboard ignores that column.' : 'Cells returning Excel error values.',
    items: [`${plural(e.n, 'cell')} with errors, e.g. ${e.sample.join(', ')}`]});

  const inc = all.filter(d => (d.due == null || d.disb == null || !(d.deal > 0)) && d.out === 0 && !/settled/i.test(d.status));
  if (inc.length) out.push({sev: 'low', title: 'Incomplete rows in Transactions Master', impact: null,
    body: 'Rows with a company but missing dates or deal amounts. If these are pipeline placeholders, keeping them in Pending Deals avoids formula noise (for example ageing showing 46,275 days).',
    items: inc.map(d => `${tag(d)}: ${[d.disb == null ? 'no disbursement date' : '', d.due == null ? 'no due date' : '', !(d.deal > 0) ? 'no deal amount' : ''].filter(Boolean).join(', ')}`)});

  const ids = {}; all.forEach(d => { if (d.id) (ids[d.id] = ids[d.id] || []).push(d); });
  const dups = Object.entries(ids).filter(([, v]) => v.length > 1);
  if (dups.length) out.push({sev: 'low', title: 'Duplicate Txn IDs', impact: null, body: 'The same Txn ID is used on more than one row, which breaks lookups from the repayment and custodian sheets.',
    items: dups.map(([k, v]) => `${k}: rows ${v.map(d => d.row).join(', ')} (${v.map(d => P.reg.get(d.co)?.short).join(', ')})`)});

  const txt = all.filter(d => d.rdText);
  if (txt.length) out.push({sev: 'low', title: 'Text in the Repayment Date column', impact: null,
    body: 'Entries such as "PAID" are not dates, so repayment timing and days-to-settle cannot be measured for them.',
    items: [`${plural(txt.length, 'row')}: ${[...new Set(txt.map(d => '"' + d.rdText + '"'))].slice(0, 6).join(', ')}`]});

  const dates = P.cash.map(x => x.date).filter(x => x != null).sort((a, b) => a - b);
  if (dates.length > 8){ let cut = -1; for (let i = 0; i < Math.min(6, dates.length - 1); i++) if (dates[i + 1] - dates[i] > 60){ cut = i; }
    if (cut >= 0){ const odd = P.cash.filter(x => x.date != null && x.date <= dates[cut]); out.push({sev: 'low', title: 'Payment log entries with outlying dates', impact: null,
      body: `${plural(odd.length, 'entry', 'entries')} dated ${fmtD(dates[0])} sit months before the rest of the log (which starts ${fmtD(dates[cut + 1])}). They look like placeholder dates and distort the monthly cash chart.`,
      items: odd.map(x => `Row ${x.row}: ${x.coRaw} ${x.deal || ''} ${x.pay ? 'received ' + usd(x.pay) : 'paid out ' + usd(x.rec)}`)}); } }

  const fOld = M.feeOd.filter(f => f.dpd > 90);
  if (fOld.length) out.push({sev: 'med', title: 'Custodian fee invoices more than 90 days overdue', impact: sum(fOld, f => f.cur),
    body: 'Unpaid monthly custodian fee invoices older than 90 days.', items: groupSum(fOld, f => P.reg.get(f.co)?.short || f.co, f => f.cur).map(([k, v, n]) => `${k}: ${usd(v)} across ${plural(n, 'invoice')}`)});

  const fBad = P.fees.filter(f => f.status === 'Settled' && f.rd == null);
  if (fBad.length) out.push({sev: 'low', title: 'Settled fee invoices without a readable payment date', impact: sum(fBad, f => f.paid),
    body: 'These custodian fee rows are marked Settled but the Repayment Date is text or mistyped, so they are left out of the monthly collections chart.',
    items: [`${plural(fBad.length, 'invoice')}, for example ${[...new Set(fBad.map(f => '"' + str((f.rdRaw)) + '"'))].slice(0, 6).join(', ')}`]});
  const names = [...P.reg.variants.entries()].filter(([raw, nm]) => ckey(raw) !== ckey(nm));
  const unk = [...P.reg.unresolved.keys()].filter(k => !/^(company|total|as of)/i.test(k));
  if (names.length || unk.length) out.push({sev: 'low', title: 'Company name variants across sheets', impact: null,
    body: 'Spellings that differ from Company Master. Variants were matched automatically for this dashboard; names that could not be matched are shown as-is.',
    items: [...names.slice(0, 10).map(([a, b]) => `"${a}" read as ${b}`), ...unk.slice(0, 6).map(u => `"${u}" not in Company Master`)]});

  return out;
}
function groupSum(arr, kf, vf){ const m = new Map(); for (const x of arr){ const k = kf(x); const e = m.get(k) || [k, 0, 0]; e[1] += vf(x) || 0; e[2]++; m.set(k, e); } return [...m.values()].sort((a, b) => b[1] - a[1]); }

/* =========================================================
   Chart helpers (plain SVG, no external libraries)
   ========================================================= */
function colChart({cats, series, h = 250, grouped = false, fmt = usdC, catTip}){
  const W = Math.max(600, cats.length * 70), padT = 24, padB = 30, ch = h - padT - padB;
  const tot = cats.map((_, i) => grouped ? Math.max(...series.map(s => s.vals[i] || 0)) : sum(series, s => s.vals[i]));
  const max = Math.max(...tot, 1); const bw = W / cats.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img">`;
  for (let g = 1; g <= 3; g++){ const y = padT + ch - ch * g / 3; s += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#EEF1F4"/>`; }
  s += `<line x1="0" x2="${W}" y1="${padT + ch}" y2="${padT + ch}" stroke="#C9D1DA"/>`;
  cats.forEach((cat, i) => {
    const cx = i * bw + bw / 2;
    if (grouped){ const n = series.length, gw = bw * 0.7, w = gw / n;
      series.forEach((se, j) => { const v = se.vals[i] || 0; const hh = v / max * ch; const x = cx - gw / 2 + j * w;
        s += `<rect x="${x + 1}" y="${padT + ch - hh}" width="${w - 2}" height="${hh}" fill="${se.color}" rx="1.5" data-tip="${esc(cat + '\n' + se.name + ': $' + usd(v))}"/>`;
        if (v > 0) s += `<text class="vlab" style="font-size:11px" x="${x + w / 2}" y="${padT + ch - hh - 5}">${fmt(v)}</text>`; });
    } else { let y = padT + ch; const w = bw * 0.62;
      series.forEach(se => { const v = se.vals[i] || 0; if (v <= 0) return; const hh = v / max * ch; y -= hh;
        s += `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${hh}" fill="${se.colors ? se.colors[i] : se.color}" data-tip="${esc(cat + '\n' + se.name + ': $' + usd(v) + (catTip ? '\n' + catTip(i) : ''))}"/>`; });
      if (tot[i] > 0) s += `<text class="vlab" x="${cx}" y="${y - 6}">${fmt(tot[i])}</text>`; }
    s += `<text class="xlab" x="${cx}" y="${h - 9}">${esc(cat)}</text>`;
  });
  return s + '</svg>';
}
function donut(parts, size = 176, thick = 28, center = ''){
  const r = (size - thick) / 2, C = 2 * Math.PI * r, cx = size / 2, tot = sum(parts, p => p.v) || 1; let off = 0;
  let s = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"><circle r="${r}" cx="${cx}" cy="${cx}" fill="none" stroke="#EEF1F4" stroke-width="${thick}"/>`;
  parts.forEach(p => { if (!p.v) return; const len = p.v / tot * C;
    s += `<circle r="${r}" cx="${cx}" cy="${cx}" fill="none" stroke="${p.c}" stroke-width="${thick}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cx})" data-tip="${esc(p.k + '\n$' + usd(p.v) + ' (' + pct(p.v / tot) + ')')}"/>`; off += len; });
  return s + center + '</svg>';
}

/* =========================================================
   Rendering
   ========================================================= */
let RAW = JSON.parse(document.getElementById('snapshot').textContent), P = null, M = null;
const STATE = {seg: 'all', asof: todayDay(), tab: 'overview', sortBoard: 'util', invRate: 12, reg: {q: '', status: 'live', sort: 'due', dir: 1}};
const coLink = (name, label) => `<button class="link" data-co="${esc(name)}">${esc(label ?? (P.reg.get(name)?.short || name))}</button>`;
const segChip = s => s === 'liq' ? '<i class="chip liq">Liquidating</i>' : s === 'active' ? '<i class="chip active">Active</i>' : '';
const segColor = s => s === 'liq' ? 'var(--liq)' : 'var(--active)';

function renderAll(){
  M = compute(P, STATE.asof, STATE.seg, STATE.invRate);
  renderHeader(); renderKpis(); renderOverview(); renderFacilities(); renderAgeing(); renderMaturities(); renderFees(); renderPipeline(); renderRegister(); renderChecks();
  const n = M.checks.filter(c => c.sev === 'high').length;
  $('[data-tab="checks"]').innerHTML = 'Data checks' + (n ? `<span class="n" title="${n} high-priority">${n}</span>` : '');
}
function renderHeader(){
  const m = P.meta; $('#srcLine').textContent = `Source file ${m.source || 'workbook'}, read ${m.extracted ? fmtD(toDay(m.extracted)) : ''}. Balances as recorded in the MIS; ageing measured to ${fmtD(STATE.asof)}. Figures in USD.`;
  $('#asof').value = isoD(STATE.asof);
}
function renderKpis(){
  const T = M.T, F = M.F; const pend = sum(M.pending, p => p.pend), pendN = M.pending.filter(p => p.pend > 0).length;
  const k = [
    ['Exposure outstanding', usdC(T.exp), `${plural(T.nLive, 'live deal')}`, ''],
    ['Facility utilisation', pct(T.util), `of ${usdC(T.limit)} in limits`, T.util > .9 ? 'caution' : ''],
    ['Overdue principal', usdC(T.od), `${pct(T.exp ? T.od / T.exp : 0)} of exposure, ${plural(T.nOd, 'deal')}`, T.od > 0 ? 'warn' : ''],
    ['Due in next 60 days', usdC(T.d60), plural(T.n60, 'deal'), ''],
    ['Available limit', usdC(T.avail), T.breaches.length ? `${plural(T.breaches.length, 'facility', 'facilities')} over limit` : 'no limit breaches', T.breaches.length ? 'subwarn' : ''],
    ['Pending disbursement', usdC(pend), plural(pendN, 'deal') + ' part-funded', ''],
    ['Custodian fees overdue', usdC(F.od), plural(F.nOd, 'invoice'), F.od > 0 ? 'caution' : '']];
  $('#kpis').innerHTML = k.map(([l, v, s, c]) => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
}

/* ---------- Overview ---------- */
function boardHTML(rows, scaleMax){
  return rows.map(f => {
    const sc = v => (v / scaleMax * 100).toFixed(2) + '%';
    const later = Math.max(0, f.exp - f.od - f.d60); const over = f.limit && f.exp > f.limit;
    const tip = `${f.co}\nLimit $${usd(f.limit)}\nOutstanding $${usd(f.exp)} (${pct(f.util)})\nOverdue $${usd(f.od)}\nDue in 60 days $${usd(f.d60)}\nDue later $${usd(later)}\n${f.n} live deals`;
    return `<button class="brow" data-co="${esc(f.co)}" data-tip="${esc(tip)}">
      <span class="bname">${esc(f.short)}${f.seg === 'liq' ? '<i class="chip liq">Liq</i>' : ''}</span>
      <span class="btrack"><span class="bfill" data-w="${sc(f.exp)}" style="width:0">
        <span style="width:${f.exp ? f.od / f.exp * 100 : 0}%;background:var(--red)"></span><span style="width:${f.exp ? f.d60 / f.exp * 100 : 0}%;background:var(--amber)"></span><span style="width:${f.exp ? later / f.exp * 100 : 0}%;background:var(--teal)"></span></span>
        ${over ? `<span class="bover" style="left:${sc(f.limit)};width:calc(${sc(f.exp - f.limit)})"></span>` : ''}
        ${f.limit ? `<span class="blim" style="left:${sc(f.limit)}"></span>` : ''}</span>
      <span class="bval ${over ? 'breach' : ''}">${usdC(f.exp)}<small>${f.limit ? pct(f.util, 0) + ' of limit' : 'no limit'}</small></span></button>`; }).join('');
}
function renderOverview(){
  const T = M.T; const sorters = {util: (a, b) => (b.util || 0) - (a.util || 0), exp: (a, b) => b.exp - a.exp, od: (a, b) => b.od - a.od || b.exp - a.exp};
  const rows = [...M.fac].sort(sorters[STATE.sortBoard]);
  const scaleMax = Math.max(1, ...rows.map(f => Math.max(f.exp, f.limit || 0))) * 1.03;
  const ticks = [0, .25, .5, .75, 1].map(t => `<span style="left:${t * 100}%">${usdC(scaleMax * t)}</span>`).join('');
  const odTot = sum(M.buckets.slice(1), b => b.v);
  const center = `<text x="88" y="84" text-anchor="middle" style="font-size:12px;fill:#5A6676">Overdue</text><text x="88" y="106" text-anchor="middle" style="font-size:20px;font-weight:700;fill:#B3261E">${usdC(odTot)}</text>`;

  // alerts
  const al = [];
  if (T.breaches.length) al.push({c: 'var(--red)', t: `${plural(T.breaches.length, 'facility', 'facilities')} above limit`, s: T.breaches.map(f => f.short + ' +' + usdC(f.exp - f.limit)).join(', '), go: 'facilities'});
  const d90 = M.live.filter(d => d.dpd > 90); if (d90.length) al.push({c: 'var(--maroon)', t: `${usdC(sum(d90, d => d.out))} more than 90 days past due`, s: [...new Set(d90.map(d => P.reg.get(d.co)?.short))].join(', '), go: 'ageing'});
  const d30 = M.live.filter(d => !d.overdue && d.due != null && d.due - M.asof <= 30); if (d30.length) al.push({c: 'var(--amber)', t: `${usdC(sum(d30, d => d.out))} maturing in the next 30 days`, s: plural(d30.length, 'deal') + ' to collect or roll over', go: 'maturities'});
  if (M.F.od > 0) al.push({c: 'var(--amber)', t: `${usdC(M.F.od)} custodian fees unpaid past due`, s: `${plural(M.F.nOd, 'invoice')}, ${usdC(M.F.od90)} older than 90 days`, go: 'fees'});
  const hc = M.checks.filter(c => c.sev === 'high'); if (hc.length) al.push({c: 'var(--red)', t: plural(hc.length, 'high-priority data issue'), s: hc.map(c => c.title).join('; '), go: 'checks'});

  const lad = M.ladder;
  const ladderSvg = colChart({cats: lad.map(x => x.k), series: [
    {name: 'Active facilities', vals: lad.map(x => x.a), colors: lad.map(x => x.od ? '#B3261E' : '#1D4E89')},
    {name: 'Liquidating stock', vals: lad.map(x => x.l), colors: lad.map(x => x.od ? '#E3867F' : '#9A7432')}], h: 250,
    catTip: i => plural(M.live.filter(d => { const x = lad[i]; if (x.od) return d.overdue; if (d.overdue) return false; if (x.mk != null) return d.due != null && monKey(d.due) === x.mk; return d.due == null || monKey(d.due) >= monKey(M.asof) + 8; }).length, 'deal')});

  const cmax = Math.max(1, ...M.commRows.map(r => r[1]));
  $('#tab-overview').innerHTML = `
  <div class="grid g-hero">
    <div class="card hero">
      <div class="card-h"><div><h2>Facility utilisation</h2><p class="sub">Outstanding on each facility against its limit, coloured by when it falls due. Click a company for its deal-level detail.</p></div>
        <div class="sorter" role="group" aria-label="Sort facilities">${[['util', 'Utilisation'], ['exp', 'Exposure'], ['od', 'Overdue']].map(([k, l]) => `<button data-sortboard="${k}" aria-pressed="${STATE.sortBoard === k}">${l}</button>`).join('')}</div></div>
      <div class="legend"><span><i style="background:var(--red)"></i>Overdue</span><span><i style="background:var(--amber)"></i>Due within 60 days</span><span><i style="background:var(--teal)"></i>Due later</span><span><i class="limline"></i>Facility limit</span><span><i class="hatch"></i>Above limit</span></div>
      <div class="board">${rows.length ? boardHTML(rows, scaleMax) : '<p class="empty">No facilities in this segment.</p>'}</div>
      <div class="axis"><div></div><div>${ticks}</div><div></div></div>
    </div>
    <div class="stack">
      <div class="card"><h2>Ageing of outstanding</h2><p class="sub">By days past the due date. Part-paid balances keep ageing from the original due date.</p>
        <div class="donutwrap mt">${donut(M.buckets.map(b => ({k: b.k, v: b.v, c: b.hex})), 176, 28, center)}
          <div class="dl">${M.buckets.map(b => `<div data-tip="${esc(b.k + '\n' + plural(b.n, 'deal'))}"><i style="background:${b.c}"></i><span>${b.k}</span><b>${usdC(b.v)}</b></div>`).join('')}</div></div></div>
      <div class="card"><h2>Needs attention</h2><div class="alerts mt">${al.length ? al.map(a => `<button class="alert" data-go="${a.go}"><span class="bar" style="background:${a.c}"></span><span><b>${esc(a.t)}</b><span>${esc(a.s)}</span></span></button>`).join('') : '<p class="empty">Nothing flagged for this segment.</p>'}</div></div>
    </div>
  </div>
  <div class="grid g-2 mt">
    <div class="card"><div class="card-h"><div><h2>Maturity ladder</h2><p class="sub">Outstanding principal by due month. The first column is already past due.</p></div>
      <div class="legend" style="margin:0"><span><i style="background:var(--active)"></i>Active</span><span><i style="background:var(--liq)"></i>Liquidating</span><span><i style="background:var(--red)"></i>Overdue</span></div></div>${ladderSvg}</div>
    <div class="card"><h2>Exposure by commodity</h2><p class="sub">Grouped by the commodity recorded for each company in Company Master.</p>
      <div class="hbars mt">${M.commRows.map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><span class="t"><span style="width:${v / cmax * 100}%"></span></span><span class="n">${usdC(v)}<small>${pct(T.exp ? v / T.exp : 0, 0)}</small></span></div>`).join('')}</div>
      <p class="note">Top 5 facilities hold ${pct(T.exp ? M.top5 / T.exp : 0, 0)} of exposure. Largest single facility: ${M.byCo[0] ? esc(M.byCo[0].short) + ' at ' + pct(T.exp ? M.byCo[0].exp / T.exp : 0, 1) : '—'}.</p>
      <p class="note">Collateral: live deals with a recorded evaluation carry ${usdC(sum(M.fac, f => f.ev))} of stock against ${usdC(sum(M.fac, f => f.evCov))} outstanding (${(sum(M.fac, f => f.evCov) ? (sum(M.fac, f => f.ev) / sum(M.fac, f => f.evCov)).toFixed(2) : '—')}x cover). ${plural(sum(M.fac, f => f.noEv), 'live deal')} have no evaluation value.</p></div>
  </div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => $$('#tab-overview .bfill').forEach(el => el.style.width = el.dataset.w)));
}

/* ---------- Facilities ---------- */
function renderFacilities(){
  const segs = STATE.seg === 'all' ? ['active', 'liq'] : [STATE.seg];
  const name = {active: 'Active facilities (limited status)', liq: 'Liquidating stock (not sold)'};
  const ub = f => { const u = f.util || 0; return `<span class="ubar ${u > 1 ? 'over' : u > .9 ? 'hi' : ''}"><span style="width:${Math.min(100, u * 100)}%"></span></span>${pct(f.util)}`; };
  const line = (f, cls = '', label) => `<tr class="${cls}" ${label ? '' : `data-co-row="${esc(f.co)}"`}>
    <td>${label ?? coLink(f.co)}</td><td class="muted">${label ? '' : esc(f.comm)}</td><td class="r">${usd(f.limit)}</td><td class="r">${usd(f.exp)}</td><td>${ub(f)}</td>
    <td class="r ${f.avail < 0 ? 'neg' : ''}">${usd(f.avail)}</td><td class="r ${f.od > 0 ? 'neg' : ''}">${usd(f.od)}</td><td class="r">${usd(f.d60)}</td>
    <td class="r">${usd(f.utilAfter)}</td><td class="r ${f.availAfter < 0 ? 'neg' : ''}">${usd(f.availAfter)}</td><td class="r">${usd(f.pend)}</td>
    <td class="r">${f.evCov ? (f.ev / f.evCov).toFixed(2) + 'x' : '—'}</td><td class="r">${f.n}</td></tr>`;
  const agg = arr => { const o = {limit: sum(arr, f => f.limit), exp: sum(arr, f => f.exp), od: sum(arr, f => f.od), d60: sum(arr, f => f.d60), pend: sum(arr, f => f.pend), ev: sum(arr, f => f.ev), evCov: sum(arr, f => f.evCov), n: sum(arr, f => f.n)};
    o.util = o.limit ? o.exp / o.limit : null; o.avail = o.limit - o.exp; o.utilAfter = o.exp - o.od - o.d60; o.availAfter = o.avail + o.od + o.d60; return o; };
  let body = '';
  for (const s of segs){ const arr = M.fac.filter(f => f.seg === s).sort((a, b) => (b.util || 0) - (a.util || 0)); if (!arr.length) continue;
    body += `<tr class="grp"><td colspan="13">${name[s]}</td></tr>` + arr.map(f => line(f, 'click')).join('') + line(agg(arr), 'sub', 'Subtotal'); }
  if (segs.length > 1) body += line(agg(M.fac), 'tot', 'Total');
  const sold = M.sold.length ? `<div class="card mt"><h2>Liquidation sales agreed</h2><p class="sub">Stock from liquidating facilities already sold, from the Dashboard Data sheet.</p>
    <div class="tw mt"><table><thead><tr><th>Company</th><th>Deal</th><th>Commodity</th><th>Buyer</th><th class="r">Outstanding</th><th class="r">Selling amount</th><th class="r">Advance</th><th class="r">Balance due</th><th>Due date</th></tr></thead>
    <tbody>${M.sold.map(s => `<tr><td>${coLink(s.co)}</td><td>${esc(s.deal)}</td><td>${esc(s.comm)}</td><td>${esc(s.buyer)}</td><td class="r">${usd(s.out)}</td><td class="r">${usd(s.sell)}</td><td class="r">${usd(s.adv)}</td><td class="r">${usd(s.bal)}</td><td>${fmtD(s.due)}</td></tr>`).join('')}</tbody></table></div></div>` : '';
  $('#tab-facilities').innerHTML = `<div class="card"><div class="card-h"><div><h2>Facility limit status</h2>
    <p class="sub">Rebuilt from Transactions Master so every company has principal and utilisation filled in. "After repayment" assumes overdue and 60-day maturities are collected, as in the MIS sheet. Cover is collateral evaluation value over outstanding for live deals that have one.</p></div></div>
    <div class="tw"><table><thead><tr><th>Company</th><th>Commodity</th><th class="r">Limit</th><th class="r">Outstanding</th><th>Utilisation</th><th class="r">Available</th><th class="r">Overdue</th><th class="r">Due ≤ 60 days</th>
    <th class="r">Utilised after repayment</th><th class="r">Available after repayment</th><th class="r">Pending disbursement</th><th class="r">Cover</th><th class="r">Deals</th></tr></thead><tbody>${body}</tbody></table></div></div>${sold}`;
}

/* ---------- Ageing ---------- */
function renderAgeing(){
  const od = M.live.filter(d => d.overdue).sort((a, b) => b.dpd - a.dpd);
  const cos = M.fac.filter(f => f.exp > 0).sort((a, b) => b.od - a.od || b.exp - a.exp);
  const cellMax = Math.max(1, ...cos.flatMap(f => BUCKETS.map((_, i) => sum(M.live.filter(d => d.co === f.co && d.bucket === i), d => d.out))));
  const heat = cos.map(f => { const vals = BUCKETS.map((_, i) => sum(M.live.filter(d => d.co === f.co && d.bucket === i), d => d.out));
    return `<tr class="click" data-co-row="${esc(f.co)}"><td>${coLink(f.co)}</td>${vals.map((v, i) => `<td class="h" style="background:${v ? hexA(BUCKETS[i].hex, i === 0 ? .06 + .22 * v / cellMax : .14 + .62 * v / cellMax) : 'transparent'};${i > 0 && v / cellMax > .5 ? 'color:#fff;font-weight:600' : ''}">${v ? usdC(v) : ''}</td>`).join('')}<td class="r"><b>${usdC(f.exp)}</b></td></tr>`; }).join('');
  const totB = M.buckets.map(b => b.v); const T = sum(totB) || 1;
  const strip = `<div style="display:flex;height:26px;border-radius:4px;overflow:hidden;margin:6px 0 8px">${M.buckets.map(b => b.v ? `<span style="width:${b.v / T * 100}%;background:${b.hex}" data-tip="${esc(b.k + '\n$' + usd(b.v) + ' (' + pct(b.v / T) + ')')}"></span>` : '').join('')}</div>
    <div class="legend" style="margin:0">${M.buckets.map(b => `<span><i style="background:${b.hex}"></i>${b.k} ${usdC(b.v)} (${pct(b.v / T, 0)})</span>`).join('')}</div>`;
  const part = M.live.filter(d => (d.amt || d.deal) && d.out < (d.amt || d.deal) - 1).sort((a, b) => (a.due || 0) - (b.due || 0));
  $('#tab-ageing').innerHTML = `
  <div class="stats">${[['Overdue principal', usdC(M.T.od), plural(M.T.nOd, 'deal'), 'red'], ['Penalty accrued (from MIS)', usdC(M.T.pen), 'penalty-inclusive due less principal', 'amber'],
    ['Weighted days past due', od.length ? Math.round(sum(od, d => d.dpd * d.out) / sum(od, d => d.out)) + ' days' : '—', 'across overdue balances', ''],
    ['Oldest overdue', od.length ? od[0].dpd + ' days' : '—', od.length ? esc(P.reg.get(od[0].co)?.short + ', ' + od[0].id) : '', ''],
    ['More than 90 days', usdC(sum(od.filter(d => d.dpd > 90), d => d.out)), plural(od.filter(d => d.dpd > 90).length, 'deal'), 'red']].map(([l, v, s, c]) => `<div class="stat ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="card"><h2>Ageing profile</h2><p class="sub">Every live balance placed in a bucket by days past its due date as of ${fmtD(M.asof)}.</p>${strip}
    <div class="tw mt"><table class="heat"><thead><tr><th>Company</th>${BUCKETS.map(b => `<th class="r">${b.k}</th>`).join('')}<th class="r">Total</th></tr></thead><tbody>${heat}</tbody></table></div></div>
  <div class="card mt"><h2>Overdue deals</h2><p class="sub">Sorted by days past due. "Due incl. penalty" is the Penalty Amount column in Transactions Master; the penalty is the difference to principal.</p>
    <div class="tw mt"><table><thead><tr><th>Txn</th><th>Company</th><th>Facility ref</th><th>Due date</th><th class="r">Days past due</th><th>Bucket</th><th class="r">Outstanding</th><th class="r">Due incl. penalty</th><th class="r">Penalty</th></tr></thead>
    <tbody>${od.length ? od.map(d => `<tr><td>${esc(d.id)}</td><td>${coLink(d.co)}</td><td>${esc(d.ref)}</td><td>${fmtD(d.due)}</td><td class="r"><b>${d.dpd}</b></td><td><i class="chip ${d.dpd > 90 ? 'red' : d.dpd > 30 ? 'amber' : 'grey'}" style="margin:0">${BUCKETS[d.bucket].k}</i></td>
      <td class="r">${usd(d.out)}</td><td class="r">${d.penDue != null ? usd(d.penDue) : '<span class="muted">not set</span>'}</td><td class="r">${d.penComp ? usd(d.penComp) : '—'}</td></tr>`).join('') : '<tr><td colspan="9" class="empty">No overdue deals in this segment.</td></tr>'}
    ${od.length ? `<tr class="tot"><td colspan="6">Total</td><td class="r">${usd(sum(od, d => d.out))}</td><td class="r">${usd(sum(od, d => d.penDue ?? d.out))}</td><td class="r">${usd(sum(od, d => d.penComp))}</td></tr>` : ''}</tbody></table></div></div>
  <div class="card mt"><h2>Part-paid balances still ageing</h2><p class="sub">When a receipt is smaller than the balance it is allocated to the deal and the remainder keeps ageing from the original due date. A receipt larger than the balance is booked as a new invoice aged on the previous average basis.</p>
    <div class="tw mt"><table><thead><tr><th>Txn</th><th>Company</th><th>Due date</th><th class="r">Disbursed</th><th class="r">Received so far</th><th class="r">Remaining</th><th class="r">Paid</th><th>Ageing</th></tr></thead>
    <tbody>${part.length ? part.map(d => { const base = d.amt || d.deal; return `<tr><td>${esc(d.id)}</td><td>${coLink(d.co)}</td><td>${fmtD(d.due)}</td><td class="r">${usd(base)}</td><td class="r">${usd(base - d.out)}</td><td class="r"><b>${usd(d.out)}</b></td>
      <td class="r">${pct((base - d.out) / base, 0)}</td><td>${d.overdue ? `<i class="chip red" style="margin:0">${d.dpd} days past due</i>` : '<i class="chip green" style="margin:0">Not yet due</i>'}</td></tr>`; }).join('') : '<tr><td colspan="8" class="empty">No part-paid balances.</td></tr>'}</tbody></table></div></div>`;
}
function hexA(hex, a){ const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.min(1, a).toFixed(2)})`; }

/* ---------- Maturities & cash ---------- */
function renderMaturities(){
  const up = M.live.filter(d => !d.overdue && d.due != null && d.due - M.asof <= 90).sort((a, b) => a.due - b.due);
  const win = n => M.live.filter(d => !d.overdue && d.due != null && d.due - M.asof <= n);
  const cm = {}; for (const x of M.cash){ if (x.date == null) continue; const k = monKey(x.date); cm[k] = cm[k] || {p: 0, r: 0, n: 0}; cm[k].p += x.pay; cm[k].r += x.rec; cm[k].n++; }
  const keys = Object.keys(cm).map(Number).sort((a, b) => a - b);
  const cashSvg = keys.length ? colChart({cats: keys.map(monLabel), grouped: true, h: 240, series: [{name: 'Received from clients', color: '#2F7F73', vals: keys.map(k => cm[k].p)}, {name: 'Disbursed to clients', color: '#1D4E89', vals: keys.map(k => cm[k].r)}]}) : '<p class="empty">No entries in the Payment Receipts log.</p>';
  const recent = [...M.cash].filter(x => x.date != null).sort((a, b) => b.date - a.date || b.row - a.row).slice(0, 14);
  $('#tab-maturities').innerHTML = `
  <div class="stats">${[[7, 'Next 7 days'], [30, 'Next 30 days'], [60, 'Next 60 days'], [90, 'Next 90 days']].map(([n, l]) => { const w = win(n); return `<div class="stat"><div class="l">Maturing ${l.toLowerCase()}</div><div class="v">${usdC(sum(w, d => d.out))}</div><div class="s">${plural(w.length, 'deal')}</div></div>`; }).join('')}
    <div class="stat red"><div class="l">Already overdue</div><div class="v">${usdC(M.T.od)}</div><div class="s">${plural(M.T.nOd, 'deal')}</div></div></div>
  <div class="grid g-2e">
    <div class="card"><h2>Upcoming maturities</h2><p class="sub">Live deals falling due within 90 days of ${fmtD(M.asof)}.</p>
      <div class="tw mt"><table><thead><tr><th>Due date</th><th class="r">In</th><th>Company</th><th>Txn</th><th class="r">Outstanding</th></tr></thead>
      <tbody>${up.length ? up.map(d => `<tr><td>${fmtD(d.due)}</td><td class="r">${d.due - M.asof} days</td><td>${coLink(d.co)}${d.seg === 'liq' ? '<i class="chip liq">Liq</i>' : ''}</td><td>${esc(d.id)}</td><td class="r">${usd(d.out)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Nothing matures in the next 90 days.</td></tr>'}
      ${up.length ? `<tr class="tot"><td colspan="4">Total</td><td class="r">${usd(sum(up, d => d.out))}</td></tr>` : ''}</tbody></table></div></div>
    <div class="stack">
      <div class="card"><div class="card-h"><div><h2>Cash movement</h2><p class="sub">From the Payment Receipts log: the Payment column is money received from clients (repayments and fees), the Receipts column is money disbursed to them.</p></div>
        <div class="legend" style="margin:0"><span><i style="background:var(--teal)"></i>Received</span><span><i style="background:var(--active)"></i>Disbursed</span></div></div>${cashSvg}
        <p class="note">Log total: ${usdC(sum(M.cash, x => x.pay))} received, ${usdC(sum(M.cash, x => x.rec))} disbursed, net ${usdC(sum(M.cash, x => x.pay - x.rec))}.</p></div>
      <div class="card"><h2>Latest entries</h2><div class="tw mt"><table><thead><tr><th>Date</th><th>Company</th><th>Deal</th><th class="r">Received</th><th class="r">Disbursed</th></tr></thead>
        <tbody>${recent.map(x => `<tr><td>${fmtD(x.date)}</td><td>${x.co ? coLink(x.co) : esc(x.coRaw)}</td><td class="clip" title="${esc(x.deal)}">${esc(x.deal)}</td><td class="r">${x.pay ? usd(x.pay) : ''}</td><td class="r">${x.rec ? usd(x.rec) : ''}</td></tr>`).join('')}</tbody></table></div></div>
    </div></div>`;
}

/* ---------- Custodian fees & investor interest ---------- */
function renderFees(){
  const F = M.F, asof = M.asof, m0 = monKey(asof);
  const months = []; for (let i = -6; i <= 3; i++) months.push(m0 + i);
  const billed = months.map(k => sum(M.fees.filter(f => f.due != null && monKey(f.due) === k), f => f.amt));
  const coll = months.map(k => sum(M.fees.filter(f => f.status === 'Settled' && f.rd != null && monKey(f.rd) === k), f => f.paid));
  const svg = colChart({cats: months.map(k => monLabel(k) + (k > m0 ? '*' : '')), grouped: true, h: 230, series: [{name: 'Invoiced (by due month)', color: '#7FA3C9', vals: billed}, {name: 'Collected (by payment month)', color: '#2F7F73', vals: coll}]});
  const byCo = groupSum(M.feeOd, f => f.co, f => f.cur);
  const oldest = co => Math.max(...M.feeOd.filter(f => f.co === co).map(f => f.dpd));
  const inv = M.inv.filter(x => x.ten > 0).sort((a, b) => b.prin - a.prin);
  const withFee = inv.filter(x => x.feeTot != null);
  $('#tab-fees').innerHTML = `
  <div class="stats">${[['Overdue fee receivable', usdC(F.od), plural(F.nOd, 'invoice') + ' past due', 'red'], ['Older than 90 days', usdC(F.od90), 'part of the overdue total', 'amber'],
    ['Invoices due next 30 days', usdC(F.next30), 'scheduled, not yet due', ''], ['Scheduled next 90 days', usdC(F.next90), plural(F.n90, 'invoice'), ''], ['Collected to date', usdC(F.collected), 'settled invoices in Custodian Master', '']]
    .map(([l, v, s, c]) => `<div class="stat ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="grid g-2e">
    <div class="card"><div class="card-h"><div><h2>Custodian fees invoiced and collected</h2><p class="sub">Last six months and the next three. Months marked * are scheduled invoices not yet due. Settled invoices without a readable payment date are left out of the collected bars.</p></div>
      <div class="legend" style="margin:0"><span><i style="background:#7FA3C9"></i>Invoiced</span><span><i style="background:var(--teal)"></i>Collected</span></div></div>${svg}</div>
    <div class="card"><h2>Unpaid fees past due, by company</h2><p class="sub">Current due uses the penalty-inclusive figure where the MIS records one.</p>
      <div class="tw mt"><table><thead><tr><th>Company</th><th class="r">Invoices</th><th class="r">Current due</th><th class="r">Oldest</th></tr></thead>
      <tbody>${byCo.length ? byCo.map(([co, v, n]) => `<tr><td>${P.reg.get(co) ? coLink(co) : esc(co)}</td><td class="r">${n}</td><td class="r">${usd(v)}</td><td class="r ${oldest(co) > 90 ? 'neg' : ''}">${oldest(co)} days</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No overdue custodian fees.</td></tr>'}
      ${byCo.length ? `<tr class="tot"><td>Total</td><td class="r">${M.feeOd.length}</td><td class="r">${usd(F.od)}</td><td></td></tr>` : ''}</tbody></table></div></div>
  </div>
  <div class="card mt"><div class="card-h"><div><h2>Investor interest on live deals</h2>
    <p class="sub">Investor interest is calculated separately for each deal: funded principal × agreed rate × tenure in months ÷ 12. Client custodian fees use the monthly fee invoiced on that deal in Custodian Master.</p></div>
    <div class="rate"><label for="invRate">Investor rate, % a year</label><input id="invRate" type="number" step="0.25" min="0" value="${STATE.invRate}">${STATE.invRate === 12 ? '<span class="tag-assume">12% is a placeholder until you enter the agreed rate</span>' : ''}</div></div>
    <div class="stats" style="margin:0 0 14px">${[['Funded principal', usdC(sum(inv, x => x.prin)), plural(inv.length, 'live deal')], ['Investor interest over tenure', usdC(sum(inv, x => x.invInt)), 'at ' + STATE.invRate + '% a year'],
      ['Client custodian fees over tenure', usdC(sum(withFee, x => x.feeTot)), plural(withFee.length, 'deal') + ' with fee invoices'], ['Spread on those deals', usdC(sum(withFee, x => x.feeTot - x.invInt)), 'fees less investor interest']]
      .map(([l, v, s]) => `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
    <div class="tw" style="max-height:480px;overflow:auto"><table><thead><tr><th>Txn</th><th>Company</th><th>Disbursed</th><th>Due</th><th class="r">Tenure</th><th class="r">Principal</th><th class="r">Fee / month</th><th class="r">Fee rate</th><th class="r">Fees over tenure</th><th class="r">Investor interest</th><th class="r">Spread</th></tr></thead>
    <tbody>${inv.map(x => `<tr><td>${esc(x.d.id)}</td><td>${coLink(x.d.co)}</td><td>${fmtD(x.d.disb)}</td><td>${fmtD(x.d.due)}</td><td class="r">${x.ten} mo</td><td class="r">${usd(x.prin)}</td><td class="r">${x.fee != null ? usd(x.fee) : '—'}</td>
      <td class="r">${x.feeRate != null ? pct(x.feeRate, 2) : '—'}</td><td class="r">${x.feeTot != null ? usd(x.feeTot) : '—'}</td><td class="r">${usd(x.invInt)}</td><td class="r ${x.feeTot != null && x.feeTot - x.invInt < 0 ? 'neg' : ''}">${x.feeTot != null ? usd(x.feeTot - x.invInt) : '—'}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('#invRate').addEventListener('change', e => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= 0){ STATE.invRate = v; M = compute(P, STATE.asof, STATE.seg, STATE.invRate); renderFees(); } });
}

/* ---------- Pipeline ---------- */
function renderPipeline(){
  const pd = M.pending, pj = M.projection;
  const cms = P.reg.all().filter(c => c.inMaster); const st = groupSum(cms, c => c.mstatus || 'Blank', () => 1);
  const notLive = cms.filter(c => !/^(active|retir)/i.test(c.mstatus || ''));
  $('#tab-pipeline').innerHTML = `
  <div class="stats">${[['Prospect value', usdC(sum(pd, p => p.prospect)), 'from Pending Deals'], ['Inspection value', usdC(sum(pd, p => p.ival)), 'stock inspected'], ['Deal value', usdC(sum(pd, p => p.dval)), 'advance approved'],
    ['Disbursed', usdC(sum(pd, p => p.disb)), pct(sum(pd, p => p.dval) ? sum(pd, p => p.disb) / sum(pd, p => p.dval) : 0, 0) + ' of deal value'], ['Pending disbursement', usdC(sum(pd, p => p.pend)), plural(pd.filter(p => p.pend > 0).length, 'deal')]]
    .map(([l, v, s]) => `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="card"><h2>Pending deals</h2><p class="sub">Inspection-to-disbursement tracker from the Pending Deals sheet.</p>
    <div class="tw mt"><table><thead><tr><th>Company</th><th>Inspection date</th><th class="r">Prospect value</th><th class="r">Inspection value</th><th class="r">Deal value</th><th>Disbursed</th><th class="r">Pending</th><th>Remarks</th></tr></thead>
    <tbody>${pd.map(p => `<tr><td>${P.reg.get(p.co) ? coLink(p.co) : esc(p.co)}</td><td>${p.idate != null ? fmtD(p.idate) : esc(p.idateRaw) || '—'}</td><td class="r">${usd(p.prospect)}</td><td class="r">${usd(p.ival)}</td><td class="r">${usd(p.dval)}</td>
      <td><div class="prog"><span class="t"><span style="width:${p.dval ? Math.min(100, p.disb / p.dval * 100) : 0}%"></span></span>${usd(p.disb)}</div></td><td class="r ${p.pend > 1 ? 'neg' : ''}">${p.pend > 1 ? usd(p.pend) : '—'}</td><td class="clip" style="max-width:300px" title="${esc(p.rem)}">${esc(p.rem)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="2">Total</td><td class="r">${usd(sum(pd, p => p.prospect))}</td><td class="r">${usd(sum(pd, p => p.ival))}</td><td class="r">${usd(sum(pd, p => p.dval))}</td><td>${usd(sum(pd, p => p.disb))}</td><td class="r">${usd(sum(pd, p => p.pend))}</td><td></td></tr></tbody></table></div></div>
  <div class="grid g-2 mt">
    <div class="card"><h2>Inspection projection</h2><p class="sub">Next deals each facility could take, from the projection table in Pending Deals. Headroom is available limit after repayments.</p>
      <div class="tw mt"><table><thead><tr><th>Company</th><th class="r">Headroom</th><th class="r">Required asset value</th><th class="r">Expected inspection</th><th class="r">Expected deal</th><th>Product</th><th>Timing</th></tr></thead>
      <tbody>${pj.map(p => `<tr><td>${P.reg.get(p.co) ? coLink(p.co) : esc(p.co)}</td><td class="r ${p.avail < 0 ? 'neg' : ''}">${usd(p.avail)}</td><td class="r">${p.req ? usd(p.req) : '—'}</td><td class="r">${p.einsp ? usd(p.einsp) : '—'}</td><td class="r">${p.edeal ? usd(p.edeal) : '—'}</td><td>${esc(p.prod)}</td><td>${esc(p.status || p.when) || '—'}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="r">${usd(sum(pj, p => p.avail))}</td><td class="r">${usd(sum(pj, p => p.req))}</td><td class="r">${usd(sum(pj, p => p.einsp))}</td><td class="r">${usd(sum(pj, p => p.edeal))}</td><td colspan="2"></td></tr></tbody></table></div></div>
    <div class="card"><h2>Client onboarding</h2><p class="sub">Company Master status for all ${cms.length} entities on file.</p>
      <div class="hbars mt">${st.map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><span class="t"><span style="width:${v / cms.length * 100}%;background:${/active/i.test(k) ? 'var(--teal)' : /retir/i.test(k) ? 'var(--liq)' : /rej/i.test(k) ? 'var(--red)' : '#8A94A2'}"></span></span><span class="n">${v}</span></div>`).join('')}</div>
      <div class="tw mt"><table><thead><tr><th>Company</th><th>Status</th><th>Next step recorded</th></tr></thead><tbody>${notLive.map(c => `<tr><td>${esc(c.short)}</td><td>${esc(c.mstatus)}</td><td class="muted wrap">${esc(c.remarks) || '—'}</td></tr>`).join('')}</tbody></table></div></div>
  </div>`;
}

/* ---------- Deal register ---------- */
const REG_COLS = [
  ['id', 'Txn', d => d.id], ['co', 'Company', d => P.reg.get(d.co)?.short || d.co], ['ref', 'Facility ref', d => d.ref], ['disb', 'Disbursed on', d => d.disb], ['due', 'Due date', d => d.due],
  ['ten', 'Tenure', d => d.ten], ['ev', 'Collateral value', d => d.ev], ['deal', 'Deal amount', d => d.deal], ['amt', 'Disbursed', d => d.amt], ['out', 'Outstanding', d => d.out],
  ['dpd', 'Days past due', d => d.overdue ? d.dpd : null], ['status', 'Status', d => d.status], ['prod', 'Products', d => d.prod]];
function regRows(){
  const R = STATE.reg, q = R.q.toLowerCase();
  let rows = M.deals.filter(d => R.status === 'all' ? true : R.status === 'live' ? d.live : R.status === 'overdue' ? d.overdue : !d.live);
  if (q) rows = rows.filter(d => [d.id, d.co, d.ref, d.prod, d.inv, d.status].join(' ').toLowerCase().includes(q));
  const col = REG_COLS.find(c => c[0] === R.sort) || REG_COLS[4];
  rows.sort((a, b) => { const x = col[2](a), y = col[2](b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * R.dir; });
  return rows;
}
function renderRegister(){
  const R = STATE.reg; const rows = regRows();
  const stChip = d => d.live ? (d.overdue ? `<i class="chip red" style="margin:0">Overdue</i>` : `<i class="chip amber" style="margin:0">Live</i>`) : (/settled/i.test(d.status) ? `<i class="chip green" style="margin:0">Settled</i>` : `<i class="chip grey" style="margin:0">${esc(d.status || 'No status')}</i>`);
  const num = k => ['ten', 'ev', 'deal', 'amt', 'out', 'dpd'].includes(k);
  $('#tab-register').innerHTML = `<div class="card"><div class="card-h"><div><h2>Deal register</h2><p class="sub">${plural(rows.length, 'row')} from Transactions Master. Click a column heading to sort.</p></div>
    <div class="toolbar"><input type="search" id="regQ" placeholder="Search company, Txn, ref or product" value="${esc(R.q)}" aria-label="Search deals">
    <select id="regS" aria-label="Deal status">${[['live', 'Live deals'], ['overdue', 'Overdue only'], ['closed', 'Settled or closed'], ['all', 'All rows']].map(([k, l]) => `<option value="${k}" ${R.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button class="btn light" id="regCsv">Export CSV</button></div></div>
    <div class="tw" style="max-height:640px;overflow:auto"><table><thead><tr>${REG_COLS.map(([k, l]) => `<th class="sort ${num(k) ? 'r' : ''}" data-k="${k}" data-dir="${R.sort === k ? R.dir : ''}">${l}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(d => `<tr><td>${esc(d.id)}</td><td>${coLink(d.co)}</td><td>${esc(d.ref)}</td><td>${fmtD(d.disb)}</td><td>${fmtD(d.due)}</td><td class="r">${d.ten ?? '—'}</td><td class="r">${usd(d.ev)}</td>
      <td class="r">${usd(d.deal)}</td><td class="r">${usd(d.amt)}</td><td class="r"><b>${d.out ? usd(d.out) : '—'}</b></td><td class="r">${d.overdue ? d.dpd : ''}</td><td>${stChip(d)}</td><td class="clip" title="${esc(d.prod)}">${esc(d.prod)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="7">Total</td><td class="r">${usd(sum(rows, d => d.deal))}</td><td class="r">${usd(sum(rows, d => d.amt))}</td><td class="r">${usd(sum(rows, d => d.out))}</td><td colspan="3"></td></tr></tbody></table></div></div>`;
  const q = $('#regQ'); q.addEventListener('input', () => { R.q = q.value; const pos = q.selectionStart; renderRegister(); const n = $('#regQ'); n.focus(); n.setSelectionRange(pos, pos); });
  $('#regS').addEventListener('change', e => { R.status = e.target.value; renderRegister(); });
  $$('#tab-register th.sort').forEach(th => th.addEventListener('click', () => { const k = th.dataset.k; if (R.sort === k) R.dir *= -1; else { R.sort = k; R.dir = num(k) ? -1 : 1; } renderRegister(); }));
  $('#regCsv').addEventListener('click', () => {
    const head = ['Txn ID', 'Company', 'Facility Ref', 'Disbursement Date', 'Due Date', 'Tenure (months)', 'Evaluation Value', 'Deal Amount', 'Disbursed Amount', 'Outstanding', 'Days Past Due', 'Status', 'Products'];
    const lines = [head, ...regRows().map(d => [d.id, d.co, d.ref, d.disb != null ? isoD(d.disb) : '', d.due != null ? isoD(d.due) : '', d.ten ?? '', d.ev ?? '', d.deal ?? '', d.amt ?? '', d.out, d.overdue ? d.dpd : '', d.status, d.prod])];
    const csv = lines.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], {type: 'text/csv'})); a.download = `deal-register-${isoD(M.asof)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

/* ---------- Data checks ---------- */
function renderChecks(){
  const C = M.checks; const order = {high: 0, med: 1, low: 2}; C.sort((a, b) => order[a.sev] - order[b.sev]);
  const lab = {high: 'High priority', med: 'Review', low: 'Housekeeping'};
  $('#tab-checks').innerHTML = `<div class="card" style="margin-bottom:14px"><h2>Data checks</h2><p class="sub">Run automatically on every load against Transactions Master, Custodian Master, Payment Receipts and Dashboard Data. Fixing these in the MIS keeps the bank and investor reporting consistent.</p></div>
    <div class="checks">${C.length ? C.map(c => `<div class="check"><span class="bar sev-${c.sev}"></span><div><h3>${esc(c.title)}</h3><div class="meta">${lab[c.sev]}${c.impact ? `, amount involved $${usd(c.impact)}` : ''}</div><p>${esc(c.body)}</p>
      <ul>${c.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div></div>`).join('') : '<div class="card empty">No issues found.</div>'}</div>`;
}

/* ---------- Company drawer ---------- */
function openDrawer(name){
  const co = P.reg.get(name); if (!co) return;
  const L = M.deals.filter(d => d.co === co.name && d.live).sort((a, b) => (a.due || 0) - (b.due || 0));
  const f = M.fac.find(x => x.co === co.name) || compute(P, STATE.asof, 'all', STATE.invRate).fac.find(x => x.co === co.name);
  const fo = P.fees.filter(x => x.co === co.name && x.status === 'Outstanding' && x.due != null && x.due < M.asof && x.cur > 0);
  const cash = P.cash.filter(x => x.co === co.name && x.date != null).sort((a, b) => b.date - a.date).slice(0, 8);
  const pend = P.pending.filter(p => p.co === co.name);
  const scaleMax = f ? Math.max(f.exp, f.limit || 0) * 1.04 : 1;
  $('#drawer').innerHTML = `<div class="dh"><button class="x" id="dClose">Close</button><h2>${esc(co.name)}</h2>
    <p>${[co.seg === 'liq' ? 'Liquidating stock' : co.seg === 'active' ? 'Active facility' : '', co.comm, co.owner ? 'Owner ' + co.owner : '', co.parent && ckey(co.parent) !== co.key ? 'Parent ' + co.parent : ''].filter(Boolean).map(esc).join('. ')}</p></div>
    <div class="db">${f ? `<div class="board" style="margin:4px 0 14px">${boardHTML([f], scaleMax).replace('style="width:0"', `style="width:${(f.exp / scaleMax * 100).toFixed(2)}%"`)}</div>
      <div class="dstats">${[['Limit', usdC(f.limit)], ['Outstanding', usdC(f.exp)], ['Available', usdC(f.avail)], ['Overdue', usdC(f.od)], ['Due in 60 days', usdC(f.d60)], ['Fees overdue', usdC(sum(fo, x => x.cur))]].map(([l, v]) => `<div><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>` : ''}
      <h3>Live deals</h3>${L.length ? `<table><thead><tr><th>Txn</th><th>Due</th><th class="r">Days</th><th class="r">Outstanding</th></tr></thead><tbody>${L.map(d => `<tr><td>${esc(d.id)}<div class="muted" style="font-size:12px">${esc(d.ref)}</div></td><td>${fmtD(d.due)}</td>
        <td class="r ${d.overdue ? 'neg' : ''}">${d.overdue ? d.dpd + ' late' : (d.due - M.asof) + ' to go'}</td><td class="r">${usd(d.out)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No live deals.</p>'}
      <h3>Custodian fees past due</h3>${fo.length ? `<table><thead><tr><th>Txn</th><th>Due</th><th class="r">Invoice</th><th class="r">Current due</th></tr></thead><tbody>${fo.map(x => `<tr><td>${esc(x.id)}</td><td>${fmtD(x.due)}</td><td class="r">${usd(x.amt)}</td><td class="r">${usd(x.cur)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">None past due.</p>'}
      ${pend.length ? `<h3>Pipeline</h3><table><tbody>${pend.map(p => `<tr><td class="wrap">${esc(p.rem)}</td><td class="r">${usd(p.dval)}</td><td class="r ${p.pend > 1 ? 'neg' : ''}">${p.pend > 1 ? usd(p.pend) + ' pending' : 'funded'}</td></tr>`).join('')}</tbody></table>` : ''}
      <h3>Recent cash entries</h3>${cash.length ? `<table><tbody>${cash.map(x => `<tr><td>${fmtD(x.date)}</td><td class="clip">${esc(x.deal)}</td><td class="r">${x.pay ? '+' + usd(x.pay) : '-' + usd(x.rec)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No entries in the payment log.</p>'}
      <p class="mt"><button class="btn light" id="dReg">Show all deals in the register</button></p></div>`;
  $('#drawer').classList.add('open'); $('#scrim').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#dClose').focus();
  $('#dClose').onclick = closeDrawer;
  $('#dReg').onclick = () => { STATE.reg.q = co.short; STATE.reg.status = 'all'; closeDrawer(); renderRegister(); goTab('register'); };
}
function closeDrawer(){ $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); }

/* =========================================================
   Events
   ========================================================= */
function goTab(t){ STATE.tab = t; $$('#tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t)); $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t)); window.scrollTo({top: 0}); }
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) goTab(b.dataset.tab); });
$$('.segctl button').forEach(b => b.addEventListener('click', () => { STATE.seg = b.dataset.seg; $$('.segctl button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderAll(); }));
$('#asof').addEventListener('change', e => { const d = toDay(e.target.value); if (d != null){ STATE.asof = d; renderAll(); } });
$('#printBtn').addEventListener('click', () => window.print());
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
document.addEventListener('click', e => {
  tip.style.opacity = 0;
  const co = e.target.closest('[data-co]'); if (co){ openDrawer(co.dataset.co); return; }
  const row = e.target.closest('[data-co-row]'); if (row){ openDrawer(row.dataset.coRow); return; }
  const go = e.target.closest('[data-go]'); if (go){ goTab(go.dataset.go); return; }
  const sb = e.target.closest('[data-sortboard]'); if (sb){ STATE.sortBoard = sb.dataset.sortboard; renderOverview(); }
});
const tip = $('#tip');
document.addEventListener('mousemove', e => { const t = e.target.closest('[data-tip]'); if (!t){ tip.style.opacity = 0; return; }
  tip.textContent = t.getAttribute('data-tip'); tip.style.opacity = 1; const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 14) + 'px'; tip.style.top = (e.clientY + h + 24 > window.innerHeight ? e.clientY - h - 12 : e.clientY + 16) + 'px'; });

function toast(msg, err){ const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = 'none', err ? 7000 : 3500); }

/* Reload from a newer MIS workbook (parsed in the browser, nothing uploaded) */
const NEED = {'Transactions Master': 17, 'Company Master': 13, 'Dashboard Data': 11, 'Payment Receipts': 6, 'Custodian Master': 16, 'Pending Deals': 8};
// Excel reader: use the copy hosted next to the dashboard first (works on offline intranets), then the public CDN.
const XLSX_SOURCES = ['xlsx.full.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'];
function loadScript(src){ return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(); }; document.head.appendChild(s); }); }
async function loadXLSXLib(){
  if (window.XLSX) return;
  for (const src of XLSX_SOURCES){ try { await loadScript(src); if (window.XLSX) return; } catch (e) { /* try next source */ } }
  throw new Error('Could not load the spreadsheet reader. Place xlsx.full.min.js next to the dashboard, or check the internet connection.');
}
function sheetGrid(ws, nc){
  if (!ws || !ws['!ref']) return []; const rg = XLSX.utils.decode_range(ws['!ref']); const out = [];
  for (let r = 0; r <= rg.e.r; r++){ const row = []; for (let c = 0; c < nc; c++){ const cl = ws[XLSX.utils.encode_cell({r, c})]; let v = null;
      if (cl){ if (cl.t === 'e') v = cl.w || '#ERR'; else if (cl.t === 'd') v = new Date(cl.v.getTime() - cl.v.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
        else if (cl.t === 'n') v = (cl.z && XLSX.SSF.is_date(cl.z)) ? isoD(Math.floor(cl.v + 1e-9) - 25569) : cl.v; else if (cl.t === 'b') v = cl.v; else if (cl.v != null) v = String(cl.v); }
      row.push(v); } out.push(row); }
  while (out.length && out[out.length - 1].every(v => v == null)) out.pop(); return out;
}
$('#file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return; toast('Reading ' + file.name + '…');
  try { await loadXLSXLib(); const wb = XLSX.read(await file.arrayBuffer(), {type: 'array', cellNF: true, cellDates: false});
    const sheets = {}; for (const [n, nc] of Object.entries(NEED)){ const key = wb.SheetNames.find(s => s.trim().toLowerCase() === n.toLowerCase()); if (key) sheets[n] = sheetGrid(wb.Sheets[key], nc); }
    const t = new Date(); const newRaw = {meta: {source: file.name, extracted: isoD(ymd(t.getFullYear(), t.getMonth() + 1, t.getDate()))}, sheets};
    const np = parse(newRaw); RAW = newRaw; P = np; renderAll(); toast(`Loaded ${file.name}: ${np.deals.length} deals, ${np.fees.length} fee invoices, ${np.cash.length} cash entries.`);
  } catch (err){ console.error(err); toast(err.message || String(err), true); }
  e.target.value = '';
});

/* Boot */
try { P = parse(RAW); renderAll(); } catch (err){ document.querySelector('main').innerHTML = `<div class="card"><h2>Couldn't read the MIS data</h2><p class="sub">${esc(err.message)}</p></div>`; }
