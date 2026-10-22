// store.js: where the loans are kept.
//
//   DATABASE_URL set   loans are kept in Postgres, across restarts and updates.
//   not set            loans are kept in memory and cleared on every restart (local dev only).
//
// On the platform, DATABASE_URL is set for you when vmnodes.json says "database": true.
// There is no fallback: if DATABASE_URL is set but the database cannot be reached, the app
// refuses to start rather than quietly keeping loans in memory, where they would be lost.
//
// A loan: { id, item, borrower, takenOn, dueOn, returnedAt, createdAt }.
//   takenOn and dueOn are calendar dates, "YYYY-MM-DD". returnedAt is null until it is back.
//   Nothing here ever deletes a loan: a returned loan stays as history.

// The database's shape, as an ordered list. Rules for this list:
//   - Add to the END. Never edit or delete an entry that has shipped.
//   - Every entry must be safe to run again: it runs at EVERY start-up, on a database
//     that may already have it.
//   - Only add things (tables, columns with a default, indexes). Never drop or rename.
const MIGRATIONS = [
  `create table if not exists loans (
     seq bigserial primary key,
     id uuid not null unique,
     item text not null,
     borrower text not null,
     taken_on date not null,
     due_on date not null,
     returned_at timestamptz,
     created_at timestamptz not null default now()
   )`,
];

// What is due soonest goes first. A pure exported function, so it is tested directly.
function byDueThenTaken(a, b) {
  if (a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
  if (a.takenOn !== b.takenOn) return a.takenOn < b.takenOn ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function memoryStore() {
  const loans = [];
  return {
    kind: "memory",
    async init() {},
    async list() { return loans.map((l) => ({ ...l })); },
    // Returns { loan, created }. The same id twice is the same loan, not a second one.
    async add(loan) {
      const have = loans.find((l) => l.id === loan.id);
      if (have) return { loan: { ...have }, created: false };
      const row = { ...loan, returnedAt: null, createdAt: new Date().toISOString() };
      loans.push(row);
      return { loan: { ...row }, created: true };
    },
    // Returns the updated loan, or null when there is no such loan still out.
    async markReturned(id, returnedAt) {
      const l = loans.find((x) => x.id === id && x.returnedAt === null);
      if (!l) return null;
      l.returnedAt = returnedAt;
      return { ...l };
    },
    async close() {},
  };
}

function postgresStore(url, { attempts = 5, delayMs = 1000, log = console } = {}) {
  const postgres = require("postgres");
  const sql = postgres(url, { max: 3, onnotice: () => {} });
  const toLoan = (r) => ({
    id: r.id, item: r.item, borrower: r.borrower, takenOn: r.taken_on, dueOn: r.due_on,
    returnedAt: r.returned_at ? r.returned_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  });
  return {
    kind: "postgres",
    async init() {
      // First, wait until the database answers. Only a database that cannot be reached is retried.
      for (let i = 1; ; i++) {
        try {
          await sql`select 1`;
          break;
        } catch (err) {
          if (i >= attempts) throw new Error(`could not reach the database after ${attempts} tries: ${err.message}`);
          log.log(`database not reachable yet (try ${i} of ${attempts}): ${err.message}`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      // Then bring the database's shape up to date. NOT retried: a failed change stops the app
      // and says why. One transaction, under a lock, so containers starting together cannot collide.
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(727002)`;
        for (const statement of MIGRATIONS) await tx.unsafe(statement);
      });
    },
    async list() {
      const rows = await sql`select id, item, borrower, taken_on::text as taken_on, due_on::text as due_on, returned_at, created_at
                             from loans order by seq asc`;
      return rows.map(toLoan);
    },
    async add(l) {
      const inserted = await sql`insert into loans (id, item, borrower, taken_on, due_on)
                                 values (${l.id}, ${l.item}, ${l.borrower}, ${l.takenOn}, ${l.dueOn})
                                 on conflict (id) do nothing
                                 returning id, item, borrower, taken_on::text as taken_on, due_on::text as due_on, returned_at, created_at`;
      if (inserted[0]) return { loan: toLoan(inserted[0]), created: true };
      const [have] = await sql`select id, item, borrower, taken_on::text as taken_on, due_on::text as due_on, returned_at, created_at
                               from loans where id = ${l.id}`;
      return { loan: toLoan(have), created: false };
    },
    async markReturned(id, returnedAt) {
      const rows = await sql`update loans set returned_at = ${returnedAt} where id = ${id} and returned_at is null
                             returning id, item, borrower, taken_on::text as taken_on, due_on::text as due_on, returned_at, created_at`;
      return rows[0] ? toLoan(rows[0]) : null;
    },
    async close() { await sql.end({ timeout: 5 }); },
  };
}

function openStore({ env = process.env, log = console } = {}) {
  return env.DATABASE_URL ? postgresStore(env.DATABASE_URL, { log }) : memoryStore();
}

module.exports = { openStore, byDueThenTaken, MIGRATIONS };
