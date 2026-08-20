/**
 * The fifteen sheets the engineering team keeps, and how each one maps onto a
 * single shared shape.
 *
 * Every sheet keeps **its own columns**. An IWS row genuinely is not a PR row and
 * neither is a line of the vacation plan; flattening them into one generic "task"
 * would lose the IWO flag, the Iqama number, the quotation status and the twelve
 * month columns that are the entire point of the sheets that have them.
 *
 * What makes one dashboard possible is `roles`: a per-register statement of which
 * of its own columns answers each cross-cutting question — what is this, who owns
 * it, when is it due, how urgent is it. Nothing outside this file knows a column
 * name, so adding a sixteenth sheet is a change here and nowhere else.
 */

/* ------------------------------------------------------------------ *
 * Shared vocabularies
 * ------------------------------------------------------------------ */

/** Normalised priority ladder. Lower `rank` is more urgent. */
export const PRIORITIES = [
  { value: 'Critical', rank: 1 },
  { value: 'High', rank: 2 },
  { value: 'Medium', rank: 3 },
  { value: 'Low', rank: 4 },
  { value: 'Planned', rank: 5 },
];

export const PRIORITY_VALUES = PRIORITIES.map((p) => p.value);
export const PRIORITY_RANK = new Map(PRIORITIES.map((p) => [p.value, p.rank]));

export const STATUSES = ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled'];

/** Statuses that mean the job is off somebody's plate. */
export const CLOSED_STATUSES = new Set(['Completed', 'Cancelled']);

/** Strip case, spacing and punctuation, so `Job Initaitor ` matches `job_initiator`. */
export function normaliseKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Free text from the sheets → the priority ladder.
 *
 * Three vocabularies are in use across these fifteen sheets: the `Priorty`
 * columns the team fills by hand, SAP's `Priority Text` on the Planner PM export
 * (`Normal work`, `Urgent`), and the P1–P5 grades that arrive on pasted rows.
 * All three are graded urgency, so all three land on one ladder rather than
 * becoming three columns nobody can chart together.
 */
const PRIORITY_ALIASES = new Map(
  Object.entries({
    p1: 'Critical',
    p2: 'High',
    p3: 'Medium',
    p4: 'Low',
    p5: 'Planned',
    critical: 'Critical',
    emergency: 'Critical',
    breakdown: 'Critical',
    urgent: 'Critical',
    urgentwork: 'Critical',
    shutdown: 'High',
    high: 'High',
    highpriority: 'High',
    medium: 'Medium',
    med: 'Medium',
    moderate: 'Medium',
    normal: 'Low',
    // SAP writes the ordinary case as `Normal work`. It is the default grade on
    // that export, not a statement that the job matters less than the others.
    normalwork: 'Low',
    low: 'Low',
    minor: 'Low',
    planned: 'Planned',
    plannedwork: 'Planned',
    routine: 'Planned',
  }),
);

/**
 * Free text from the sheets → the status list.
 *
 * The sheets do not share a status vocabulary, and three of them ship their
 * legend in the rows underneath the header: IWS offers `Yes`/`NO` for IWO,
 * Commercial offers `Open`/`Close` for PR Status, MOC offers
 * `Pending`/`Approved`/`In progress`. Those words are what people actually type,
 * so they are matched exactly rather than being left to fall through to a
 * default that would read as "nobody has started any of this".
 */
const STATUS_ALIASES = new Map(
  Object.entries({
    notstarted: 'Not Started',
    new: 'Not Started',
    pending: 'Not Started',
    raised: 'Not Started',
    yettostart: 'Not Started',
    tobestarted: 'Not Started',
    open: 'In Progress',
    inprogress: 'In Progress',
    progress: 'In Progress',
    ongoing: 'In Progress',
    started: 'In Progress',
    wip: 'In Progress',
    underprogress: 'In Progress',
    // SAP user statuses on the Planner PM export: released and approved orders
    // are live work; created ones have not been let out yet.
    rel: 'In Progress',
    appr: 'In Progress',
    approved: 'In Progress',
    crtd: 'Not Started',
    created: 'Not Started',
    onhold: 'On Hold',
    hold: 'On Hold',
    waiting: 'On Hold',
    waitingmaterial: 'On Hold',
    deferred: 'On Hold',
    postponed: 'On Hold',
    completed: 'Completed',
    complete: 'Completed',
    close: 'Completed',
    closed: 'Completed',
    done: 'Completed',
    finished: 'Completed',
    teco: 'Completed',
    delivered: 'Completed',
    demobilized: 'Completed',
    demobilised: 'Completed',
    // Two sheets use this word for opposite things. SAP writes `REL` when an
    // order has been released *for* execution — live work. The rental manpower
    // sheet writes `RELEASED` when somebody has been released *from* site —
    // finished. The abbreviation is SAP's and the spelled-out word is the
    // team's, so they are mapped apart rather than one meaning being lost.
    released: 'Completed',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    rejected: 'Cancelled',
    dropped: 'Cancelled',
    // "Overdue" describes the date, not the work. A row that says so is still in
    // progress, and the computed due state is what says it is late — otherwise it
    // reads "Overdue" forever, including after somebody finally does the job.
    overdue: 'In Progress',
    delayed: 'In Progress',
    late: 'In Progress',
  }),
);

/**
 * Phrases that decide a status when the whole cell is not a known word.
 *
 * `Follow up`, `Material Status` and `REMARKS` columns hold sentences —
 * `waiting for the quotation`, `to be attend`, `job completed`. Outstanding
 * phrases are tested before finished ones because a sentence can hold both, and
 * reading `TO BE COMPLETED` as done is the more expensive mistake.
 */
