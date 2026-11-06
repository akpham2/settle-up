// Settle Up — Cloudflare Worker + Durable Object (shared costs, VietQR / PayPal payback)
// Serves the API under /api/*. The UI (public/index.html) is served by Workers Static Assets.

// Supported currencies and their minor-unit decimals. Amounts are stored as integers in minor units.
const CUR = { VND: 0, AUD: 2, USD: 2, NZD: 2, EUR: 2, GBP: 2, SGD: 2, CAD: 2, HKD: 2, THB: 2, JPY: 0, KRW: 0 };
const cur = (v, d = "VND") => (Object.hasOwn(CUR, v) ? v : d);
const LIMITS = { members: 150, events: 300, payments: 150, expenses: 300, parts: 80 };

/* ---------------- helpers ---------------- */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const str = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const digits = (v, max) => String(v ?? "").replace(/\D/g, "").slice(0, max);
const acct = (v) => String(v ?? "").replace(/[^0-9A-Za-z]/g, "").slice(0, 24);
const int = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 && n < 1e12 ? n : 0;
};
function rid(len = 10) {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
/* ---------------- validation of gathering data ---------------- */
function cleanRates(r, base) {
  const out = {};
  for (const [k, v] of Object.entries(r && typeof r === "object" ? r : {})) {
    const n = Number(v);
    if (Object.hasOwn(CUR, k) && k !== base && Number.isFinite(n) && n > 1e-9 && n < 1e9) out[k] = n;
  }
  return out;
}
const sint = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && Math.abs(n) < 1e12 ? n : 0; };
function cleanPeople(list, ids) {
  const seen = new Set(), out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const id = str(p && p.id, 20), w = Number(p && p.w);
    if (!ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, w: Number.isFinite(w) && w > 0 && w <= 20 ? Math.round(w * 100) / 100 : 1 });
    if (out.length >= LIMITS.parts) break;
  }
  return out;
}
// kinds: split (equal by shares), exact (fixed amounts), net (imported balances that sum to 0)
function cleanExpense(x, ids) {
  if (!x || typeof x !== "object") return { error: "Bad cost" };
  const kind = ["split", "exact", "net"].includes(x.kind) ? x.kind : "split";
  const e = { id: /^[A-Za-z0-9]{4,12}$/.test(x.id || "") ? x.id : rid(8), kind, cur: cur(x.cur), desc: str(x.desc, 80) || "Cost", created: Number(x.created) || Date.now() };
  if (kind === "net") {
    const nets = {};
    let sum = 0, any = false;
    for (const [id, v] of Object.entries(x.nets || {})) {
      if (!ids.has(id)) return { error: "Unknown person in imported balances" };
      const n = sint(v); if (n) { nets[id] = n; sum += n; any = true; }
    }
    if (!any) return { error: "Nothing to import" };
    if (sum !== 0) return { error: "Imported balances must add up to zero" };
    e.nets = nets; e.amt = int(x.amt) || 0;
    return { e };
  }
  e.amt = int(x.amt);
  if (!e.amt) return { error: "Enter an amount" };
  e.payer = str(x.payer, 20);
  if (!ids.has(e.payer)) return { error: "Choose who paid" };
  if (kind === "split") {
    e.parts = cleanPeople(x.parts, ids);
    if (!e.parts.length) return { error: "Choose who shares this cost" };
  } else {
    const seen = new Set(); e.parts = []; let sum = 0;
    for (const p of Array.isArray(x.parts) ? x.parts : []) {
      const id = str(p && p.id, 20), a = int(p && p.amt);
      if (!ids.has(id) || seen.has(id) || !a) continue;
      seen.add(id); e.parts.push({ id, amt: a }); sum += a;
    }
    if (!e.parts.length) return { error: "Enter at least one amount" };
    if (sum !== e.amt) return { error: `Amounts add up to ${sum}, not ${e.amt}` };
  }
  return { e };
}
function cleanPayments(list, ids) {
  return (Array.isArray(list) ? list : [])
    .slice(0, LIMITS.payments)
    .map((p) => ({ id: rid(6), from: str(p.from, 20), to: str(p.to, 20), amt: int(p.amt), paid: false }))
    .filter((p) => p.amt && ids.has(p.from) && ids.has(p.to) && p.from !== p.to);
}

/* ---------------- Durable Object: one per group ---------------- */
export class Group {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;
    const body = method === "GET" || method === "DELETE" ? {} : await request.json().catch(() => ({}));
    let s = await this.storage.get("state");

