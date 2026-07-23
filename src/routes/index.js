const express = require('express');
const router = express.Router();
const path = require('path');
const pool = require('../db/pool');
const { requireLogin, requireAdmin } = require('./auth');
const syncService = require('../services/syncService');
const accService = require('../services/accService');
const reviztoService = require('../services/reviztoService');
const tokenStore = require('../services/tokenStore');
const fieldMapping = require('../services/fieldMapping');
const { ReconnectRequiredError } = require('../services/authManager');

// ─── Revizto license browser (for the license dropdown) ─────────────

router.get('/api/revizto/licenses', requireLogin, async (req, res) => {
  const tokens = await tokenStore.getReviztoTokens(req.session.userId);
  if (!tokens) return res.status(409).json({ error: 'Connect Revizto first' });
  try {
    const response = await reviztoService.getLicenses(req.session.userId, tokens.region);
    const licenses = (response.data?.entities || []).map((l) => ({
      id: l.id,
      uuid: l.uuid,
      name: l.name,
      region: l.region,
      frozen: l.frozen,
    }));
    res.json({ licenses });
  } catch (err) {
    console.error('[revizto] getLicenses failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.get('/api/revizto/projects', requireLogin, async (req, res) => {
  const tokens = await tokenStore.getReviztoTokens(req.session.userId);
  if (!tokens) return res.status(409).json({ error: 'Connect Revizto first' });
  if (!tokens.license_id) {
    return res.status(409).json({ error: 'missing_license_id', message: 'Select your Revizto license first' });
  }
  try {
    // tokens.license_id now holds the license UUID (not the numeric id) —
    // see reviztoService.getProjects for why.
    const items = await reviztoService.getProjects(req.session.userId, tokens.region, tokens.license_id);
    // FIELD MAPPING UNVERIFIED: guessing uuid/name based on convention —
    // confirm against real ProjectListItem docs/response and fix if wrong.
    const projects = items.map((p) => ({ uuid: p.uuid, title: p.title || p.name }));
    res.json({ projects });
  } catch (err) {
    console.error('[revizto] getProjects failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── ACC hub/project browser (for the "add project" dropdowns) ──────

router.get('/api/acc/hubs', requireLogin, async (req, res) => {
  try {
    const hubs = await accService.getHubs(req.session.userId);
    res.json({ hubs });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[acc] getHubs failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.developerMessage || err.message });
  }
});

router.get('/api/acc/hubs/:hubId/projects', requireLogin, async (req, res) => {
  try {
    const projects = await accService.getHubProjects(req.session.userId, req.params.hubId);
    res.json({ projects });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[acc] getHubProjects failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.developerMessage || err.message });
  }
});

router.get('/', (req, res) => {
  res.redirect('/issues');
});

router.get('/account', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/account.html'));
});

router.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/setup.html'));
});

router.get('/team', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/team.html'));
});

router.get('/issues', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/issues.html'));
});

// ─── Projects (Revizto project <-> ACC project pairing) ────────────

router.get('/api/projects', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
  res.json({ projects: rows });
});

