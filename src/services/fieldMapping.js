/**
 * services/fieldMapping.js
 * Lets admins configure Revizto <-> ACC status and issue-type mappings
 * per project, instead of relying only on the hardcoded defaults
 * (reviztoService's mapStatusToAcc keyword map, and STAMP_SUBTYPE_MAP
 * title-keyword matching). Configured mappings take priority; the
 * hardcoded defaults remain as a fallback so projects that haven't
 * configured anything keep working exactly as before.
 */
const pool = require('../db/pool');
const reviztoService = require('./reviztoService');
const accService = require('./accService');

// ACC's Issues API status field is a fixed enum, not project-configurable —
// this list is what the old app's working mapStatusFromAcc already used
// successfully, so treat it as confirmed rather than guessed.
const ACC_STATUS_OPTIONS = [
  'open',
  'in_progress',
  'in_review',
  'not_approved',
  'in_dispute',
  'completed',
  'closed',
  'draft',
  'pending',
];

// ─── Option lists for the mapping UI (real data, not guesses) ────────

// These 4 are common to virtually every Revizto project's default
// workflow — always shown in the mapping dropdown in this order, even if
// no current issue happens to have that status yet, so an admin can
// pre-configure them. CASING NOTE: only "In progress" (lowercase "p") is
// confirmed from real data; "Open"/"Solved"/"Closed" are reasonable
// guesses — if one doesn't match what you see on real issues, that
// mismatch is the thing to fix here.
const CANONICAL_STATUS_ORDER = ['Open', 'In progress', 'Solved', 'Closed'];

async function getMappingOptions(userId, project) {
  const [issues, subtypes, stampPresets] = await Promise.all([
    reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid),
    accService.getIssueSubtypes(userId, project),
    reviztoService.getStampPresets(userId, project.revizto_region, project.revizto_project_uuid).catch(() => []),
  ]);

  // Statuses actually in use on existing issues (used for the unmapped
  // warning, so we don't flag a canonical status as "unmapped" when no
  // issue even has it yet — that's not an actual problem).
  const inUseStatuses = [...new Set(issues.map((i) => reviztoService.unwrap(i.customStatusName)).filter(Boolean))];
  // For the mapping dropdown: canonical 4 first in fixed order, then any
  // other in-use statuses not already in that set, alphabetically.
  const extraStatuses = inUseStatuses.filter((s) => !CANONICAL_STATUS_ORDER.includes(s)).sort();
  const reviztoStatuses = [...CANONICAL_STATUS_ORDER, ...extraStatuses];

  // Same "in use" filter for stamps — a project can have many stamp
  // templates defined that no current issue actually uses; without this
  // filter the mapping list (and the unmapped-count warning derived from
  // it) shows every template that's ever existed, not what's real today.
  const usedStampAbbrs = new Set(issues.map((i) => reviztoService.unwrap(i.stampAbbr)).filter(Boolean));
  const reviztoStamps = reviztoService.buildStampOptions(stampPresets).filter((s) => usedStampAbbrs.has(s.value));

  return {
    reviztoStatuses,
    reviztoStatusesInUse: inUseStatuses, // for the warning check — not padded with unused canonical statuses
    accStatuses: ACC_STATUS_OPTIONS,
    accSubtypes: subtypes.map((s) => ({ id: s.id, label: `${s.issueTypeTitle} > ${s.title}` })),
    reviztoStamps,
  };
}

// ─── Status map CRUD ───────────────────────────────────────────────

async function getStatusMap(projectId) {
  const { rows } = await pool.query('SELECT revizto_status, acc_status FROM status_map WHERE project_id = $1', [projectId]);
  return Object.fromEntries(rows.map((r) => [r.revizto_status, r.acc_status]));
}

async function saveStatusMap(projectId, mappings) {
  // mappings: [{ reviztoStatus, accStatus }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM status_map WHERE project_id = $1', [projectId]);
    for (const m of mappings) {
      if (!m.reviztoStatus || !m.accStatus) continue;
      await client.query(
        'INSERT INTO status_map (project_id, revizto_status, acc_status) VALUES ($1, $2, $3)',
        [projectId, m.reviztoStatus, m.accStatus]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Type map CRUD ───────────────────────────────────────────────────

async function getTypeMap(projectId) {
  const { rows } = await pool.query('SELECT revizto_type, acc_subtype_id FROM type_map WHERE project_id = $1', [projectId]);
  return Object.fromEntries(rows.map((r) => [r.revizto_type, r.acc_subtype_id]));
}

async function saveTypeMap(projectId, mappings) {
  // mappings: [{ reviztoType, accSubtypeId }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM type_map WHERE project_id = $1', [projectId]);
    for (const m of mappings) {
      if (!m.reviztoType || !m.accSubtypeId) continue;
      await client.query(
        'INSERT INTO type_map (project_id, revizto_type, acc_subtype_id) VALUES ($1, $2, $3)',
        [projectId, m.reviztoType, m.accSubtypeId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * For the Setup page's top-of-page warning: which in-use statuses/stamps
 * have no configured mapping yet. Admin-facing — this is an action item,
 * not a general stat (unlike getSyncStats, which any user can see).
 */
async function getUnmappedFields(userId, project) {
  const [mappingOptions, savedStatusMap, savedTypeMap] = await Promise.all([
    getMappingOptions(userId, project),
    getStatusMap(project.id),
    getTypeMap(project.id),
  ]);

  const unmappedStatuses = mappingOptions.reviztoStatusesInUse.filter((s) => !savedStatusMap[s]);
  const mappedStampAbbrs = new Set(Object.keys(savedTypeMap));
  const unmappedStamps = (mappingOptions.reviztoStamps || [])
    .filter((s) => !mappedStampAbbrs.has(s.value))
    .map((s) => s.label);

  return { unmappedStatuses, unmappedStamps };
}

module.exports = {
  ACC_STATUS_OPTIONS,
  getMappingOptions,
  getStatusMap,
  saveStatusMap,
  getTypeMap,
  saveTypeMap,
  getUnmappedFields,
};