const OUTSTANDING_PHRASES = [
  'to be',
  'not yet',
  'not done',
  'pending',
  'waiting',
  'under',
  'in progress',
  'ongoing',
  'follow up',
  'requested',
  'required',
  'awaiting',
];

const FINISHED_PHRASES = ['completed', 'complete', 'closed', 'done', 'finished', 'released', 'received'];

export function normalisePriority(value) {
  const key = normaliseKey(value);
  return key ? PRIORITY_ALIASES.get(key) ?? null : null;
}

export function normaliseStatus(value) {
  const key = normaliseKey(value);
  if (!key) return null;
  const exact = STATUS_ALIASES.get(key);
  if (exact) return exact;

  const text = String(value).toLowerCase();
  if (OUTSTANDING_PHRASES.some((p) => text.includes(p))) return 'In Progress';
  if (FINISHED_PHRASES.some((p) => text.includes(p))) return 'Completed';
  return null;
}

/* ------------------------------------------------------------------ *
 * Field constructors
 * ------------------------------------------------------------------ */

const text = (key, label, aliases = []) => ({ key, label, type: 'text', aliases });

/**
 * A text column with a short name for the grid.
 *
 * `Incident /  Near-Miss Reporting` printed over a cell holding `Yes` either
 * forces a column fifteen characters wide or breaks the heading down the middle
 * of a word. The full spelling — the one on the wall chart, and the one the
 * export carries — stays as `label`; `short` is only what the on-screen grid
 * prints, with the full name on hover.
 */
const gridText = (key, label, short, aliases = []) => ({ key, label, short, type: 'text', aliases });
const longtext = (key, label, aliases = []) => ({ key, label, type: 'longtext', aliases });
const date = (key, label, aliases = []) => ({ key, label, type: 'date', aliases });
const number = (key, label, aliases = []) => ({ key, label, type: 'number', aliases });

/** A closed vocabulary — the form offers exactly these and nothing else. */
const select = (key, label, options, aliases = []) => ({
  key,
  label,
  type: 'select',
  options,
  aliases,
});

/**
 * An open vocabulary: the sheet's own legend as suggestions, with anything else
 * still accepted.
 *
 * `Serice Provider` lists Sankyu, Flow Serve and Samamat underneath the header —
 * but the fourth contractor the team engages next month must not be refused by
 * a dropdown, and a free-text box alone would spell Sankyu three ways by
 * Christmas.
 */
const suggest = (key, label, options, aliases = []) => ({
  key,
  label,
  type: 'suggest',
  options,
  aliases,
});

/**
 * One month column of an annual plan.
 *
 * The header cells in those sheets are real dates (`2026-01-26`), not the words
 * "Jan"/"Feb", so they cannot be matched on their text. `monthIndex` is what the
 * reader matches a date header against.
 */
const month = (key, label, monthIndex, aliases = []) => ({
  key,
  label,
  type: 'text',
  monthIndex,
  aliases,
});

/** A value the app works out rather than one anybody types. */
const computed = (key, label, aliases = []) => ({
  key,
  label,
  type: 'number',
  computed: true,
  aliases,
});

/* ------------------------------------------------------------------ *
 * The registers
 * ------------------------------------------------------------------ */

const REMARKS = ['remarks', 'remark', 'comments', 'comment', 'notes', 'note'];
const OWNER = ['action by', 'assigned to', 'assigne to', 'assign to', 'responsible', 'owner'];

