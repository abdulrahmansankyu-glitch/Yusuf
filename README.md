# Engineering Planning Tracker

Shared tracking for the engineering department's planning workbook — fifteen
registers, one dashboard, and the team's own Excel file as the way data goes in
and comes out.

Everyone opens the **same URL** and sees the **same live data**. Upload a
workbook or edit a job and it is there for the rest of the team on their next
refresh, instead of a file called `Tracking - final (2) - Ahmed's copy.xlsx`
going round by email.

```bash
npm install
npm start                 # http://localhost:4200
```

---

## What it tracks

The registers come straight from the workbook, and each keeps its own columns —
an IWS row genuinely is not a PR row, and flattening them would lose the IWO
flag, the quotation status, the Iqama numbers and the twelve month columns that
are the whole point of the sheets that have them.

### Work

| Register | Sheet | What it holds | Due date comes from |
|---|---|---|---|
| IWS Status | `IWS` | Inspection work scopes | ETC |
| Commercial | `Commerial` | Purchase requisitions | PR Closing Date |
| General Activities | `GAF` | Activities followed up against a tag | ETC |
| Fabrication Workshop | `Fab WS` | Jobs on the workshop floor | ETC |
| Planner PMs | `Planner PMs` | Preventive maintenance orders from SAP | Planned Date |
| Assigned Jobs | `Assinged Jobs` | Jobs handed down by the line manager | ETC |
| Overhauling Status | `Overhauling Status` | Equipment out for overhaul | ETC |
| MOC | `MOC` | Management-of-change packages | ETC |

### Resources

| Register | Sheet | What it holds | Due date comes from |
|---|---|---|---|
| Rental Equipment | `Rental Resourecs Eq` | Hired plant on site | Demobilization |
| Rental Manpower | `Rental Resourecs MP` | Hired trades on site | Demobilize |
| Equipment Outside | `EOS Out Side` | Equipment away for repair | Mobilization Date (the day it is due back) |

### People

These four are matrices — a person per row, a period or a course per column —
so they answer *how much of the grid is filled*, not *what is due*.

| Register | Sheet | The grid |
|---|---|---|
| SS / Workshop Plan | `Sankyu SS MP` | Twelve months |
| DCU Vacation Plan | `Sankyu DCU MP` | Twelve months |
| JTS Programme | `JTS` | Four quarters, with the total worked out |
| Safety Training | `Safety` | Fifteen courses |

What makes one dashboard possible across all fifteen is that every register
declares which of *its own* columns answers each shared question: what is this,
who owns it, when is it due, how urgent is it. That mapping lives in one place —
[`src/registers.js`](src/registers.js) — and adding a sixteenth register is a
change to that file and nothing else.

---

## The dashboard

- **Total · Open · Overdue · Due in 30 days · Closed · No date set** across every
  register the reader may open, with a people-sheet coverage figure beside them.
- **A card per register** — overdue, due soon, open and closed, summing to that
  register's total, with all four printed underneath.
- **Needs attention** — everything overdue or due inside a month, soonest first,
  and where two rows fall on the same day the more urgent one leads.
- **Recent changes** — who changed what, and when.

Priority, status, owner, due window and free text are all filterable inside each
register, and the table sorts on any column. Blanks sort last whichever way the
column is pointing.

On the people sheets there is a **coverage panel** instead: how many people hold
each course, or have each month planned. Courses are listed thinnest first —
the one only five of twenty-three people hold is the only thing on that page
anybody can act on. Months stay in calendar order, because a vacation plan is
read to find the summer gap, not the quietest month.

**Enter saves** in the entry drawer, as it does on the sign-in form — except in a
description or remarks box, where Enter is a new line, and on a date field, where
the browser's own picker uses it to accept a date.

---

## Document numbers

IWS entries created by hand are numbered by the app: **`IWS-2608-01`** — `IWS`,
the two-digit year, the two-digit month, then a serial that **restarts at 01 each
month**. Opening a new entry fills the field in; type over it and the app uses
what you wrote, which is what carrying a number over from another series needs.
Imported rows keep whatever numbers the sheet already carries.

Two details that are not obvious and both matter:

**The number shown is a preview, not a reservation.** It is issued when Save is
pressed, so opening the form and thinking better of it consumes nothing and
leaves no gap in the sequence.

**The next serial is the highest in that month plus one, never the count of
records.** Counting would reissue a number the moment *any* entry was deleted,
and these appear on paperwork that has already left the building. Taking the
highest means deleting an older entry changes nothing.

The one case it does not cover: deleting the **most recent** entry releases its
number, so the next one issued reuses it. That is usually what you want — the
number never left the building — but if a document has already gone out, type the
next number in by hand rather than accepting the suggestion. Closing that gap
properly needs a stored high-water mark per month, which is not there yet.

