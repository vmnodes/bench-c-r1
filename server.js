// server.js: the whole app. A loan list: people with the "loans.keeper" role see what is
// out (the item, who has it, when they took it, when it is due back), add a loan, and
// mark it returned. Loans are kept in the app's database and are never deleted.
//
// APP_NAME is the name the app was put online as: the platform sets VMNODES_APP_NAME.
const http = require("node:http");
const crypto = require("node:crypto");
const { VmnodesIdentity, IdentityError } = require("@vmnodes/identity");
const { openStore, byDueThenTaken } = require("./store");

const APP_NAME = process.env.VMNODES_APP_NAME || "loans";
// Must match the role name in vmnodes.json exactly.
const KEEPER_ROLE = "loans.keeper";
const VERSION = require("./package.json").version;
// Set when the image is built (see Dockerfile). Reported as-is, never guessed.
const BUILD_COMMIT = process.env.BUILD_COMMIT || null;
// The platform does NOT set PORT: traffic goes to port 3000, fixed. (PORT is for local tests.)
const PORT = Number(process.env.PORT || 3000);
const LISTEN_ADDRESS = process.env.LISTEN_ADDRESS || undefined;
// "Today" decides the default taken-on date and what counts as overdue. Dates are calendar
// dates, so they are read in the organisation's own time zone, not the server's (UTC).
const TIMEZONE = process.env.LOANS_TIMEZONE || "Australia/Sydney";

let identity;
try {
  identity = new VmnodesIdentity();
} catch (err) {
  console.error(`${err.message}\nThe platform sets these when your app is deployed; locally, \`npm run dev\` sets them for you.`);
  process.exit(1);
}
const store = openStore();