router.post('/api/projects', requireAdmin, async (req, res) => {
  const { name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, acc_default_subtype_id, makeMeOwner } =
    req.body;
  if (!name || !revizto_project_uuid || !acc_hub_id || !acc_project_id) {
    return res.status(400).json({ error: 'name, revizto_project_uuid, acc_hub_id, acc_project_id are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO projects (name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, acc_default_subtype_id, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      name,
      revizto_project_uuid,
      revizto_region || 'virginia',
      acc_hub_id,
      acc_project_id,
      acc_default_subtype_id || null,
      makeMeOwner ? req.session.userId : null,
    ]
  );
  res.json({ project: rows[0] });
});

router.get('/api/projects/:id/issues-board', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const board = await syncService.getIssuesBoard(req.session.userId, project);
    res.json({ board });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[issues-board] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/projects/:id/linked-issues', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const pairs = await syncService.getLinkedIssuePairs(req.session.userId, project);
    res.json({ pairs });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/projects/:id/webhook-status', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.webhook_id) return res.status(404).json({ error: 'No webhook registered for this project yet' });
  try {
    const hook = await accService.getWebhookStatus(req.session.userId, project.webhook_id);
    res.json({ hook });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[webhook-status] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

// Actually tells ACC to start calling our /webhook/acc endpoint. Requires
// PUBLIC_BASE_URL to be a real internet-reachable HTTPS URL — this will
// fail (as it should) if run against localhost, since ACC's servers can't
// reach your laptop.
router.post('/api/projects/:id/register-webhook', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL.includes('localhost')) {
    return res.status(400).json({ error: 'PUBLIC_BASE_URL must be set to your real deployed URL — webhooks cannot reach localhost.' });
  }
  try {
    const callbackUrl = `${process.env.PUBLIC_BASE_URL}/webhook/acc`;
    const hook = await accService.registerWebhook(req.session.userId, project, callbackUrl);
    await pool.query('UPDATE projects SET webhook_id = $2 WHERE id = $1', [project.id, hook.hookId || hook.id || null]);
    res.json({ ok: true, hook });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[webhook] registration failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

// Open to any signed-in user — shows on the Issues page for everyone, and
// later the Analytics page. Not admin-gated, unlike mapping-warnings below.
router.get('/api/projects/:id/stats', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const stats = await syncService.getSyncStats(req.session.userId, project);
    res.json(stats);
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[stats] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin-only — this is a "go fix your mapping" action item, not a general stat.
router.get('/api/projects/:id/mapping-warnings', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const warnings = await fieldMapping.getUnmappedFields(req.session.userId, project);
    res.json(warnings);
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── Field mapping (status & issue type) — admin only ───────────────

router.get('/api/projects/:id/mapping-options', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const options = await fieldMapping.getMappingOptions(req.session.userId, project);
    res.json(options);
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/projects/:id/status-map', requireAdmin, async (req, res) => {
  const map = await fieldMapping.getStatusMap(req.params.id);
  res.json({ map });
});

router.post('/api/projects/:id/status-map', requireAdmin, async (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' });
  await fieldMapping.saveStatusMap(req.params.id, mappings);
  res.json({ ok: true });
});

router.get('/api/projects/:id/type-map', requireAdmin, async (req, res) => {
  const map = await fieldMapping.getTypeMap(req.params.id);
  res.json({ map });
});

router.post('/api/projects/:id/type-map', requireAdmin, async (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' });
  await fieldMapping.saveTypeMap(req.params.id, mappings);
  res.json({ ok: true });
});

// ─── Sync (on-demand) ────────────────────────────────────────────────

router.get('/api/projects/:id/revizto-issues', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const issues = await reviztoService.getIssues(req.session.userId, project.revizto_region, project.revizto_project_uuid);
    const list = issues.map((i) => ({
      id: i.id,
      title: i.title?.value ?? i.title ?? '(no title)',
      status: i.status?.value ?? i.status ?? '',
    }));
    res.json({ issues: list });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[revizto] listing issues for selection failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/projects/:id/sync', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { issueIds } = req.body;
  if (!Array.isArray(issueIds) || !issueIds.length) {
    return res.status(400).json({ error: 'issueIds required — select at least one issue to sync' });
  }

  try {
    const results = await syncService.pushSelectedIssues(req.session.userId, project, issueIds);
    res.json({ results });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[sync] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/projects/:id/subtypes', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const subtypes = await accService.getIssueSubtypes(req.session.userId, project);
    res.json({ subtypes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook receiver (ACC -> app) ───────────────────────────────────
// NOTE: verifying the webhook signature against WEBHOOK_SECRET is left
// as a TODO — Autodesk's exact signature scheme should be confirmed
// against current APS webhook docs before going live, rather than assumed.

router.post('/webhook/acc', express.json(), async (req, res) => {
  res.status(200).send('ok'); // ack immediately; ACC expects a fast response

  // Confirmed from a real webhook delivery: scope is nested under
  // hook.scope.project, not top-level hookScope.project as originally
  // guessed.
  const { rows: projects } = await pool.query('SELECT * FROM projects');
  const project = projects.find((p) => req.body?.hook?.scope?.project === p.acc_project_id.replace(/^b\./, ''));
  if (!project || !project.owner_user_id) {
    console.warn('[webhook] No matching project/owner for payload:', req.body?.hook?.scope);
    return;
  }

  try {
    await syncService.handleAccWebhook(project.owner_user_id, project, req.body.payload, req.session?.userEmail);
  } catch (err) {
    console.error('[webhook] Processing failed:', err.message);
  }
});

async function _getProject(id) {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = router;
