/**
 * services/reviztoService.js
 * Revizto Workspace API v5 calls, per-user token via authManager, plus
 * the Revizto <-> ACC field mapping logic carried over from the old app
 * (title/description/status/dueDate/assignee, plus the stamp-category ->
 * ACC subtype keyword matching).
 */
const axios = require('axios');
const FormData = require('form-data');
const { getValidReviztoToken } = require('./authManager');

function baseUrl(region) {
  return `https://api.${region}.revizto.com/v5`;
}

// NOTE: `region` here is the region of the DATA being requested (e.g. a
// project's region), while authManager.getValidReviztoToken looks up the
// region the calling user's own token was issued in. These are expected to
// match in normal use (a user's Revizto account and the projects they
// access are on the same regional API) — if they diverge, Revizto's own
// -205 error ("access token obtained in a different region") will surface
// it rather than failing silently.
async function request(userId, region, method, url, options = {}) {
  const token = await getValidReviztoToken(userId);
  try {
    const { data } = await axios({
      method,
      url: `${baseUrl(region)}${url}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
      params: options.params || {},
      data: options.body,
    });
    return data;
  } catch (err) {
    const msg = err.response?.data?.message || '';
    const result = err.response?.data?.result;
    if (result === -206 || msg.includes('-206')) {
      // Access token expired mid-flight — authManager's refresh on next call
      // will handle it; surface a clear retry-once here.
      const newToken = await getValidReviztoToken(userId);
      const { data } = await axios({
        method,
        url: `${baseUrl(region)}${url}`,
        headers: { Authorization: `Bearer ${newToken}`, 'Content-Type': 'application/json', ...options.headers },
        params: options.params || {},
        data: options.body,
      });
      return data;
    }
    throw err;
  }
}

// ─── Issues ───────────────────────────────────────────────────────

async function getIssues(userId, region, projectUuid, filters = {}) {
  const allIssues = [];
  let page = 0;
  let totalPages = 1;
  while (page < totalPages) {
    const response = await request(userId, region, 'POST', `/project/${projectUuid}/issue-filter/filter`, {
      body: { page, limit: 100, sendFullIssueData: true, alwaysFiltersDTO: [], ...filters },
    });
    const issues = response.data?.data || [];
    allIssues.push(...issues);
    totalPages = response.data?.pages || 1;
    page++;
  }
  return allIssues;
}

async function getIssue(userId, region, projectUuid, issueId) {
  const response = await request(userId, region, 'POST', `/project/${projectUuid}/issue-filter/filter`, {
    body: {
      page: 0,
      limit: 1,
      sendFullIssueData: true,
      alwaysFiltersDTO: [{ type: 'id', expr: 1, value: [String(issueId)] }],
    },
  });
  const issues = response.data?.data || [];
  if (!issues.length) throw new Error(`Revizto issue ${issueId} not found`);
  return issues[0];
}

let _workflowCache = {};
async function getStatusMap(userId, region, projectUuid) {
  if (_workflowCache[projectUuid]) return _workflowCache[projectUuid];
  const response = await request(userId, region, 'GET', `/project/${projectUuid}/issue-workflow/settings`);
  const statuses = response.data?.statuses || [];
  const map = {};
  for (const s of statuses) map[s.name] = s.uuid;
  _workflowCache[projectUuid] = map;
  return map;
}

async function updateIssueStatus(userId, region, projectUuid, issueId, newStatusName, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const issueUuid = issue.uuid;
  const oldStatusUuid = issue.customStatus?.value || null;

  const statusMap = await getStatusMap(userId, region, projectUuid);
  const newStatusUuid = statusMap[newStatusName];
  if (!newStatusUuid) {
    console.warn('[revizto] Status not found in workflow:', newStatusName);
    return null;
  }

  const commentUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

  const form = new FormData();
  form.append('projectUuid', projectUuid);
  form.append('issueUuid', issueUuid);
  form.append(
    'comments',
    JSON.stringify([
      {
        type: 'diff',
        uuid: commentUuid,
        reporter: reporterEmail,
        diff: { customStatus: { old: oldStatusUuid, new: newStatusUuid } },
      },
    ])
  );

  const token = await getValidReviztoToken(userId);
  const { data } = await axios.post(`${baseUrl(region)}/comment/add`, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
  });
  // NOTE: the top-level `result` field on this endpoint is NOT a simple
  // 0=success indicator like other Revizto endpoints — confirmed from a
  // real successful call that returned result:30 with the update fully
  // applied. The real success/failure signal is nested per-comment in
  // `data.data[].result` (0 = that comment succeeded).
  const commentResult = data?.data?.[0]?.result;
  if (commentResult !== undefined && commentResult !== 0) {
    console.warn('[revizto] updateIssueStatus comment failed:', JSON.stringify(data));
  }
  return data;
}

async function addComment(userId, region, projectUuid, issueId, text, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const commentUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  const form = new FormData();
  form.append('projectUuid', projectUuid);
  form.append('issueUuid', issue.uuid);
  form.append('comments', JSON.stringify([{ type: 'text', uuid: commentUuid, reporter: reporterEmail, text }]));

  const token = await getValidReviztoToken(userId);
  const { data } = await axios.post(`${baseUrl(region)}/comment/add`, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
  });
  return data;
}

/**
 * GET /v5/project/list/{licenseUuid}/paged — the real, documented endpoint.
 * (Earlier version of this code called a `/project/list?licenseId=` shape
 * copied from the old app, which turned out not to match current docs —
 * this replaces it.)
 * NOTE: ProjectListItem field names (what's actually inside data.data[])
 * are still unconfirmed — ask for that section of the docs before trusting
 * the mapping in routes/index.js.
 */
/**
 * GET /v5/license/{licenseUuid}/team — full license member list, each
 * with a nested `user` object including email/fullname/firstname/lastname.
 * Used to resolve an issue's assignee (a bare email) into a display name.
 */
async function getLicenseMembers(userId, region, licenseUuid, withDeactivated = false) {
  const response = await request(userId, region, 'GET', `/license/${licenseUuid}/team`, {
    params: withDeactivated ? { withDeactivated: true } : {},
  });
  return response.data?.entities || [];
}

/**
 * Builds { [email]: fullname } from getLicenseMembers' output.
 */
function buildMemberNameLookup(members) {
  const byEmail = {};
  for (const m of members) {
    if (m.user?.email && m.user?.fullname) byEmail[m.user.email.toLowerCase()] = m.user.fullname;
  }
  return byEmail;
}

async function getProjects(userId, region, licenseUuid, { page = 0, limit = 100, type = 'default' } = {}) {
  const allProjects = [];
  let currentPage = page;
  let totalPages = 1;
  while (currentPage < totalPages) {
    const response = await request(userId, region, 'GET', `/project/list/${licenseUuid}/paged`, {
      params: { page: currentPage, limit, type, sorting: 'name+' },
    });
    const items = response.data?.data || [];
    allProjects.push(...items);
    totalPages = response.data?.pages || 1;
    currentPage++;
  }
  return allProjects;
}

/**
 * GET /v5/user/licenses — lists licenses available to the current user.
 * NOTE: the docs define `id` here as an integer (e.g. 12345), but the old
 * app's working .env had REVIZTO_LICENSE_ID as a string like "USA-38628" —
 * those don't obviously match. We don't have confirmed docs for what
 * /project/list's `licenseId` param itself expects, only this endpoint's
 * shape. If project browsing fails after picking a license here, that
 * mismatch is the first thing to check.
 */
async function getLicenses(userId, region, accountUuid) {
  return request(userId, region, 'GET', '/user/licenses', {
    params: accountUuid ? { accountUuid } : {},
  });
}

/**
 * GET /v5/project/{projectUuid}/issue-preset/list — stamp templates and
 * their categories for a project. A "category" is an entity with
 * nodeRole=2; a "template" (individual stamp) has nodeRole=1 and points
 * to its category via parentUuid. Each template's `fields` is a
 * JSON-encoded STRING (not a nested object) containing stampAbbr,
 * customType, etc. — confirmed from Revizto's docs example response.
 */
async function getStampPresets(userId, region, projectUuid) {
  const all = [];
  let page = 0;
  let keepGoing = true;
  while (keepGoing) {
    const response = await request(userId, region, 'GET', `/project/${projectUuid}/issue-preset/list`, {
      params: { page },
    });
    const entities = response.data?.entities || [];
    all.push(...entities);
    keepGoing = entities.length === 200; // page size per docs; short page = last page
    page++;
  }
  return all;
}

/**
 * Builds a { [stampAbbr]: categoryTitle } lookup from getStampPresets'
 * output, so an issue's `stamp` field (the abbreviation) can be resolved
 * to a human-readable category name. Stamp category is NOT a direct field
 * on an issue — this indirection is why.
 */
function buildStampCategoryLookup(presetEntities) {
  const categoriesByUuid = {};
  for (const e of presetEntities) {
    if (e.nodeRole === 2) categoriesByUuid[e.uuid] = e.title;
  }
  const byAbbr = {};
  for (const e of presetEntities) {
    if (e.nodeRole !== 1) continue;
    let fields = {};
    try {
      fields = typeof e.fields === 'string' ? JSON.parse(e.fields) : e.fields || {};
    } catch {
      continue;
    }
    if (fields.stampAbbr && e.parentUuid && categoriesByUuid[e.parentUuid]) {
      byAbbr[fields.stampAbbr] = categoriesByUuid[e.parentUuid];
    }
  }
  return { byAbbr, categories: Object.values(categoriesByUuid) };
}

/**
 * Builds { [stampAbbr]: templateTitle } — for showing the human-readable
 * stamp title in the Issues page filter instead of the raw abbreviation.
 */
function buildStampTitleLookup(presetEntities) {
  const byAbbr = {};
  for (const e of presetEntities) {
    if (e.nodeRole !== 1) continue;
    let fields = {};
    try {
      fields = typeof e.fields === 'string' ? JSON.parse(e.fields) : e.fields || {};
    } catch {
      continue;
    }
    if (fields.stampAbbr && e.title) byAbbr[fields.stampAbbr] = e.title;
  }
  return byAbbr;
}

/**
 * Builds [{ value: stampAbbr, label: "Category > Stamp Title" }] for the
 * type-mapping dropdown — one entry per stamp template (nodeRole=1),
 * value is the abbreviation (what's matched against an issue's stampAbbr
 * at push time), label shows category + template title for readability.
 * Templates without a stampAbbr or an unresolvable parent category are
 * skipped (can't be reliably matched or labeled).
 */
function buildStampOptions(presetEntities) {
  const categoriesByUuid = {};
  for (const e of presetEntities) {
    if (e.nodeRole === 2) categoriesByUuid[e.uuid] = e.title;
  }
  const options = [];
  for (const e of presetEntities) {
    if (e.nodeRole !== 1) continue;
    let fields = {};
    try {
      fields = typeof e.fields === 'string' ? JSON.parse(e.fields) : e.fields || {};
    } catch {
      continue;
    }
    const categoryTitle = e.parentUuid ? categoriesByUuid[e.parentUuid] : null;
    if (fields.stampAbbr && categoryTitle && e.title) {
      options.push({ value: fields.stampAbbr, label: `${categoryTitle} > ${e.title}` });
    }
  }
  return options;
}

// ─── Field mapping (Revizto -> ACC) ─────────────────────────────────

function unwrap(field) {
  if (field === null || field === undefined) return null;
  if (typeof field === 'object' && 'value' in field) return field.value;
  return field;
}

function formatDateForAcc(dateStr) {
  const d = unwrap(dateStr);
  if (!d) return null;
  if (d === '2000-01-01 00:00:00' || d === '1970-01-01 00:00:00') return null;
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

const STAMP_SUBTYPE_MAP = [
  { contains: 'building code', label: 'Design > Building Code' },
  { contains: 'commissioning', label: 'Commissioning > Commissioning' },
  { contains: 'coordination', label: 'Coordination > Coordination' },
  { contains: 'clash', label: 'Coordination > Clash' },
  { contains: 'design', label: 'Design > Design' },
  { contains: 'observation', label: 'Observation > Observation' },
  { contains: 'punch', label: 'Punch List > Punch List' },
  { contains: 'quality', label: 'Quality > Quality' },
  { contains: 'safety', label: 'Safety > Safety' },
];

/**
 * Looks up an ACC subtype ID from the project's subtype list based on
 * keyword-matching the issue title. `subtypeLookup` is a map of
 * label -> id, fetched live from ACC (accService.getIssueSubtypes) rather
 * than hardcoded, since subtype IDs differ per ACC project/template.
 */
function getSubtypeIdForIssue(title, subtypeLookup, defaultSubtypeId) {
  const lower = (title || '').toLowerCase();
  for (const mapping of STAMP_SUBTYPE_MAP) {
    if (lower.includes(mapping.contains) && subtypeLookup[mapping.label]) {
      return subtypeLookup[mapping.label];
    }
  }
  return defaultSubtypeId;
}

function mapStatusToAcc(reviztoStatus) {
  const safeStatus = reviztoStatus == null ? '' : String(reviztoStatus).toLowerCase().trim();
  const map = {
    open: 'open',
    'in progress': 'in_progress',
    inprogress: 'in_progress',
    in_progress: 'in_progress',
    solved: 'completed',
    closed: 'closed',
    void: 'closed',
  };
  return map[safeStatus] || 'open';
}

function mapStatusFromAcc(accStatus) {
  const map = {
    open: 'Open',
    in_progress: 'In progress',
    completed: 'Solved',
    closed: 'Closed',
    draft: 'Open',
    pending: 'Open',
    in_review: 'In progress',
    not_approved: 'In progress',
    in_dispute: 'In progress',
  };
  return map[accStatus] || 'Open';
}

/**
 * Build an ACC issue payload from a Revizto issue.
 * assigneeResolver: async (email) => autodeskId | null
 */
async function toAccIssue(reviztoIssue, { subtypeLookup = {}, defaultSubtypeId, assigneeResolver, customStatusMap = null, customTypeMap = null, reviztoStatusName = null } = {}) {
  const title = unwrap(reviztoIssue.title) || '(no title)';
  const description = unwrap(reviztoIssue.description) || '';
  const dueDate = formatDateForAcc(reviztoIssue.deadline);

  // Status comes from `customStatus` (a UUID resolved against the
  // project's workflow settings) — NOT `status`, which Revizto's own docs
  // mark deprecated and doesn't reliably exist on real responses. The
  // caller (syncService.pushIssueToAcc) resolves the UUID to a name via
  // getStatusMap before calling this, since that resolution needs
  // project/region context this function doesn't have.
  const status = (customStatusMap && customStatusMap[reviztoStatusName]) || mapStatusToAcc(reviztoStatusName);

  // Admin-configured type mapping is now keyed by stamp abbreviation (the
  // Setup page dropdown shows "Category > Stamp Title" but stores the
  // abbreviation, since that's what's actually on an issue). Falls back to
  // customTypeName, then title-keyword matching, when no configured
  // mapping matches.
  const rawType = unwrap(reviztoIssue.stampAbbr) ?? unwrap(reviztoIssue.customTypeName) ?? null;
  const subtypeId =
    (customTypeMap && rawType && customTypeMap[rawType]) || getSubtypeIdForIssue(title, subtypeLookup, defaultSubtypeId);

  const payload = { title: String(title), description: String(description), status, issueSubtypeId: subtypeId };
  // ACC's API likely wants dueDate either a real date string or omitted
  // entirely — sending an explicit `null` for a string field is a
  // plausible cause of the "must be string" validation error seen on
  // issues without a due date set.
  if (dueDate) payload.dueDate = dueDate;

  // assigneeResolver is really a generic (email) -> Autodesk user ID
  // resolver — reused here for both assignee (single) and watchers
  // (array), not just assignee despite the parameter name.
  const assigneeEmail = unwrap(reviztoIssue.assignee);
  if (assigneeEmail && assigneeResolver) {
    const assignedTo = await assigneeResolver(assigneeEmail);
    if (assignedTo) {
      payload.assignedTo = assignedTo;
      payload.assignedToType = 'user';
    }
  }

  // Confirmed from real data: Revizto's `watchers` field is an array of
  // emails. Confirmed from ACC's own create-issues docs example: ACC's
  // `watchers` field is an array of Autodesk user IDs — same ID format
  // as assignedTo, so the same resolver applies per-email.
  const watcherEmails = unwrap(reviztoIssue.watchers) || [];
  if (watcherEmails.length && assigneeResolver) {
    const resolvedWatchers = [];
    for (const email of watcherEmails) {
      const autodeskId = await assigneeResolver(email);
      if (autodeskId) resolvedWatchers.push(autodeskId);
    }
    if (resolvedWatchers.length) payload.watchers = resolvedWatchers;
  }

  return payload;
}

module.exports = {
  getIssues,
  getIssue,
  updateIssueStatus,
  addComment,
  getProjects,
  getLicenses,
  getLicenseMembers,
  buildMemberNameLookup,
  getStatusMap,
  getStampPresets,
  buildStampCategoryLookup,
  buildStampTitleLookup,
  buildStampOptions,
  toAccIssue,
  mapStatusFromAcc,
  mapStatusToAcc,
  unwrap,
};