Past 99 the number simply gets longer rather than wrapping.

Adding this to another register is two lines — an `autoNumber: { field, prefix }`
on it in [`src/registers.js`](src/registers.js).

---

## Excel import

Upload a workbook and **every sheet becomes its own choice**: which register it
belongs to, and whether it *replaces* that register or *adds* to it.

The reader is built around the team's real file rather than an idealised table:

- **The header row is found, not assumed.** Thirteen sheets open with a merged
  banner (`IWS STATUS`, `RESOURCES`), two of those carry a second banner under it
  (`RENTAL EQUIPMENT 2025`, `Year 2026`), and the SAP export opens with a blank
  row. The header is located by matching column names against every spelling each
  field is known by.

- **The legend under the header is not data.** IWS lists `Yes`/`NO`,
  `manpower`/`material`/`Machinery` and `Contractor`/`Inhouse` in the three rows
  beneath its header; Commercial lists `Open`/`Close`; MOC and Overhauling list
  theirs. That is the sheet's own dropdown. Eleven such rows would otherwise have
  imported as eleven jobs that describe nothing — so a row has to fill one of the
  register's *identifying* columns before it counts as a record.

- **A merged heading does not make a row.** The Safety sheet merges each of its
  twenty headings down over rows 2 and 3, and a merged cell reports the master's
  value from every one of its cells — so row 3 read back as a complete copy of
  the header and imported as a person called `NAME`.

- **A header split over two rows is read from both.** On JTS, `Q1`–`Q4` sit above
  four columns all labelled `Assigned Task`; the more specific label wins.

- **Month columns are matched on the month.** The two annual plans head their
  twelve columns with real dates rather than the words Jan/Feb, and the year in
  them changes every January.

- **Spelling drift is expected.** `Equipmnet`, `Job Initaitor `, `Serice
  Provider`, `Priorty`, `Assinged Jobs` — matching ignores case, spacing and
  punctuation, and every field carries the spellings the real workbook uses.

- **Serial columns are dropped.** `Sr` is a position, not data: it is wrong the
  moment anybody sorts. Ignoring it also stops the pre-numbered empty rows on the
  manpower sheets (`16`–`20`, nothing beside them) importing as five nameless
  people.

- **Unknown columns are kept**, not dropped, and stay editable in the app.

- **Phrases in date columns survive.** `Next Shutdown` is a real, deliberate
  entry. It is kept and shown; the job simply has no calendar date behind it. In
  the form a due date is a date picker with an **Enter text instead** switch
  beside it, and a row that already holds a phrase opens as a text box so editing
  it cannot silently discard what it says.

- **Impossible dates are refused.** A five-year addition that wrapped, or a serial
  number that landed in a date column, is kept as text and left undated —
  accepting it would park a permanently overdue row at the top of every list.

- **Dates are read day-first.** The workbook is written `13/08/25` meaning 13
  August, and two-digit years are read as this century. Both conventions live in
  [`src/dates.js`](src/dates.js); `DAY_FIRST` and `DATE_FORMAT` switch them.

Sheet names never decide a register on their own — the columns do, and the name
only breaks a tie between two registers that fit equally well.

### One word that means opposite things

SAP writes `REL` when an order has been released **for** execution — live work.
The rental manpower sheet writes `RELEASED` when somebody has been released
**from** site — finished. Reading both the same way either parked eleven people
who went home last year permanently at the top of the overdue list, or marked
live PM orders as done. The abbreviation is SAP's and the spelled-out word is the
team's, so they are mapped apart.

The same sheet is also why `RELEASED` in a REMARKS column closes a row at all:
Rental Manpower has no status column of its own, and without reading the remark
the register read as eleven overdue hires.

## Excel export