export const REGISTERS = [
  /* ---------------------------------------------------------------- *
   * 1. IWS
   * ---------------------------------------------------------------- */
  {
    id: 'iws',
    name: 'IWS Status',
    short: 'IWS',
    kind: 'jobs',
    group: 'Work',
    description: 'Inspection work scopes: what is raised, what it costs and when it expires.',
    sheetName: 'IWS',
    banner: 'IWS STATUS',
    sheetAliases: ['iws', 'iws status', 'iws track'],
    /**
     * Action Notice numbering the app issues for scopes raised by hand:
     * `IWS-2608-01` — the two-digit year, the two-digit month, then a serial
     * that restarts at 01 each month. Imported rows keep the numbers the sheet
     * already carries.
     */
    autoNumber: { field: 'iwsNo', prefix: 'IWS' },
    identityFields: ['iwsNo', 'details', 'equipment'],
    tableColumns: ['iwsNo', 'details', 'equipment', 'issuedDate', 'expiryDate', 'etc', 'iwo', 'status'],
    fields: [
      select('priority', 'Priorty', PRIORITY_VALUES, ['priorty', 'priority']),
      text('iwsNo', 'IWS No', ['iws no', 'iws number', 'iwsno']),
      longtext('details', 'IWS Details', ['iws details', 'details', 'description', 'scope']),
      text('equipment', 'Equipment', ['equipment', 'equipmnet', 'tag', 'tag no']),
      date('issuedDate', 'Issued Date', ['issued date', 'issue date', 'date issued']),
      date('expiryDate', 'Expiry Date', ['expiry date', 'expiery date', 'valid until']),
      date('etc', 'ETC', ['etc', 'estimated completion', 'target date']),
      select('iwo', 'IWO', ['Yes', 'No'], ['iwo', 'iwo no', 'iwo raised']),
      text('prNo', 'PR no', ['pr no', 'pr number', 'prno']),
      suggest('resources', 'Resources', ['Manpower', 'Material', 'Machinery'], ['resources', 'resource']),
      suggest('supplier', 'Supplier', ['Contractor', 'Inhouse'], ['supplier', 'suppiler']),
      // The sheet carries no status column, so the app owns this one. It is
      // written into the export and read back on the way in, or the one piece
      // of state the app adds would be lost on every round trip.
      select('status', 'Status', STATUSES, ['status', 'tracker status']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      ref: 'iwsNo',
      title: 'details',
      due: 'etc',
      issued: 'issuedDate',
      priority: 'priority',
      status: 'status',
      supplier: 'supplier',
      location: 'equipment',
    },
  },

  /* ---------------------------------------------------------------- *
   * 2. Commercial / PR status
   * ---------------------------------------------------------------- */
  {
    id: 'commercial',
    name: 'Commercial',
    short: 'PR',
    kind: 'jobs',
    group: 'Work',
    description: 'Purchase requisitions from the moment they are raised to the day they close.',
    sheetName: 'Commerial',
    banner: 'PR Status',
    // The sheet name is misspelled in the workbook. Both spellings resolve, and
    // the columns decide anyway.
    sheetAliases: ['commerial', 'commercial', 'pr status', 'pr'],
    identityFields: ['jobDescription', 'prNo', 'initiator'],
    tableColumns: ['prNo', 'jobDescription', 'initiator', 'prIssuedDate', 'quotationStatus', 'prStatus', 'prClosingDate'],
    fields: [
      select('priority', 'Priorty', PRIORITY_VALUES, ['priorty', 'priority']),
      text('initiator', 'Job Initaitor', ['job initaitor', 'job initiator', 'initiator', 'raised by']),
      longtext('jobDescription', 'Job description', ['job description', 'description']),
      text('prNo', 'PR no', ['pr no', 'pr number', 'prno']),
      text('prCreatedBy', 'PR Create by', ['prcreate by', 'pr create by', 'pr created by', 'created by']),
      date('prIssuedDate', 'PR issued date', ['pr issued date', 'pr issue date', 'issued date']),
      suggest(
        'quotationStatus',
        'Quotation Status',
        ['Not requested', 'Requested', 'Received', 'Under evaluation', 'Approved'],
        ['quotation status', 'quotation'],
      ),
      text('iwo', 'IWO', ['iwo', 'iwo no']),
      suggest('material', 'Material', ['Ordered', 'Delivered', 'Partially delivered', 'Not ordered'], ['material', 'material status']),
      longtext('followUp', 'Follow up', ['follow up', 'followup', 'follow-up']),
      select('prStatus', 'PR Status', ['Open', 'Close'], ['pr status', 'prstatus', 'status']),
      date('prClosingDate', 'PR Closing Date', ['pr closing date', 'closing date', 'closed on']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      ref: 'prNo',
      title: 'jobDescription',
      // A PR's commitment date is the day it is expected to close. Until it is
      // set the row is undated, which is the honest answer — an open PR with no
      // closing date is exactly the thing the dashboard should be showing as
      // undated rather than quietly scheduling.
      due: 'prClosingDate',
      issued: 'prIssuedDate',
      priority: 'priority',
      status: 'prStatus',
      initiator: 'initiator',
    },
  },

  /* ---------------------------------------------------------------- *
   * 3. General activities follow up
   * ---------------------------------------------------------------- */
  {
    id: 'gaf',
    name: 'General Activities',
    short: 'GAF',
    kind: 'jobs',
    group: 'Work',
    description: 'General activities followed up against a tag and an owner.',
    sheetName: 'GAF',
    banner: 'General Activities follow up',
    sheetAliases: ['gaf', 'general activities follow up', 'general activities'],
    identityFields: ['jobDescription', 'tagNo'],
    tableColumns: ['tagNo', 'jobDescription', 'assignedTo', 'issuedDate', 'etc', 'status'],
    fields: [
      text('tagNo', 'Tag No', ['tag no', 'tag', 'tagno', 'equipment tag']),
      longtext('jobDescription', 'Job Descripton', ['job descripton', 'job description', 'description']),
      text('assignedTo', 'Assigned to', OWNER),
      date('issuedDate', 'Issued date', ['issued date', 'issue date', 'date issued']),
      date('etc', 'ETC', ['etc', 'estimated completion', 'target date']),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priorty', 'priority']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      ref: 'tagNo',
      title: 'jobDescription',
      due: 'etc',
      issued: 'issuedDate',
      priority: 'priority',
      status: 'status',
      actionBy: 'assignedTo',
      location: 'tagNo',
    },
  },

  /* ---------------------------------------------------------------- *
   * 4. Fabrication workshop
   * ---------------------------------------------------------------- */
  {
    id: 'fab-ws',
    name: 'Fabrication Workshop',
    short: 'FAB',
    kind: 'jobs',
    group: 'Work',
    description: 'Jobs on the fabrication workshop floor, with material and progress.',
    sheetName: 'Fab WS',
    banner: 'FABRICATION WORKSHOP',
    sheetAliases: ['fab ws', 'fabrication workshop', 'fab', 'workshop'],
    identityFields: ['jobDescription'],
    tableColumns: ['jobDescription', 'assignedTo', 'prNo', 'materialStatus', 'progress', 'etc', 'status'],
    fields: [
      longtext('jobDescription', 'Job Description', ['job description', 'description']),
      text('assignedTo', 'assigne to', OWNER),
      text('prNo', 'PR no', ['pr no', 'pr number', 'prno']),
      suggest(
        'materialStatus',
        'Material Status',
        ['Available', 'Ordered', 'Partially available', 'Not available'],
        ['material status', 'material'],
      ),
      number('progress', 'Progress', ['progress', 'percent complete', 'completion', '%']),
      date('etc', 'ETC', ['etc', 'estimated completion', 'target date']),
      suggest('resources', 'Resources', ['Manpower', 'Material', 'Machinery'], ['resources', 'resource']),
      select('status', 'Status', STATUSES, ['status', 'tracker status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priorty', 'priority']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      title: 'jobDescription',
      due: 'etc',
      priority: 'priority',
      status: 'status',
      actionBy: 'assignedTo',
      progress: 'progress',
    },
  },

  /* ---------------------------------------------------------------- *
   * 5. Planner PMs — the SAP export
   * ---------------------------------------------------------------- */
  {
    id: 'planner-pm',
    name: 'Planner PMs',
    short: 'PM',
    kind: 'jobs',
    group: 'Work',
    description: 'Preventive maintenance orders as SAP issues them, planned against executed.',
    sheetName: 'Planner PMs',
    // The only sheet with no banner at all: it is pasted straight out of SAP, so
    // row 1 is blank and the header is row 2 with nothing above it.
    banner: '',
    sheetAliases: ['planner pms', 'planner pm', 'pm', 'planner'],
    identityFields: ['order', 'description', 'technicalObject'],
    tableColumns: ['order', 'sortField', 'description', 'orderType', 'priorityText', 'userStatus', 'plannedDate', 'executionDate'],
    fields: [
      text('plantSection', 'Plant Section', ['plant section', 'section', 'plant']),
      text('workCenter', 'Main Work Center', ['main work center', 'main work centre', 'work center', 'work centre']),
      text('order', 'Order', ['order', 'order no', 'order number']),
      text('orderType', 'Order Type', ['order type', 'ordertype']),
      text('sortField', 'Sort Field', ['sort field', 'sortfield', 'tag']),
      longtext('technicalObject', 'Description of technical object', [
        'description of technical object',
        'technical object',
      ]),
      longtext('description', 'Description', ['description', 'order description']),
      suggest('priorityText', 'Priority Text', ['Normal work', 'Urgent', 'Shutdown'], ['priority text', 'prioritytext', 'priorty']),
      suggest('userStatus', 'User Status', ['CRTD', 'APPR', 'REL', 'TECO'], ['user status', 'userstatus', 'status']),
      date('plannedDate', 'Planned Date', ['planned date', 'plan date', 'basic start date']),
      date('executionDate', 'Execution date', ['execution date', 'executed date', 'actual date']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      ref: 'order',
      title: 'description',
      due: 'plannedDate',
      // An execution date is the day the order was actually done, which is what
      // closes it — the sheet has no other way of saying so.
      closed: 'executionDate',
      priority: 'priorityText',
      status: 'userStatus',
      location: 'sortField',
    },
    /**
     * A PM order with an execution date is done, whatever its SAP user status
     * still says. The export is taken periodically and the status field lags.
     */
    closeWhenClosedDateSet: true,
  },

  /* ---------------------------------------------------------------- *
   * 6. Jobs assigned by management
   * ---------------------------------------------------------------- */
  {
    id: 'assigned-jobs',
    name: 'Assigned Jobs',
    short: 'ASG',
    kind: 'jobs',
    group: 'Work',
    description: 'Jobs handed down by the line manager, outside any other register.',
    sheetName: 'Assinged Jobs',
    banner: 'ASSIGNED TO ME BY MANAGEMENT (LINE MANAGER)',
    sheetAliases: ['assinged jobs', 'assigned jobs', 'assigned to me by management'],
    identityFields: ['jobDescription'],
    tableColumns: ['jobDescription', 'initiator', 'priority', 'status', 'etc'],
    fields: [
      select('priority', 'Priorty', PRIORITY_VALUES, ['priorty', 'priority']),
      longtext('jobDescription', 'Job Description', ['job description', 'description']),
      text('initiator', 'Initiator', ['initiator', 'raised by', 'assigned by']),
      select('status', 'Status', STATUSES, ['status']),
      date('etc', 'ETC', ['etc', 'estimated completion', 'target date']),
      text('actionBy', 'Action By', OWNER),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      title: 'jobDescription',
      due: 'etc',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      initiator: 'initiator',
    },
  },

  /* ---------------------------------------------------------------- *
   * 7. Rental equipment
   * ---------------------------------------------------------------- */
  {
    id: 'rental-equipment',
    name: 'Rental Equipment',
    short: 'R-EQ',
    kind: 'jobs',
    group: 'Resources',
    description: 'Hired plant on site — what it is for, and when it goes back.',
    sheetName: 'Rental Resourecs Eq',
    banner: 'RESOURCES',
    subBanner: 'RENTAL EQUIPMENT',
    sheetAliases: ['rental resourecs eq', 'rental resources eq', 'rental equipment', 'rental eq'],
    identityFields: ['equipment', 'serialNo', 'activities'],
    tableColumns: ['equipment', 'serialNo', 'area', 'supplier', 'mobilization', 'activities', 'demobilization', 'status'],
    fields: [
      text('prNo', 'PR NO', ['pr no', 'pr number', 'prno']),
      text('equipment', 'Equipmnet', ['equipmnet', 'equipment', 'equipment name']),
      text('serialNo', 'Eq Serial No', ['eq serial no', 'serial no', 'serial number', 'serial']),
      suggest('area', 'Req Area', ['Marine', 'SHP', 'DCU', 'Workshop'], ['req area', 'area', 'required area']),
      text('supplier', 'Supplier', ['supplier', 'suppiler', 'vendor']),
      date('mobilization', 'Mobilization', ['mobilization', 'mobilisation', 'mobilize', 'mob date']),
      longtext('activities', 'Activities', ['activities', 'activity', 'job description', 'description']),
      // The day the machine is due back. It is the only commitment date this
      // sheet carries, and hire is charged until it is met.
      date('demobilization', 'Demobilization', ['demobilization', 'demobilisation', 'demobilize', 'demob date']),
      select('status', 'Status', STATUSES, ['status', 'tracker status']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      ref: 'serialNo',
      title: 'equipment',
      due: 'demobilization',
      issued: 'mobilization',
      status: 'status',
      area: 'area',
      supplier: 'supplier',
    },
  },

  /* ---------------------------------------------------------------- *
   * 8. Rental manpower
   * ---------------------------------------------------------------- */
  {
    id: 'rental-manpower',
    name: 'Rental Manpower',
    short: 'R-MP',
    kind: 'jobs',
    group: 'Resources',
    description: 'Hired trades on site — who they are, who supplied them, and until when.',
    sheetName: 'Rental Resourecs MP',
    banner: 'RESOURCES',
    subBanner: 'RENTAL MANPOWER',
    sheetAliases: ['rental resourecs mp', 'rental resources mp', 'rental manpower', 'rental mp'],
    identityFields: ['name'],
    tableColumns: ['name', 'trade', 'jobDescription', 'supplier', 'iqamaNo', 'mobilize', 'demobilize', 'status'],
    fields: [
      text('prNo', 'PR NO', ['pr no', 'pr number', 'prno']),
      text('name', 'Name', ['name', 'full name']),
      suggest(
        'trade',
        'Trade',
        ['Welder', 'Fabricator', 'Mechanic', 'Rigger 1', 'Rigger 2', 'Boom Truck', 'Helper', 'Scaffolder'],
        ['trade', 'position', 'designation'],
      ),
      longtext('jobDescription', 'JOB DESCRIPTION', ['job description', 'description', 'scope']),
      text('supplier', 'Supplier', ['supplier', 'suppiler', 'vendor', 'agency']),
      // A residency number. It identifies a person to the gate and to the client,
      // so it is kept verbatim as text — a fourteen-digit number Excel has decided
      // to render as 2.5773E+09 is not an Iqama number any more.
      text('iqamaNo', 'Iqama no', ['iqama no', 'iqama', 'iqama number', 'id no']),
      date('mobilize', 'Mobilize', ['mobilize', 'mobilise', 'mobilization', 'mob date']),
      date('demobilize', 'Demobilize', ['demobilize', 'demobilise', 'demobilization', 'demob date']),
      select('status', 'Status', STATUSES, ['status', 'tracker status']),
      longtext('remarks', 'REMARKS', REMARKS),
    ],
    roles: {
      ref: 'iqamaNo',
      title: 'name',
      due: 'demobilize',
      issued: 'mobilize',
      status: 'status',
      // This sheet has no status column of its own — it writes `RELEASED` in
      // REMARKS when somebody goes home. Without reading that, eleven hired
      // trades who left last year sit permanently overdue at the top of the
      // dashboard, which is exactly the noise that makes people stop reading it.
      statusFallback: 'remarks',
      supplier: 'supplier',
      discipline: 'trade',
    },
  },

  /* ---------------------------------------------------------------- *
   * 9. Overhauling status
   * ---------------------------------------------------------------- */
  {
    id: 'overhauling',
    name: 'Overhauling Status',
    short: 'OVH',
    kind: 'jobs',
    group: 'Work',
    description: 'Equipment out for overhaul, and who is doing it.',
    sheetName: 'Overhauling Status',
    banner: 'OVER HAULING STATUS',
    sheetAliases: ['overhauling status', 'over hauling status', 'overhauling', 'overhaul'],
    identityFields: ['tag', 'equipmentName'],
    tableColumns: ['tag', 'equipmentName', 'materialStatus', 'startDate', 'endDate', 'etc', 'serviceProvider', 'status'],
    fields: [
      text('tag', 'Tag', ['tag', 'tag no', 'tagno']),
      text('equipmentName', 'Equipment Name', ['equipment name', 'equipment', 'equipmnet']),
      suggest(
        'materialStatus',
        'Material Status',
        ['Available', 'Ordered', 'Partially available', 'Not available'],
        ['material status', 'material'],
      ),
      date('startDate', 'Start Date', ['start date', 'started on']),
      date('endDate', 'End Date', ['end date', 'finished on']),
      date('etc', 'ETC', ['etc', 'estimated completion', 'target date']),
      select('priority', 'Priorty', PRIORITY_VALUES, ['priorty', 'priority']),
      suggest('serviceProvider', 'Serice Provider', ['Sankyu', 'Flow Serve', 'Samamat'], [
        'serice provider',
        'service provider',
        'provider',
        'vendor',
      ]),
      select('status', 'Status', STATUSES, ['status']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      ref: 'tag',
      title: 'equipmentName',
      due: 'etc',
      issued: 'startDate',
      closed: 'endDate',
      priority: 'priority',
      status: 'status',
      supplier: 'serviceProvider',
      location: 'tag',
    },
  },

  /* ---------------------------------------------------------------- *
   * 10. Management of change
   * ---------------------------------------------------------------- */
  {
    id: 'moc',
    name: 'MOC',
    short: 'MOC',
    kind: 'jobs',
    group: 'Work',
    description: 'Management-of-change packages from raised to approved to done.',
    sheetName: 'MOC',
    banner: 'MOC',
    sheetAliases: ['moc', 'management of change'],
    identityFields: ['mocNo', 'description'],
    tableColumns: ['mocNo', 'tagArea', 'description', 'status', 'initiator', 'startDate', 'endDate', 'etc'],
    fields: [
      text('mocNo', 'MOC NO', ['moc no', 'moc number', 'mocno']),
      text('tagArea', 'Tag No / Area', ['tag no  area', 'tag no area', 'tag no', 'tag', 'area']),
      longtext('description', 'MOC Description', ['moc description', 'description']),
      // The sheet's own three-word legend, not the app's five. Mapping happens on
      // the way to the dashboard; the column keeps the word the team wrote.
      suggest('status', 'Status', ['Pending', 'Approved', 'In progress', 'Completed', 'Rejected'], ['status']),
      text('initiator', 'Initiator', ['initiator', 'raised by']),
      suggest('resources', 'Resources', ['Manpower', 'Material', 'Machinery'], ['resources', 'resource']),
      date('startDate', 'Start Date', ['start date', 'started on']),
      date('endDate', 'End Date', ['end date', 'finished on']),
      date('etc', 'ETC', ['etc', 'estimated completion', 'target date']),
      text('drawingNo', 'IFC no / Drawing No', [
        'ifc no  drawing no',
        'ifc no drawing no',
        'ifc no',
        'drawing no',
      ]),
      select('priority', 'Priority', PRIORITY_VALUES, ['priorty', 'priority']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      ref: 'mocNo',
      title: 'description',
      due: 'etc',
      issued: 'startDate',
      closed: 'endDate',
      priority: 'priority',
      status: 'status',
      initiator: 'initiator',
      location: 'tagArea',
    },
  },

  /* ---------------------------------------------------------------- *
   * 11. Equipment out for repair
   * ---------------------------------------------------------------- */
  {
    id: 'eos-outside',
    name: 'Equipment Outside',
    short: 'EOS',
    kind: 'jobs',
    group: 'Resources',
    description: 'Equipment that has left site for repair, and when it is due back.',
    sheetName: 'EOS Out Side',
    banner: 'EQUIPMENT  OUT SIDE FOR REPAIRING',
    sheetAliases: ['eos out side', 'eos outside', 'equipment out side for repairing', 'eos'],
    identityFields: ['tagNo', 'equipment', 'description'],
    tableColumns: ['tagNo', 'equipment', 'description', 'demobilizationDate', 'serviceProvider', 'mobilizationDate', 'status'],
    fields: [
      text('tagNo', 'Tag No', ['tag no', 'tag', 'tagno']),
      text('equipment', 'Equimpent', ['equimpent', 'equipment', 'equipmnet']),
      longtext('description', 'Description', ['description', 'fault', 'scope']),
      // On this sheet the two words are the other way round from the rental
      // sheets: the equipment is *demobilized* when it leaves site and
      // *mobilized* when it comes back, so the return is the commitment date.
      date('demobilizationDate', 'Demobilization Date', [
        'demobilization date',
        'demobilisation date',
        'sent date',
        'date out',
      ]),
      text('serviceProvider', 'Sevice Provider', ['sevice provider', 'service provider', 'provider', 'vendor']),
      date('mobilizationDate', 'Mobilization Date', [
        'mobilization date',
        'mobilisation date',
        'return date',
        'date back',
      ]),
      text('sourceDriver', 'Soruce /Driver', ['soruce driver', 'source driver', 'source', 'driver']),
      select('status', 'Status', STATUSES, ['status', 'tracker status']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    roles: {
      ref: 'tagNo',
      title: 'equipment',
      due: 'mobilizationDate',
      issued: 'demobilizationDate',
      status: 'status',
      supplier: 'serviceProvider',
      location: 'tagNo',
    },
  },

  /* ---------------------------------------------------------------- *
   * 12–13. Annual plans — one row per person, one column per month
   * ---------------------------------------------------------------- */
  annualPlan({
    id: 'ss-manpower',
    name: 'SS / Workshop Plan',
    short: 'SS',
    sheetName: 'Sankyu SS MP',
    banner: 'SANKYU SUPPORT SERVICE / FABRICATION WORKSHOP MANPOWER',
    sheetAliases: ['sankyu ss mp', 'ss mp', 'sankyu support service', 'ss manpower'],
    description: 'Support-service and workshop manpower, planned month by month.',
  }),

  annualPlan({
    id: 'dcu-manpower',
    name: 'DCU Vacation Plan',
    short: 'DCU',
    sheetName: 'Sankyu DCU MP',
    banner: 'ANNUAL VACATION PLAN',
    sheetAliases: ['sankyu dcu mp', 'dcu mp', 'annual vacation plan', 'dcu manpower'],
    description: 'Annual vacation plan for the DCU team, month by month.',
  }),

  /* ---------------------------------------------------------------- *
   * 14. JTS programme
   * ---------------------------------------------------------------- */
  {
    id: 'jts',
    name: 'JTS Programme',
    short: 'JTS',
    kind: 'people',
    group: 'People',
    description: 'Job training standards: tasks assigned to each person, quarter by quarter.',
    sheetName: 'JTS',
    banner: 'JTS PROGRAM',
    sheetAliases: ['jts', 'jts program', 'jts programme'],
    identityFields: ['name', 'empNo'],
    tableColumns: ['empNo', 'name', 'position', 'q1', 'q2', 'q3', 'q4', 'totalTask', 'status'],
    /**
     * The header is split across two rows: `Q1`–`Q4` sit on the upper row and
     * `Assigned Task` repeats underneath all four. The reader combines the two,
     * preferring whichever row names the column more specifically.
     */
    headerSpansTwoRows: true,
    fields: [
      text('empNo', 'Emp No', ['emp no', 'employee no', 'empno', 'id no']),
      text('name', 'Name', ['name', 'full name']),
      text('position', 'Position', ['position', 'designation', 'trade']),
      number('q1', 'Q1', ['q1', 'q 1', 'quarter 1']),
      number('q2', 'Q2', ['q2', 'q 2', 'quarter 2']),
      number('q3', 'Q3', ['q3', 'q 3', 'quarter 3']),
      number('q4', 'Q4', ['q4', 'q 4', 'quarter 4']),
      // Read from the sheet if it is there, but always recomputed — a total that
      // disagrees with the four numbers beside it is worse than no total.
      computed('totalTask', 'Total Task', ['total task', 'total tasks', 'total']),
      select('status', 'STATUS', STATUSES, ['status']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    matrix: {
      cells: ['q1', 'q2', 'q3', 'q4'],
      cellLabel: 'Quarter',
      coverageOrder: 'declared',
      // A person is covered when they have been given a task in every quarter.
      measure: 'Assigned quarters',
    },
    computeRow: (data) => {
      const total = ['q1', 'q2', 'q3', 'q4'].reduce((sum, key) => {
        const n = Number(data[key]);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);
      return { totalTask: total || null };
    },
    roles: {
      ref: 'empNo',
      title: 'name',
      status: 'status',
      discipline: 'position',
    },
  },

  /* ---------------------------------------------------------------- *
   * 15. Safety training matrix
   * ---------------------------------------------------------------- */
  {
    id: 'safety',
    name: 'Safety Training',
    short: 'SAF',
    kind: 'people',
    group: 'People',
    description: 'Which of the fifteen safety courses each person has behind them.',
    sheetName: 'Safety',
    banner: 'SAFETY TRAINING STATUS',
    sheetAliases: ['safety', 'safety training status', 'safety training'],
    identityFields: ['name', 'empNo'],
    // The fifteen course columns are the sheet — a table of names and positions
    // with the grid left off answers nothing anybody opens this page for.
    tableColumns: [
      'empNo', 'name', 'position', 'priority',
      'permitReceiver', 'loto', 'workAtHeight', 'confinedSpace', 'fireFighting', 'fireWatch',
      'confinedAttendant', 'emergencyResponse', 'handPowerTools', 'chemicalHandling', 'heatStress',
      'electricalSafety', 'incidentReporting', 'h2s', 'flagMan',
    ],
    headerSpansTwoRows: true,
    fields: [
      text('empNo', 'EMP NO', ['emp no', 'employee no', 'empno', 'id no']),
      text('name', 'NAME', ['name', 'full name']),
      text('position', 'POSITION', ['position', 'designation', 'trade']),
      select('priority', 'Priorty', PRIORITY_VALUES, ['priorty', 'priority']),
      // The workbook's own spellings, kept exactly: these are the column headings
      // the safety officer reads down, and renaming them would make the printed
      // matrix stop matching the one on the wall.
      gridText('permitReceiver', 'Work Permit Receiver ID', 'Permit ID', ['work permit receiver id', 'work permit receiver']),
      gridText('loto', 'Lockout/ Tag Out (LOTO)', 'LOTO', ['lockout tag out loto', 'loto', 'lockout tagout']),
      gridText('workAtHeight', 'Work At height', 'Height', ['work at height', 'working at height']),
      gridText('confinedSpace', 'confiende space', 'Confined', ['confiende space', 'confined space']),
      gridText('fireFighting', 'Fire Fighting', 'Fire Fight', ['fire fighting', 'firefighting']),
      gridText('fireWatch', 'Fire Watch', 'Fire Watch', ['fire watch', 'firewatch']),
      gridText('confinedAttendant', 'Confiend spacer Attender', 'CS Attend', [
        'confiend spacer attender',
        'confined space attendant',
        'confined spacer attender',
      ]),
      gridText('emergencyResponse', 'EmergencyRespnose/ Evacuation', 'Emergency', [
        'emergencyrespnose evacuation',
        'emergency response evacuation',
        'emergency response',
      ]),
      gridText('handPowerTools', 'Hand & Power Tool Safety', 'Hand Tools', ['hand  power tool safety', 'hand power tool safety']),
      gridText('chemicalHandling', 'Chemical Handling SDS', 'Chemicals', ['chemical handling sds', 'chemical handling']),
      gridText('heatStress', 'Heat Stress  Prevention', 'Heat', ['heat stress prevention', 'heat stress']),
      gridText('electricalSafety', 'Electrical Safety Awareness', 'Electrical', ['electrical safety awareness', 'electrical safety']),
      gridText('incidentReporting', 'Incident /  Near-Miss Reporting', 'Near-Miss', [
        'incident nearmiss reporting',
        'incident near miss reporting',
        'near miss reporting',
      ]),
      gridText('h2s', 'H2S Awarness', 'H2S', ['h2s awarness', 'h2s awareness', 'h2s']),
      gridText('flagMan', 'Flag Man', 'Flag Man', ['flag man', 'flagman']),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    matrix: {
      cells: [
        'permitReceiver',
        'loto',
        'workAtHeight',
        'confinedSpace',
        'fireFighting',
        'fireWatch',
        'confinedAttendant',
        'emergencyResponse',
        'handPowerTools',
        'chemicalHandling',
        'heatStress',
        'electricalSafety',
        'incidentReporting',
        'h2s',
        'flagMan',
      ],
      cellLabel: 'Course',
      measure: 'Courses held',
      // Courses read thinnest first: the one only five people hold is the only
      // thing on the page anybody can act on.
      coverageOrder: 'thinnest',
    },
    roles: {
      ref: 'empNo',
      title: 'name',
      priority: 'priority',
      discipline: 'position',
    },
  },
];

/**
 * The two annual plans are the same sheet twice — a person per row, a month per
 * column — so they are built from one description rather than copied.
 *
 * They differ only in whose team they cover and what the banner calls the plan.
 */
function annualPlan({ id, name, short, sheetName, banner, sheetAliases, description }) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LONG = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const cells = MONTHS.map((_, i) => `m${i + 1}`);

  return {
    id,
    name,
    short,
    kind: 'people',
    group: 'People',
    description,
    sheetName,
    banner,
    // "Year 2026" sits on its own row between the banner and the header.
    subBanner: 'Year',
    sheetAliases,
    identityFields: ['name', 'empNo'],
    tableColumns: ['empNo', 'name', 'position', ...cells],
    fields: [
      text('empNo', 'Emp No', ['emp no', 'employee no', 'empno', 'id no']),
      text('name', 'Name', ['name', 'full name']),
      text('position', 'Position', ['position', 'designation', 'trade']),
      ...MONTHS.map((label, i) => month(cells[i], label, i + 1, [LONG[i], label.toLowerCase()])),
      longtext('remarks', 'Remarks', REMARKS),
    ],
    matrix: {
      cells,
      cellLabel: 'Month',
      measure: 'Months planned',
      // Months read in calendar order. Sorting them by how full they are
      // answers "which month is quietest" and destroys "when is the summer
      // gap", which is the question a vacation plan exists for.
      coverageOrder: 'declared',
    },
    roles: {
      ref: 'empNo',
      title: 'name',
      discipline: 'position',
    },
  };
}

/* ------------------------------------------------------------------ *
 * Lookups and derivation
 * ------------------------------------------------------------------ */

const BY_ID = new Map(REGISTERS.map((r) => [r.id, r]));

export function getRegister(id) {
  return BY_ID.get(id) ?? null;
}

export function fieldMap(register) {
  return new Map(register.fields.map((f) => [f.key, f]));
}

/** The window the team calls "coming up". */
export const DUE_SOON_DAYS = 30;

export function dueState(dueDate, status, daysUntilFn) {
  if (CLOSED_STATUSES.has(status)) return 'closed';
  if (!dueDate) return 'undated';
  const days = daysUntilFn(dueDate);
  if (days === null) return 'undated';
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return 'scheduled';
}

/**
 * Fold a register-specific row into the shared shape the dashboard reads.
 *
 * Only derived values come back; the row's own `data` is stored untouched beside
 * it, so nothing the sheet said is lost to normalisation.
 */
export function deriveRecord(register, data, { toDateOnly }) {
  const roles = register.roles ?? {};
  const pick = (role) => {
    const key = roles[role];
    if (!key) return null;
    const value = data?.[key];
    if (value === null || value === undefined) return null;
    const trimmed = typeof value === 'string' ? value.trim() : value;
    return trimmed === '' ? null : trimmed;
  };
  const str = (role) => {
    const value = pick(role);
    return value === null ? null : String(value).trim();
  };

  const dueRaw = pick('due');
  const dueDate = toDateOnly(dueRaw);
  const closedDate = toDateOnly(pick('closed'));

  // The app's own status column wins when it is set; the sheet's own way of
  // saying so is read only when it is not.
  let status = normaliseStatus(pick('status')) ?? normaliseStatus(pick('statusFallback')) ?? 'Not Started';
  if (register.closeWhenClosedDateSet && closedDate && !CLOSED_STATUSES.has(status)) {
    status = 'Completed';
  }

  const matrix = register.matrix;
  const filled = matrix
    ? matrix.cells.filter((key) => String(data?.[key] ?? '').trim() !== '').length
    : null;

  return {
    ref: str('ref'),
    title: str('title'),
    // The phrase behind an undated cell — `Next Shutdown`, `SEP` — kept so the
    // table can say why a row has no date instead of showing an empty box.
    dueText: dueDate ? null : dueRaw === null ? null : String(dueRaw),
    dueDate,
    issuedDate: toDateOnly(pick('issued')),
    closedDate,
    priority: normalisePriority(pick('priority')) ?? 'Medium',
    priorityRaw: str('priority'),
    status,
    statusRaw: str('status') ?? (normaliseStatus(pick('statusFallback')) ? str('statusFallback') : null),
    actionBy: str('actionBy'),
    initiator: str('initiator'),
    area: str('area'),
    supplier: str('supplier'),
    discipline: str('discipline'),
    location: str('location'),
    progress: toProgress(pick('progress')),
    // For the people sheets: how much of this person's row is filled in, which
    // is the only "how are we doing" question a matrix can answer.
    filledCells: filled,
    totalCells: matrix ? matrix.cells.length : null,
  };
}

/** `80`, `80%` and `0.8` all mean the same thing in a Progress column. */
function toProgress(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Serialisable definitions for the browser, so the UI is never a second source of truth. */
export function registerCatalogue() {
  return REGISTERS.map((r) => ({
    id: r.id,
    name: r.name,
    short: r.short,
    kind: r.kind,
    group: r.group,
    description: r.description,
    sheetName: r.sheetName,
    fields: r.fields,
    tableColumns: r.tableColumns,
    identityFields: r.identityFields,
    roles: r.roles ?? {},
    matrix: r.matrix ?? null,
    autoNumber: r.autoNumber ?? null,
  }));
}

/** The heading a sheet carries when it is exported as a document. */
export function exportTitle(register) {
  return register.banner || `Engineering ${register.name}`;
}
