// Settle Up — Cloudflare Worker + Durable Object
// Serves the API under /api/*. The UI (public/index.html) is served by Workers Static Assets.

const SW_BASE = "https://secure.splitwise.com/api/v3.0";
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
function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------------- validation of gathering data ---------------- */
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
  const e = { id: /^[A-Za-z0-9]{4,12}$/.test(x.id || "") ? x.id : rid(8), kind, desc: str(x.desc, 80) || "Cost", created: Number(x.created) || Date.now() };
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
      s = { name: str(body.name, 60) || "Our group", created: Date.now(), swGroupId: null, members: [], events: [] };
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
      if (body.swGroupId !== undefined) s.swGroupId = body.swGroupId ? digits(body.swGroupId, 20) : null;
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
        if (m.swId !== undefined) ex.swId = m.swId ? digits(m.swId, 20) : null;
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

    // POST /events  {name, note, mode, hub, people, expenses, payments, swGroupId}
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
        hub: ids.has(body.hub) ? body.hub : null,
        source: str(body.source, 20),
        swGroupId: body.swGroupId ? digits(body.swGroupId, 20) : null,
        created: Date.now(),
        payments,
      };
      if (ledger) { ev.people = cleanPeople(body.people, ids); ev.expenses = expenses; }
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
    // POST /events/:id/recorded {pid, swExpenseId}
    if (ev && c === "recorded" && method === "POST") {
      const p = ev.payments.find((x) => x.id === body.pid);
      if (!p) return json({ error: "Payment not found" }, 404);
      p.swExpenseId = digits(body.swExpenseId, 20) || null;
      return save();
    }
    return json({ error: "Unknown request" }, 404);
  }
}

/* ---------------- Splitwise ---------------- */
async function sw(env, path, init = {}) {
  const res = await fetch(SW_BASE + path, {
    ...init,
    headers: { Authorization: "Bearer " + env.SPLITWISE_API_KEY, "content-type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`Splitwise ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}
const swName = (u) => [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "User " + u.id;

async function handleSplitwise(request, env, rest) {
  if (!env.SPLITWISE_API_KEY) return json({ error: "Splitwise isn't set up on this server" }, 400);
  if (!env.ORGANIZER_PIN) return json({ error: "Set ORGANIZER_PIN on the server to use Splitwise" }, 400);
  if (!safeEqual(request.headers.get("x-organizer-pin"), env.ORGANIZER_PIN))
    return json({ error: "Wrong organizer PIN" }, 401);

  // GET /api/splitwise/groups
  if (rest === "/groups" && request.method === "GET") {
    const d = await sw(env, "/get_groups");
    const groups = (d.groups || [])
      .filter((g) => g.id !== 0) // 0 = "non-group expenses"
      .map((g) => ({ id: String(g.id), name: g.name, members: (g.members || []).length, updated: g.updated_at }));
    return json({ groups });
  }
  // GET /api/splitwise/groups/:id  -> members with VND net balances
  let m = rest.match(/^\/groups\/(\d{1,20})$/);
  if (m && request.method === "GET") {
    const d = await sw(env, "/get_group/" + m[1]);
    const g = d.group;
    if (!g) return json({ error: "Splitwise group not found" }, 404);
    const currencies = new Set();
    const members = (g.members || []).map((u) => {
      let vnd = 0;
      for (const b of u.balance || []) {
        currencies.add(b.currency_code);
        if (b.currency_code === "VND") vnd += Number(b.amount) || 0;
      }
      return { swId: String(u.id), name: swName(u), balance: vnd };
    });
    currencies.delete("VND");
    return json({ id: String(g.id), name: g.name, members, otherCurrencies: [...currencies] });
  }
  // POST /api/splitwise/payment {swGroupId, fromSwId, toSwId, amount, description}
  if (rest === "/payment" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const amount = int(b.amount);
    const groupId = digits(b.swGroupId, 20), from = digits(b.fromSwId, 20), to = digits(b.toSwId, 20);
    if (!amount || !groupId || !from || !to) return json({ error: "Missing payment details" }, 400);
    const cost = amount.toFixed(2);
    const d = await sw(env, "/create_expense", {
      method: "POST",
      body: JSON.stringify({
        cost,
        description: str(b.description, 60) || "Settle up (VietQR)",
        payment: true,
        currency_code: "VND",
        group_id: Number(groupId),
        users__0__user_id: Number(from),
        users__0__paid_share: cost,
        users__0__owed_share: "0.00",
        users__1__user_id: Number(to),
        users__1__paid_share: "0.00",
        users__1__owed_share: cost,
      }),
    });
    const errs = d.errors && Object.keys(d.errors).length ? d.errors : null;
    if (errs) return json({ error: "Splitwise said: " + JSON.stringify(errs).slice(0, 200) }, 400);
    const exp = (d.expenses || [])[0];
    return json({ ok: true, expenseId: exp ? String(exp.id) : null });
  }
  return json({ error: "Unknown Splitwise request" }, 404);
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/config" && request.method === "GET")
        return json({ splitwise: !!(env.SPLITWISE_API_KEY && env.ORGANIZER_PIN) });

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

      if (p.startsWith("/api/splitwise")) return await handleSplitwise(request, env, p.slice("/api/splitwise".length));

      if (p.startsWith("/api/")) return json({ error: "Not found" }, 404);
      // Anything else: let static assets (SPA) handle it.
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e).slice(0, 300) }, 502);
    }
  },
};