const KEPT = {
  postgres: "Loans are kept in this app's database, across restarts and updates. Returned loans stay on the list as history.",
  memory: "Loans are kept in memory, so they are cleared when the app restarts or is updated.",
};
const LIMITS = { item: 100, borrower: 100 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Today's calendar date, "YYYY-MM-DD", in the organisation's time zone.
function today(now = new Date(), timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// A real calendar date in "YYYY-MM-DD" form: 2026-02-30 is not one.
function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new IdentityError("body too large", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Reads the fields from a form post or a JSON post. Trims, and never trusts the types.
async function readFields(req, names) {
  const raw = await readBody(req);
  const json = (req.headers["content-type"] || "").includes("application/json");
  const o = json ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new SyntaxError("body must be an object");
  return Object.fromEntries(names.map((n) => [n, typeof o[n] === "string" ? o[n].trim() : ""]));
}

// The server-side checks. The form's `required` and `maxlength` are a courtesy to people;
// this is what actually decides, because anyone can send a request without the form.
// Returns { problem } or { loan: { id, item, borrower, takenOn, dueOn } }.
function checkNewLoan(f, todayDate) {
  if (!f.item) return { problem: "item is required" };
  if (!f.borrower) return { problem: "borrower is required" };
  for (const k of Object.keys(LIMITS)) if (f[k].length > LIMITS[k]) return { problem: `${k} must be at most ${LIMITS[k]} characters` };
  const takenOn = f.takenOn || todayDate;
  if (!isDate(takenOn)) return { problem: "takenOn must be a date like 2026-10-22" };
  if (!f.dueOn) return { problem: "dueOn is required" };
  if (!isDate(f.dueOn)) return { problem: "dueOn must be a date like 2026-10-29" };
  if (f.dueOn < takenOn) return { problem: "dueOn must not be before takenOn" };
  if (f.id && !UUID.test(f.id)) return { problem: "id must be a UUID when given" };
  return { loan: { id: (f.id || crypto.randomUUID()).toLowerCase(), item: f.item, borrower: f.borrower, takenOn, dueOn: f.dueOn } };
}

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0c10;color:#e8e8ee;max-width:900px;margin:0 auto;padding:16px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #2a2c35;padding:8px 6px;vertical-align:top}small,th{color:#9a9cab;font-weight:normal}label{display:block;margin-top:8px}input{width:100%;background:#15161c;color:inherit;border:1px solid #2a2c35;border-radius:6px;padding:8px;box-sizing:border-box;font:inherit}button{margin-top:8px;background:#5b5bd6;color:#fff;border:0;border-radius:6px;padding:10px 16px;font:inherit;cursor:pointer}td button{margin-top:0;padding:6px 12px}.err{border:1px solid #d65b5b;border-radius:6px;padding:8px}.late{color:#ff9a9a;font-weight:600}.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:560px){.row2{grid-template-columns:1fr}}code{font-family:ui-monospace,monospace}:focus-visible{outline:2px solid #b8b8ff;outline-offset:2px}</style></head>
<body>${inner}</body></html>`;
}

function page(user, loans, { error = "", values = {} } = {}) {
  const t = today();
  const out = loans.filter((l) => !l.returnedAt).sort(byDueThenTaken);
  const back = loans.filter((l) => l.returnedAt).sort((a, b) => (a.returnedAt < b.returnedAt ? 1 : a.returnedAt > b.returnedAt ? -1 : 0));
  const outRows = out.length
    ? out.map((l) => `<tr><td>${esc(l.item)}</td><td>${esc(l.borrower)}</td><td>${esc(l.takenOn)}</td><td>${esc(l.dueOn)}${l.dueOn < t ? ` <span class="late">Overdue</span>` : ""}</td>
<td><form method="post" action="/loans/${esc(l.id)}/return"><button type="submit" aria-label="Mark ${esc(l.item)} returned">Mark returned</button></form></td></tr>`).join("")
    : `<tr><td colspan="5">Nothing is out.</td></tr>`;
  const backRows = back.length
    ? back.slice(0, 200).map((l) => `<tr><td>${esc(l.item)}</td><td>${esc(l.borrower)}</td><td>${esc(l.takenOn)}</td><td>${esc(l.dueOn)}</td><td>${esc(l.returnedAt.slice(0, 10))}</td></tr>`).join("")
    : `<tr><td colspan="5">Nothing has been returned yet.</td></tr>`;
  const val = (k, d = "") => esc(values[k] !== undefined ? values[k] : d);
  return shell("Loans", `<h1>Loans</h1><p id="who">Signed in as <strong>${esc(user.name || user.email)}</strong></p>
<h2>Add a loan</h2>
<form method="post" action="/loans">${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<input type="hidden" name="id" value="${esc(values.id || crypto.randomUUID())}">
<label for="item">Item (for example, Laptop 3)</label><input id="item" name="item" required maxlength="${LIMITS.item}" value="${val("item")}">
<label for="borrower">Who has it</label><input id="borrower" name="borrower" required maxlength="${LIMITS.borrower}" value="${val("borrower")}">
<div class="row2"><div><label for="takenOn">Taken on</label><input id="takenOn" name="takenOn" type="date" required value="${val("takenOn", t)}"></div>
<div><label for="dueOn">Due back</label><input id="dueOn" name="dueOn" type="date" required value="${val("dueOn")}"></div></div>
<button type="submit">Add loan</button></form>
<h2>Out now (${out.length})</h2><table><thead><tr><th>Item</th><th>Who has it</th><th>Taken</th><th>Due back</th><th></th></tr></thead><tbody id="out">${outRows}</tbody></table>
<h2>Returned (${back.length})</h2><table><thead><tr><th>Item</th><th>Who had it</th><th>Taken</th><th>Was due</th><th>Returned</th></tr></thead><tbody id="returned">${backRows}</tbody></table>
<p id="kept"><small>${esc(KEPT[store.kind])}</small></p>`);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://app");
  const isApi = url.pathname.startsWith("/api/");

  // Health is checked by the platform directly, with no signed-in person, so it must NOT
  // require sign-in. It must also be honest: say what is running.
  if (url.pathname === "/health") {
    return send(res, 200, { status: "ok", app: APP_NAME, version: VERSION, buildCommit: BUILD_COMMIT, storage: store.kind });
  }

  // Everything else: who is this? (Throws 401/503 if we cannot tell.)
  const user = await identity.currentUser(req.headers);
  // Every route below is for keepers. Checked on the SERVER, on every request.
  identity.requireRole(user, KEEPER_ROLE);
  // A browser that says the request came from another site is not our own form or page.
  if (req.method !== "GET" && req.headers["sec-fetch-site"] === "cross-site") throw new IdentityError("cross-site request refused", 403);

  if (url.pathname === "/" && req.method === "GET") return send(res, 200, page(user, await store.list()), "text/html; charset=utf-8");

  if (url.pathname === "/api/loans" && req.method === "GET") {
    const all = await store.list();
    const status = url.searchParams.get("status");
    if (status !== null && status !== "out" && status !== "returned") return send(res, 400, { error: "status must be out or returned" });
    const items = status === "out" ? all.filter((l) => !l.returnedAt) : status === "returned" ? all.filter((l) => l.returnedAt) : all;
    return send(res, 200, { items });
  }

  if ((url.pathname === "/loans" || url.pathname === "/api/loans") && req.method === "POST") {
    const fields = await readFields(req, ["id", "item", "borrower", "takenOn", "dueOn"]);
    const checked = checkNewLoan(fields, today());
    if (checked.problem) {
      if (isApi) return send(res, 400, { error: checked.problem });
      return send(res, 400, page(user, await store.list(), { error: checked.problem, values: fields }), "text/html; charset=utf-8");
    }
    const { loan, created } = await store.add(checked.loan);
    if (!isApi) { res.writeHead(303, { location: "/" }); return res.end(); }
    return send(res, created ? 201 : 200, loan);
  }

  const ret = url.pathname.match(/^\/(?:api\/)?loans\/([^/]+)\/return$/);
  if (ret && req.method === "POST") {
    if (!UUID.test(ret[1])) return send(res, 404, { error: "no such loan" });
    const id = ret[1].toLowerCase();
    let loan = await store.markReturned(id, new Date().toISOString());
    // Returning twice (a double click) is not an error: the loan is back either way.
    if (!loan) loan = (await store.list()).find((l) => l.id === id) || null;
    if (!loan) return send(res, 404, { error: "no such loan" });
    if (!isApi) { res.writeHead(303, { location: "/" }); return res.end(); }
    return send(res, 200, loan);
  }

  return send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof IdentityError ? err.status : err instanceof SyntaxError ? 400 : 500;
    if (status >= 500) console.error(err.cause || err);
    const message = status === 500 ? "something went wrong" : err.message;
    if (new URL(req.url, "http://app").pathname.startsWith("/api/")) return send(res, status, { error: message });
    send(res, status, shell("Loans", `<h1>Loans</h1><p>${esc(message)}</p>${status === 403 && /role/.test(message) ? `<p>This app is for people with the <code>${esc(KEEPER_ROLE)}</code> role. Ask whoever runs it to give it to you.</p>` : ""}`), "text/html; charset=utf-8");
  });
});
store.init().then(
  () => server.listen({ port: PORT, host: LISTEN_ADDRESS }, () => console.log(`${APP_NAME} ${VERSION} listening on :${server.address().port} (loans kept in ${store.kind})`)),
  (err) => {
    // No fallback to memory: loans kept there would be lost at the next restart.
    console.error(`${err.message}\nDATABASE_URL is set, so this app will not start without its database.`);
    process.exit(1);
  },
);
