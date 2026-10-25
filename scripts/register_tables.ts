// Registers the statute JSON as Zetaris tables: TAXMAP_REST database, taxmap container,
// REST tables over the pinned raw GitHub URLs, and taxmap.sections / taxmap.acts / taxmap.levies views.
//
//   npx tsx scripts/register_tables.ts --dry-run   print statements, send nothing
//   npx tsx scripts/register_tables.ts             create what is missing, skip what exists
//   npx tsx scripts/register_tables.ts --reset     drop the views and database, then recreate
//   npx tsx scripts/register_tables.ts --cache-only  only re-warm the view caches
//
// taxmap.levies (the Schedule of the Taxes and Levies (Approved List for Collection) Act) is read from
// levies.json at the commit in STATUTE_COMMIT, which must be set for it: the default commit predates it.
// Tables that already exist are kept as they are, so sections_raw stays at the commit it was created
// from; use --reset with STATUTE_COMMIT to move every table to a new commit.
//
// The REST tables re-fetch and re-parse the JSON on every query (40-60 s each), so the views
// are cached at the end. The cache does not survive a Zetaris container restart, and replacing a
// view drops it; the server and the pipeline re-warm it via src/data/warm.ts on start.
import "dotenv/config";
import { CACHED_VIEWS, warmCache } from "../src/data/warm.js";
import { runSql, ZetarisError } from "../src/data/zetaris.js";

const REPO = "tman6290/tax-map";
const LEVIES_COMMIT = process.env.STATUTE_COMMIT;
const COMMIT = LEVIES_COMMIT ?? "0db65153c4360a84aab7b4b82c8b4b259e072626";
const raw = (commit: string) => `https://raw.githubusercontent.com/${REPO}/${commit}/data/statutes`;

const DB = "TAXMAP_REST";
const CONTAINER = "taxmap";

const SECTION_COLUMNS = [
  "section_id",
  "act_id",
  "act_title",
  "section_no",
  "heading",
  "text",
  "chapter",
  "part",
  "tier",
  "source_file",
  "source_sha256",
  "page_start",
  "page_end",
];
const ACT_COLUMNS = [
  "act_id",
  "act_title",
  "short_title",
  "year",
  "tier",
  "source_file",
  "source_sha256",
  "section_count",
];
const LEVY_COLUMNS = [
  "item_id",
  "act_id",
  "part",
  "part_title",
  "tier",
  "item_no",
  "text",
  "source_file",
  "source_sha256",
  "page",
];

const restTable = (table: string, file: string, commit = COMMIT) =>
  `CREATE LIGHTNING REST TABLE ${table} FROM ${DB} REQUEST(
    endpoint "${raw(commit)}/${file}",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()`;

const view = (name: string, raw: string, columns: string[]) =>
  `CREATE OR REPLACE SCHEMASTORE VIEW ${name} WITH CONTAINER ${CONTAINER} AS
SELECT
${columns.map((c) => `    \`${c}\``).join(",\n")}
FROM ${DB}.${raw}`;

const statements = {
  database: `CREATE LIGHTNING DATABASE ${DB} DESCRIBE BY "Tax Map statute source"`,
  container: `CREATE SCHEMASTORE CONTAINER ${CONTAINER}`,
  tables: [
    { name: "sections_raw", sql: restTable("sections_raw", "sections.json") },
    { name: "acts_raw", sql: restTable("acts_raw", "acts.json") },
    // without STATUTE_COMMIT there is no commit known to hold levies.json, so the table is not created
    ...(LEVIES_COMMIT ? [{ name: "levies_raw", sql: restTable("levies_raw", "levies.json", LEVIES_COMMIT) }] : []),
  ],
  views: [
    view("sections", "sections_raw", SECTION_COLUMNS),
    view("acts", "acts_raw", ACT_COLUMNS),
    ...(LEVIES_COMMIT ? [view("levies", "levies_raw", LEVY_COLUMNS)] : []),
  ],
  caches: CACHED_VIEWS.map((v) => `CACHE TABLE ${v}`), // run by warmCache(); listed here for --dry-run
  resetDrops: [`DROP VIEW ${CONTAINER}.sections`, `DROP VIEW ${CONTAINER}.acts`, `DROP VIEW ${CONTAINER}.levies`, `DROP LIGHTNING DATABASE ${DB}`],
};

const NO_LEVIES = "skip    taxmap.levies: set STATUTE_COMMIT to the commit that holds data/statutes/levies.json";

const NOT_THERE = /not exist|not found|NOT_FOUND|is not existing|cannot be found/i;
const ALREADY = /already exist|exists|duplicate/i;

async function exec(sql: string, tolerate?: RegExp): Promise<boolean> {
  try {
    await runSql(sql);
    return true;
  } catch (err) {
    if (err instanceof ZetarisError && tolerate?.test(err.message)) return false;
    throw err;
  }
}

function names(rows: unknown[][]): Set<string> {
  return new Set(rows.map((r) => String(r[0]).toLowerCase()));
}

function dryRun(reset: boolean): void {
  console.log(`-- dry run: nothing is sent. Data pinned at commit ${COMMIT}`);
  if (!LEVIES_COMMIT) console.log(`-- ${NO_LEVIES}`);
  if (reset) for (const s of statements.resetDrops) console.log(`${s};\n`);
  console.log(`${statements.database};\n`);
  console.log(`${statements.container};\n`);
  for (const t of statements.tables) console.log(`${t.sql};\n`);
  for (const v of statements.views) console.log(`${v};\n`);
  for (const c of statements.caches) console.log(`${c};\n`);
}

async function warmCaches(): Promise<void> {
  for (const w of await warmCache()) console.log(`cached  ${w.view} (${(w.ms / 1000).toFixed(1)} s)`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const reset = args.has("--reset");
  if (args.has("--dry-run")) return dryRun(reset);
  if (args.has("--cache-only")) return warmCaches();

  if (reset) {
    // SQL cannot drop a container; only the views and the Lightning database (with its tables) go.
    for (const s of statements.resetDrops) {
      const done = await exec(s, NOT_THERE);
      console.log(`${done ? "ran    " : "absent "} ${s}`);
    }
  }

  const dbs = names((await runSql("SHOW LIGHTNING DATABASES")).rows);
  if (dbs.has(DB.toLowerCase())) {
    console.log(`skip    database ${DB} (exists)`);
  } else {
    await runSql(statements.database);
    console.log(`created database ${DB}`);
  }

  if (await exec(statements.container, ALREADY)) console.log(`created container ${CONTAINER}`);
  else console.log(`skip    container ${CONTAINER} (exists)`);

  if (!LEVIES_COMMIT) console.log(NO_LEVIES);
  const existing = names((await runSql(`SHOW LIGHTNING TABLES ${DB}`)).rows);
  for (const t of statements.tables) {
    if (existing.has(t.name)) {
      console.log(`skip    table ${DB}.${t.name} (exists)`);
    } else {
      // a retried CREATE can answer "already exists" if the first attempt registered the table
      // before its response was lost, so that answer counts as success
      const created = await exec(t.sql, ALREADY);
      console.log(`${created ? "created" : "skip   "} table ${DB}.${t.name}${created ? "" : " (exists)"}`);
    }
  }

  for (const v of statements.views) {
    await runSql(v); // CREATE OR REPLACE: safe to repeat
    console.log(`ensured view ${CONTAINER}.${v.match(/VIEW (\w+)/)?.[1]}`);
  }
  await warmCaches();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