    if (parts[0] === "init" && method === "POST") {
      if (s) return json({ error: "exists" }, 409);
      s = { name: str(body.name, 60) || "Our group", created: Date.now(), members: [], events: [] };
      await this.storage.put("state", s);
      return json(s);
    }
    if (!s) return json({ error: "Group not found" }, 404);
    const save = async () => { await this.storage.put("state", s); return json(s); };
    const [a, b, c] = parts;

    // GET /state
    if (a === "state" && method === "GET") return json(s);

    // POST /group {name}
    if (a === "group" && method === "POST") {
      if (body.name !== undefined) s.name = str(body.name, 60) || s.name;
      return save();
    }

    // POST /members  (upsert one or many)  body: {member} or {members:[...]}
    if (a === "members" && method === "POST" && !b) {
      const list = Array.isArray(body.members) ? body.members : [body.member || body];
      const out = [];
      for (const m of list) {
        const name = str(m.name, 60);
        if (!name) continue;
        let ex = m.id ? s.members.find((x) => x.id === m.id) : null;
        if (!ex) {
          if (s.members.length >= LIMITS.members) return json({ error: "Too many people in this group" }, 400);
          ex = { id: rid(8), created: Date.now() };
          s.members.push(ex);
        }
        ex.name = name;
        if (m.bin !== undefined) ex.bin = digits(m.bin, 6);
        if (m.acc !== undefined) ex.acc = acct(m.acc);
        if (m.holder !== undefined) ex.holder = str(m.holder, 60).toUpperCase();
        if (m.paypal !== undefined) ex.paypal = String(m.paypal ?? "").trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?paypal\.me\//i, "").replace(/[^A-Za-z0-9@._+\-]/g, "").slice(0, 80);
        ex.updated = Date.now();
        out.push(ex);
      }
      await this.storage.put("state", s);
      return json({ state: s, members: out });
    }

    // DELETE /members/:id
    if (a === "members" && b && method === "DELETE") {
      const used = s.events.some((e) => e.payments.some((p) => !p.paid && (p.from === b || p.to === b)));
      if (used) return json({ error: "This person still has unpaid payments in a gathering." }, 400);
      s.members = s.members.filter((m) => m.id !== b);
      return save();
    }

    // POST /events  {name, note, cur, rates, mode, hub, people, expenses, payments}
    if (a === "events" && method === "POST" && !b) {
      if (s.events.length >= LIMITS.events) return json({ error: "Too many gatherings; delete some old ones" }, 400);
      const ids = new Set(s.members.map((m) => m.id));
      const expenses = [];
      for (const x of (Array.isArray(body.expenses) ? body.expenses : []).slice(0, LIMITS.expenses)) {
        const r = cleanExpense(x, ids); if (r.error) return json({ error: r.error }, 400); expenses.push(r.e);
      }
      const payments = cleanPayments(body.payments, ids);
      const ledger = Array.isArray(body.expenses) || Array.isArray(body.people);
      if (!ledger && !payments.length) return json({ error: "No valid payments" }, 400);
      const ev = {
        id: rid(8),
        name: str(body.name, 60) || "Gathering",
        note: str(body.note, 40),
        mode: ["direct", "hub", "typed"].includes(body.mode) ? body.mode : "direct",
        cur: cur(body.cur),
        hub: ids.has(body.hub) ? body.hub : null,
        source: str(body.source, 20),
        created: Date.now(),
        payments,
      };
      if (ledger) { ev.people = cleanPeople(body.people, ids); ev.expenses = expenses; ev.rates = cleanRates(body.rates, ev.cur); }
      s.events.unshift(ev);
      await this.storage.put("state", s);
      return json({ state: s, event: ev });
    }

    const ev = a === "events" && b ? s.events.find((e) => e.id === b) : null;
    if (a === "events" && b && !ev) return json({ error: "Gathering not found" }, 404);