**Export all** produces one workbook: a Summary sheet plus one sheet per register,
each named after the tab it came from (`Rental Resourecs MP`, not "Rental
Manpower") and laid out like the file it replaces — the banner across the top, a
pale header, a thin border on every cell, and no row colours.

**Columns are sized to what is in them**, and each sheet arrives ready to print:
landscape, scaled to one page wide, running to as many pages down as the rows
need, with the banner and headings repeated at the top of each.

**Dates are written as dates**, not as the text they happened to be stored as —
otherwise the column cannot be sorted or filtered, which is the first thing
anybody does with the file. A phrase is not a date and is left exactly as
written, with no date format on it, since one would render it blank.

Exports **re-import cleanly**: download the master file, edit it offline, upload
it back. **Blank template** gives an empty workbook with the right headers for one
register — the quickest way to start one from scratch.

---

## Accounts and permissions

Everyone signs in with their own email and password. Passwords are hashed with
scrypt, so the database holds no readable password even if it leaks, and sessions
are signed tokens that survive a restart.

**Setting it up.** The first person to open a fresh deployment is asked to create
the administrator, and must supply `ACCESS_CODE` to do it — so somebody who
merely finds the URL first cannot claim it. Alternatively set `ADMIN_EMAIL` and
`ADMIN_PASSWORD` and the account is created on first boot.

**Three roles**, set per person under **Settings**:

| Role | Can |
|---|---|
| Viewer | Read every permitted register and export to Excel. Nothing else. |
| Editor | Add, edit, delete and import. |
| Admin | Everything, plus managing accounts. |

**Plus a register list.** Independently of the role, an account can be limited to
particular registers. The two are separate because they answer different
questions: the role is *what kind of thing* somebody may do, the register list is
*where*. Folding them together would mean inventing a role per combination.

Restrictions are enforced on the server, not by hiding buttons — an account
limited to IWS that asks for MOC directly is refused, and a restricted
dashboard says on the page that it covers only part of the department.

An admin cannot demote or remove the last remaining admin: it is the one change
that could not be undone from inside the app.

---

## Running it

```bash
npm install
npm start                 # http://localhost:4200
npm run dev               # the same, restarting on a change
npm test                  # 47 tests, no database needed
```

With no `DATABASE_URL`, data goes to `data/tracker.json` — good for trying it out
on one machine, and gitignored. Point `DATABASE_URL` at Postgres and it uses that
instead; the tables are created on boot, in their own schema so a migration tool
pointed at `public` cannot reach them.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4200` | Port to listen on |
| `DATABASE_URL` | — | Postgres connection string. Unset → local JSON file |
| `DATABASE_SSL` | — | `no-verify` for managed Postgres; `disable` to force plain TCP |
| `DATABASE_SCHEMA` | `planning` | Schema the tables live in |
| `SESSION_SECRET` | generated | Signs session tokens. Unset → everybody is signed out on each restart |
| `ACCESS_CODE` | — | Authorises creating the first administrator |
| `ADMIN_EMAIL` · `ADMIN_PASSWORD` · `ADMIN_NAME` | — | Create the administrator on boot instead |
| `DATA_FILE` | `data/tracker.json` | Where the JSON store lives |
| `TZ` | host default | The plant's timezone, so "due today" means today locally |

See [`.env.example`](.env.example).

---

## Deploying it

Three ways, in the order they are worth trying. Full steps in
[DEPLOY.md](DEPLOY.md).

**Render (free).** [`render.yaml`](render.yaml) is a blueprint: point Render at
this repository and it creates the web service and a Postgres, generates
`SESSION_SECRET`, and asks you for `ACCESS_CODE`. There is no build step — the
app is plain JavaScript on both sides, so a deploy is an install and a start.

Two limits to know before the team relies on it: services **sleep after 15
minutes** idle and take about 50 seconds to wake, and **the free database is
deleted after 30 days**. [`.github/workflows/keep-awake.yml`](.github/workflows/keep-awake.yml)
covers the first during the working day; for the second, move to a paid database
or to Neon's free tier, which persists.

**Docker, anywhere else.** [`Dockerfile`](Dockerfile) and
[`docker-compose.yml`](docker-compose.yml) bring up the app and a Postgres
together — the right answer for a VM or a spare machine on the plant network,
where nothing sleeps and no database disappears after a month.

**Bare Node.** `npm ci --omit=dev && npm start` behind whatever already serves
you, with `DATABASE_URL` set.

Whichever you pick, set these three or the deployment is worse than useless:
`DATABASE_URL` (otherwise the data is a JSON file on one machine),
`SESSION_SECRET` (otherwise everyone is signed out on every restart), and
`ACCESS_CODE` (otherwise whoever opens the URL first becomes the administrator).

---

## How it is built

Plain ES modules, no build step and no framework, on both sides. The file in the
repository is the file that runs: open `public/app.js`, change it, reload.

```
src/registers.js   the fifteen registers, and how each maps onto the shared shape
src/dates.js       every way the workbook writes a date, and the one way it is stored
src/excel.js       reading the real workbook; writing one that reads back in
src/summary.js     the figures the dashboard, the sidebar and the Summary sheet share
src/store.js       Postgres or a JSON file, behind one interface
src/server.js      the API and the static app, one process
src/auth.js        passwords, sessions, roles and register permissions
src/autonumber.js  the IWS-YYMM-NN rule for document numbers
public/            the browser app — app.js, styles.css, index.html
test/              tests over the parts that would fail silently
```

The browser never carries its own copy of the register definitions — it reads
them from `/api/config`, so the columns, their labels, their types and their
options have exactly one source of truth.

The test fixtures are built in code rather than checked in as a sample workbook:
the real file carries employees' names and residency numbers, and that does not
belong in a git repository. Every quirk it has is reproduced in
[`test/tracker.test.js`](test/tracker.test.js) instead.
