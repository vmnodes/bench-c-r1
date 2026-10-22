// test/smoke.js: `npm test`. Proves the loan list refuses what it should and accepts what
// it should, and that loans survive an app restart when a database is set.
// Every "refused" row has a matching "accepted" row, so a check that can only ever
// refuse cannot pass by accident.
//
// The database half runs only when TEST_DATABASE_URL points at an EMPTY scratch Postgres
// database (it drops and recreates the table `loans`). Without it, those checks are
// reported as SKIPPED, not passed, and the run says so.
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { SignJWT } = require("jose");
const { startMockPortal } = require("../dev/mock-portal");
const { byDueThenTaken } = require("../store");

const APP_ID = "app_smoke_test";
const SERVER = path.join(__dirname, "..", "server.js");
const children = [];
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (expected ${JSON.stringify(want)}, got ${JSON.stringify(got)})`}`);
}

function startApp(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PORT: "0", LISTEN_ADDRESS: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    const onData = (d) => {
      out += d;
      const m = out.match(/listening on :(\d+)/);
      if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}`, out: () => out });
    };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("exit", (code) => resolve({ child, exited: code, out: () => out }));
  });
}
const stopApp = (app) => new Promise((r) => { app.child.once("exit", r); app.child.kill(); });

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const ymd = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => ymd(new Date(Date.now() + n * 86400000));

(async () => {
  // --- 0. The ordering rule, over BOTH input orders ---------------------------
  const L = (id, dueOn, takenOn = "2026-01-01", createdAt = "2026-01-01T00:00:00.000Z") => ({ id, dueOn, takenOn, createdAt });
  const sample = [L("a", "2026-03-01"), L("b", "2026-02-01"), L("c", "2026-02-01", "2026-01-15"), L("d", "2026-02-01", "2026-01-15", "2026-01-02T00:00:00.000Z")];
  const want = ["b", "c", "d", "a"];
  check("ordering: due soonest first, ties by taken then created (input order 1)", [...sample].sort(byDueThenTaken).map((l) => l.id), want);
  check("ordering: same answer from the reversed input", [...sample].reverse().sort(byDueThenTaken).map((l) => l.id), want);

  // --- 1. It refuses to start without sign-in configured ----------------------
  const noAppId = await startApp({ VMNODES_PORTAL_URL: "http://127.0.0.1:1" });
  check("refuses to START without VMNODES_APP_ID", noAppId.exited !== undefined && noAppId.exited !== 0, true);

  const portal = await startMockPortal({ port: 0, appId: APP_ID });
  const app = await startApp({ VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID });
  check("CONTROL: starts when both settings are present", typeof app.url, "string");
  if (!app.url) { console.log(app.out()); process.exit(1); }
  portal.setTarget(app.url);

  const mint = (claims, { aud = APP_ID } = {}) =>
    new SignJWT({ email: "e@example.test", name: "Eden Editor", kind: "employee", groups: [], roles: [], ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "local-dev" }).setSubject("usr_1").setIssuer(portal.issuer).setAudience(aud)
      .setIssuedAt().setExpirationTime("5m").sign(portal.privateKey);
  const as = async (claims, opts) => ({ "x-vmnodes-identity": await mint(claims, opts) });
  const keeper = () => as({ roles: ["loans.keeper"] });
  const nobody = () => as({ name: "Riley Reader", roles: [] });
  const json = (headers, method, p, body) => request(`${app.url}${p}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  // --- 2. Health and sign-in --------------------------------------------------
  const h = await request(`${app.url}/health`);
  check("health answers 200 WITHOUT sign-in", h.status, 200);
  check("health says loans are kept in memory when DATABASE_URL is not set", h.json().storage, "memory");
  check("CONTROL: a keeper token is accepted", (await json(await keeper(), "GET", "/api/loans")).status, 200);
  check("no identity header -> 401", (await request(`${app.url}/api/loans`)).status, 401);
  check("token meant for ANOTHER app -> 401", (await json(await as({ roles: ["loans.keeper"] }, { aud: "app_someone_else" }), "GET", "/api/loans")).status, 401);

  // --- 3. The role is checked on the server, for every route -------------------
  const ID = "6f1c2a52-8f0d-4d64-9d0e-1c7b0e2a9b11";
  const good = { item: "Laptop 3", borrower: "Ada", dueOn: daysFromNow(7) };
  check("without the role: list -> 403", (await json(await nobody(), "GET", "/api/loans")).status, 403);
  check("without the role: add -> 403", (await json(await nobody(), "POST", "/api/loans", good)).status, 403);
  check("without the role: return -> 403", (await json(await nobody(), "POST", `/api/loans/${ID}/return`)).status, 403);
  check("without the role: the page -> 403", (await request(`${app.url}/`, { headers: await nobody() })).status, 403);
  check("CONTROL: with the role: the page -> 200", (await request(`${app.url}/`, { headers: await keeper() })).status, 200);
  check("a cross-site form post is refused even for a keeper", (await request(`${app.url}/loans`, { method: "POST", headers: { ...(await keeper()), "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, body: "item=x&borrower=y" })).status, 403);

  // --- 4. Adding and listing ---------------------------------------------------
  const made = await json(await keeper(), "POST", "/api/loans", { item: "Camera <b>2</b>", borrower: "Ada Lovelace", takenOn: "2026-10-01", dueOn: "2026-10-08" });
  check("CONTROL: a valid loan is accepted -> 201", made.status, 201);
  const list = (await json(await keeper(), "GET", "/api/loans")).json().items;
  check("the loan is in the list, not returned", [list.length, list[0].item, list[0].borrower, list[0].takenOn, list[0].dueOn, list[0].returnedAt], [1, "Camera <b>2</b>", "Ada Lovelace", "2026-10-01", "2026-10-08", null]);
  const bad = [
    ["no item", { borrower: "A", dueOn: "2026-10-08" }],
    ["blank item", { item: "   ", borrower: "A", dueOn: "2026-10-08" }],
    ["no borrower", { item: "X", dueOn: "2026-10-08" }],
    ["no due date", { item: "X", borrower: "A" }],
    ["a due date that is not a date", { item: "X", borrower: "A", dueOn: "soon" }],
    ["a due date that does not exist (30 Feb)", { item: "X", borrower: "A", dueOn: "2026-02-30" }],
    ["a taken date that is not a date", { item: "X", borrower: "A", takenOn: "yesterday", dueOn: "2026-10-08" }],
    ["due before taken", { item: "X", borrower: "A", takenOn: "2026-10-08", dueOn: "2026-10-07" }],
    ["a number for item", { item: 5, borrower: "A", dueOn: "2026-10-08" }],
    ["a 101-character item", { item: "x".repeat(101), borrower: "A", dueOn: "2026-10-08" }],
    ["a 101-character borrower", { item: "X", borrower: "x".repeat(101), dueOn: "2026-10-08" }],
    ["an id that is not a UUID", { id: "nope", item: "X", borrower: "A", dueOn: "2026-10-08" }],
  ];
  for (const [name, body] of bad) check(`${name} -> 400`, (await json(await keeper(), "POST", "/api/loans", body)).status, 400);
  check("CONTROL: due the same day it is taken is fine", (await json(await keeper(), "POST", "/api/loans", { item: "Projector", borrower: "Bo", takenOn: "2026-10-08", dueOn: "2026-10-08" })).status, 201);
  const broken = await request(`${app.url}/api/loans`, { method: "POST", headers: { ...(await keeper()), "content-type": "application/json" }, body: "{nope" });
  check("a body that is not JSON -> 400", broken.status, 400);
  const arr = await request(`${app.url}/api/loans`, { method: "POST", headers: { ...(await keeper()), "content-type": "application/json" }, body: "null" });
  check("a JSON body that is not an object -> 400", arr.status, 400);
  check("nothing was added by the refused posts (2 loans: camera and projector)", (await json(await keeper(), "GET", "/api/loans")).json().items.length, 2);

  // --- 5. Double-submit: the same id is the same loan -------------------------
  const dup = { id: "11111111-2222-4333-8444-555555555555", item: "Laptop 9", borrower: "Cy", dueOn: "2026-11-01" };
  const d1 = await json(await keeper(), "POST", "/api/loans", dup);
  const d2 = await json(await keeper(), "POST", "/api/loans", dup);
  check("first post with an id -> 201, the same post again -> 200", [d1.status, d2.status], [201, 200]);
  check("...and only one such loan exists", (await json(await keeper(), "GET", "/api/loans")).json().items.filter((l) => l.item === "Laptop 9").length, 1);
  check("CONTROL: without an id, two identical posts are two loans (server makes the ids)", [
    (await json(await keeper(), "POST", "/api/loans", { item: "Tripod", borrower: "Di", dueOn: "2026-11-01" })).status,
    (await json(await keeper(), "POST", "/api/loans", { item: "Tripod", borrower: "Di", dueOn: "2026-11-01" })).status,
  ], [201, 201]);

  // --- 6. Text is escaped when it goes into the page --------------------------
  portal.setUser("editor");
  const pageHtml = (await request(`${portal.issuer}/`)).body;
  check("typed text is escaped, not run as markup", pageHtml.includes("Camera &lt;b&gt;2&lt;/b&gt;") && !pageHtml.includes("<b>2</b>"), true);
  check("the old overdue loan says Overdue", pageHtml.includes("Overdue"), true);
  portal.setUser("reader");
  const readerPage = await request(`${portal.issuer}/`);
  check("a person without the role gets a 403 page, not the list", [readerPage.status, readerPage.body.includes("Camera")], [403, false]);
  portal.setUser("editor");

  // --- 7. A form post works the way the page does it --------------------------
  const formBody = new URLSearchParams({ id: "99999999-2222-4333-8444-555555555555", item: "Form item", borrower: "Eve", takenOn: "2026-10-20", dueOn: "2026-10-27" }).toString();
  const formPost = await request(`${portal.issuer}/loans`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: formBody });
  check("a form post answers 303 back to the list", [formPost.status, formPost.headers.location], [303, "/"]);
  check("...and the loan is on the page", (await request(`${portal.issuer}/`)).body.includes("Form item"), true);
  const formBad = await request(`${portal.issuer}/loans`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "item=&borrower=x&dueOn=2026-10-27" });
  check("a bad form post answers 400 with the message on the page", [formBad.status, formBad.body.includes("item is required")], [400, true]);

  // --- 8. Returning --------------------------------------------------------------
  const id = made.json().id;
  const back = await json(await keeper(), "POST", `/api/loans/${id}/return`);
  check("CONTROL: returning a loan that is out -> 200, with a returned time", [back.status, typeof back.json().returnedAt], [200, "string"]);
  const firstReturnedAt = back.json().returnedAt;
  const again = await json(await keeper(), "POST", `/api/loans/${id}/return`);
  check("returning it again -> 200 and the first returned time is kept", [again.status, again.json().returnedAt], [200, firstReturnedAt]);
  check("a made-up id -> 404", (await json(await keeper(), "POST", `/api/loans/${ID}/return`)).status, 404);
  check("an id that is not a UUID -> 404, not a database error", (await json(await keeper(), "POST", "/api/loans/not-an-id/return")).status, 404);
  const outList = (await json(await keeper(), "GET", "/api/loans?status=out")).json().items;
  const retList = (await json(await keeper(), "GET", "/api/loans?status=returned")).json().items;
  check("status=out leaves out the returned loan", outList.some((l) => l.id === id), false);
  check("status=returned holds exactly the returned loan", retList.map((l) => l.id), [id]);
  check("a returned loan is still in the full list (never deleted)", (await json(await keeper(), "GET", "/api/loans")).json().items.some((l) => l.id === id), true);
  check("status=nonsense -> 400", (await json(await keeper(), "GET", "/api/loans?status=nonsense")).status, 400);
  const formRet = await request(`${portal.issuer}/loans/99999999-2222-4333-8444-555555555555/return`, { method: "POST" });
  check("returning from the page answers 303", formRet.status, 303);

  // --- 9. A database that cannot be reached stops the app; it never falls back --
  const noDb = await startApp({ VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID, DATABASE_URL: "postgres://loans@127.0.0.1:1/loans" });
  check("with DATABASE_URL set and no database, the app refuses to START", noDb.exited !== undefined && noDb.exited !== 0, true);
  check("...and says it will not start without its database", /will not start without its database/.test(noDb.out()), true);

  // --- 10. With a real database: loans survive a restart -------------------------
  const DB = process.env.TEST_DATABASE_URL;
  if (!DB) {
    console.log("SKIPPED the database checks: set TEST_DATABASE_URL to an empty scratch Postgres database");
  } else {
    const postgres = require("postgres");
    const sql = postgres(DB, { max: 2, onnotice: () => {} });
    await sql.unsafe("drop table if exists loans");
    const dbEnv = { VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID, DATABASE_URL: DB };
    let a = await startApp(dbEnv);
    check("CONTROL: starts against an empty database", typeof a.url, "string");
    check("health says postgres", (await request(`${a.url}/health`)).json().storage, "postgres");
    const call = (p, m, b) => request(`${a.url}${p}`, { method: m, headers: { ...{}, "content-type": "application/json", ...pending }, body: b === undefined ? undefined : JSON.stringify(b) });
    let pending = await keeper();
    const p1 = await call("/api/loans", "POST", { item: "Laptop 1", borrower: "Ada", takenOn: "2026-10-01", dueOn: "2026-10-08" });
    const p2 = await call("/api/loans", "POST", { item: "Projector", borrower: "Bo", takenOn: "2026-10-02", dueOn: "2026-10-09" });
    check("two loans are added", [p1.status, p2.status], [201, 201]);
    await call(`/api/loans/${p1.json().id}/return`, "POST");
    check("dates come back as plain dates, not timestamps", (await call("/api/loans", "GET")).json().items.map((l) => [l.takenOn, l.dueOn]), [["2026-10-01", "2026-10-08"], ["2026-10-02", "2026-10-09"]]);
    const dupe = { id: "aaaaaaaa-2222-4333-8444-555555555555", item: "Mic", borrower: "Cy", dueOn: "2026-11-01" };
    check("the same id posted twice -> 201 then 200", [(await call("/api/loans", "POST", dupe)).status, (await call("/api/loans", "POST", dupe)).status], [201, 200]);
    const before = (await call("/api/loans", "GET")).json().items;
    check("CONTROL: three loans before the restart", before.length, 3);
    await stopApp(a);
    a = await startApp(dbEnv);
    pending = await keeper();
    const after = (await call("/api/loans", "GET")).json().items;
    check("after a restart every loan is still there, exactly as it was", after, before);
    // Two containers starting at once, on a database that already has the table, and on one that does not.
    await stopApp(a);
    const second = await Promise.all([startApp(dbEnv), startApp(dbEnv), startApp(dbEnv)]);
    check("three starts at once against an existing table all succeed", second.map((s) => typeof s.url), ["string", "string", "string"]);
    for (const s of second) await stopApp(s);
    await sql.unsafe("drop table if exists loans");
    const fresh = await Promise.all([startApp(dbEnv), startApp(dbEnv), startApp(dbEnv)]);
    check("three first-ever starts at once all succeed", fresh.map((s) => typeof s.url), ["string", "string", "string"]);
    for (const s of fresh) await stopApp(s);
    // Rolling a later version back: this version's own statements must still work on a table that gained a column.
    await sql.unsafe("alter table loans add column if not exists note text not null default ''");
    a = await startApp(dbEnv);
    check("CONTROL: the app opens a table that has gained an extra column", typeof a.url, "string");
    await stopApp(a);
    await sql.unsafe("drop table if exists loans");
    await sql.end({ timeout: 5 });
  }

  // --- 11. The count itself: zero checks run must never read as a pass ------------
  const FLOOR = 50;
  if (pass + fail < FLOOR) { console.log(`FAIL only ${pass + fail} checks ran, expected at least ${FLOOR}`); fail++; }
  console.log(`\npassed=${pass} failed=${fail}${DB_NOTE()}`);
  finish(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("smoke test crashed:", e); finish(1); });

function DB_NOTE() { return process.env.TEST_DATABASE_URL ? " (database checks ran)" : " (database checks SKIPPED)"; }

function finish(code) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