    // DELETE /events/:id
    if (ev && !c && method === "DELETE") {
      s.events = s.events.filter((e) => e !== ev);
      return save();
    }
    // POST /events/:id  {name, note}
    if (ev && !c && method === "POST") {
      if (body.name !== undefined) ev.name = str(body.name, 60) || ev.name;
      if (body.note !== undefined) ev.note = str(body.note, 40);
      const ids = new Set(s.members.map((m) => m.id));
      if (["direct", "hub"].includes(body.mode)) ev.mode = body.mode;
      if (body.hub !== undefined) ev.hub = ids.has(body.hub) ? body.hub : null;
      if (body.people !== undefined) ev.people = cleanPeople(body.people, ids);
      if (body.cur !== undefined && cur(body.cur) !== (ev.cur || "VND")) {
        if (ev.payments.some((p) => p.paid)) return json({ error: "Some payments are already marked paid, so the settle currency can't change. Undo them first." }, 400);
        ev.cur = cur(body.cur);
      }
      if (body.rates !== undefined) ev.rates = cleanRates(body.rates, ev.cur || "VND");
      if (body.payments !== undefined) { // replace the unpaid part of the plan; paid ones are kept
        ev.payments = [...ev.payments.filter((p) => p.paid), ...cleanPayments(body.payments, ids)];
      }
      return save();
    }
    // POST /events/:id/expenses {expense, payments?}  (upsert; optional new plan for unpaid payments)
    if (ev && c === "expenses" && method === "POST" && !parts[3]) {
      const ids = new Set(s.members.map((m) => m.id));
      if (!ev.expenses) ev.expenses = [];
      const list = Array.isArray(body.expenses) ? body.expenses : [body.expense];
      for (const x of list) {
        const r = cleanExpense(x, ids); if (r.error) return json({ error: r.error }, 400);
        const i = ev.expenses.findIndex((e) => e.id === r.e.id);
        if (i >= 0) ev.expenses[i] = { ...r.e, created: ev.expenses[i].created };
        else { if (ev.expenses.length >= LIMITS.expenses) return json({ error: "Too many costs" }, 400); ev.expenses.push(r.e); }
      }
      if (body.rates) ev.rates = cleanRates({ ...(ev.rates || {}), ...body.rates }, ev.cur || "VND");
      if (Array.isArray(body.payments)) ev.payments = [...ev.payments.filter((p) => p.paid), ...cleanPayments(body.payments, ids)];
      return save();
    }
    // DELETE /events/:id/expenses/:xid  (body-less; plan updated by a following POST /events/:id)
    if (ev && c === "expenses" && parts[3] && method === "DELETE") {
      ev.expenses = (ev.expenses || []).filter((e) => e.id !== parts[3]);
      return save();
    }
    // POST /events/:id/paid {pid, paid}
    if (ev && c === "paid" && method === "POST") {
      const p = ev.payments.find((x) => x.id === body.pid);
      if (!p) return json({ error: "Payment not found" }, 404);
      p.paid = !!body.paid;
      p.paidAt = p.paid ? Date.now() : null;
      return save();
    }
    return json({ error: "Unknown request" }, 404);
  }
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      // GET /api/rates?base=AUD -> { base, date, rates: { USD: <AUD per 1 USD>, ... } }
      if (p === "/api/rates" && request.method === "GET") {
        const base = cur(url.searchParams.get("base"), "");
        if (!base) return json({ error: "Unsupported currency" }, 400);
        const cacheKey = new Request("https://rates.cache/" + base);
        const cache = typeof caches !== "undefined" ? caches.default : null;
        let hit = cache ? await cache.match(cacheKey) : null;
        if (hit) return hit;
        const r = await fetch("https://open.er-api.com/v6/latest/" + base);
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.result !== "success" || !d.rates) return json({ error: "Couldn't get exchange rates right now" }, 502);
        const rates = {};
        for (const k of Object.keys(CUR)) if (k !== base && d.rates[k] > 0) rates[k] = 1 / d.rates[k];
        const res = new Response(JSON.stringify({ base, date: d.time_last_update_utc || null, rates, source: "https://www.exchangerate-api.com" }), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=21600" },
        });
        if (cache) await cache.put(cacheKey, res.clone());
        return res;
      }

      if (p === "/api/groups" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const gid = rid(12);
        const stub = env.GROUPS.get(env.GROUPS.idFromName(gid));
        const res = await stub.fetch("https://group/init", { method: "POST", body: JSON.stringify({ name: body.name }) });
        if (!res.ok) return res;
        return json({ id: gid });
      }

      const gm = p.match(/^\/api\/g\/([A-Za-z0-9]{12})(\/.*)?$/);
      if (gm) {
        const stub = env.GROUPS.get(env.GROUPS.idFromName(gm[1]));
        const init = { method: request.method, headers: { "content-type": "application/json" } };
        if (!["GET", "DELETE"].includes(request.method)) init.body = await request.text();
        return stub.fetch("https://group" + (gm[2] || "/state"), init);
      }

      if (p.startsWith("/api/")) return json({ error: "Not found" }, 404);
      // Anything else: let static assets (SPA) handle it.
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e).slice(0, 300) }, 502);
    }
  },
};
