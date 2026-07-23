/**
 * services/accService.js
 * ACC Construction Issues API calls. Same endpoints as the old
 * accService.js, but every function now takes (userId, project) so the
 * right person's token and the right project's IDs are used — this is
 * what makes multi-user and multi-project work.
 */
const axios = require('axios');
const { getValidAccToken } = require('./authManager');
const { APS_BASE } = require('./accAuth');

function _containerId(project) {
  return project.acc_project_id.startsWith('b.') ? project.acc_project_id.slice(2) : project.acc_project_id;
}

async function _client(userId, project) {
  const token = await getValidAccToken(userId);
  return {
    token,
    baseURL: `${APS_BASE}/construction/issues/v1/projects/${_containerId(project)}`,
  };
}

async function getIssues(userId, project, filters = {}) {
  const { token, baseURL } = await _client(userId, project);
  const issues = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { data } = await axios.get(`${baseURL}/issues`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit, offset, ...filters },
    });
    issues.push(...(data.results || []));
    if (issues.length >= (data.pagination?.totalResults || 0)) break;
    offset += limit;
  }
  return issues;
}

async function getIssue(userId, project, issueId) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.get(`${baseURL}/issues/${issueId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

async function createIssue(userId, project, issueBody) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.post(`${baseURL}/issues`, issueBody, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return data;
}

async function updateIssue(userId, project, issueId, fields) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.patch(`${baseURL}/issues/${issueId}`, fields, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return data;
}

async function addComment(userId, project, issueId, comment) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.post(
    `${baseURL}/issues/${issueId}/comments`,
    { body: comment },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data;
}

async function getIssueSubtypes(userId, project) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.get(`${baseURL}/issue-types`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { include: 'subtypes' },
  });
  return (data.results || []).flatMap((t) =>
    (t.subtypes || []).map((s) => ({ id: s.id, title: s.title, issueTypeId: t.id, issueTypeTitle: t.title }))
  );
}

// ─── Project members / assignee mapping ────────────────────────────

async function getProjectMembers(userId, project) {
  const token = await getValidAccToken(userId);
  const projectId = _containerId(project);
  const members = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { data } = await axios.get(`${APS_BASE}/construction/admin/v1/projects/${projectId}/users`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit, offset },
    });
    const results = data.results || [];
    members.push(...results);
    if (members.length >= (data.pagination?.totalResults || 0)) break;
    offset += limit;
  }
  return members;
}

// ─── Webhooks ───────────────────────────────────────────────────────

async function registerWebhook(userId, project, callbackUrl) {
  const token = await getValidAccToken(userId);
  const projectId = _containerId(project);
  const { data } = await axios.post(
    `${APS_BASE}/webhooks/v1/systems/autodesk.construction.issues/events/issue.updated-1.0/hooks`,
    { callbackUrl, scope: { project: projectId } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-region': 'US' } }
  );
  return data;
}

/**
 * Fetches the real, current status of a registered webhook straight from
 * ACC — for diagnosing "it fired once, then stopped" without guessing.
 * Returns whatever Autodesk's own API says (status, dates, etc.).
 */
async function getWebhookStatus(userId, hookId) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(
    `${APS_BASE}/webhooks/v1/systems/autodesk.construction.issues/events/issue.updated-1.0/hooks/${hookId}`,
    { headers: { Authorization: `Bearer ${token}`, 'x-ads-region': 'US' } }
  );
  return data;
}

/**
 * Lists all currently registered hooks for this event (across all
 * projects the token can see), for finding an existing hook whose ID
 * never got saved locally — e.g. if the create-response's ID field name
 * assumption was wrong. Returns the raw list; caller filters by scope.
 */
async function listWebhooks(userId) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(
    `${APS_BASE}/webhooks/v1/systems/autodesk.construction.issues/events/issue.updated-1.0/hooks`,
    { headers: { Authorization: `Bearer ${token}`, 'x-ads-region': 'US' } }
  );
  return data?.data || data?.hooks || data || [];
}

// ─── Hubs / Projects (Data Management API — for the "browse ACC" dropdowns) ─

async function getHubs(userId) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(`${APS_BASE}/project/v1/hubs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (data.data || []).map((h) => ({ id: h.id, name: h.attributes?.name }));
}

async function getHubProjects(userId, hubId) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(`${APS_BASE}/project/v1/hubs/${hubId}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (data.data || []).map((p) => ({ id: p.id, name: p.attributes?.name }));
}

module.exports = {
  getIssues,
  getIssue,
  createIssue,
  updateIssue,
  addComment,
  getIssueSubtypes,
  getProjectMembers,
  registerWebhook,
  getWebhookStatus,
  listWebhooks,
  getHubs,
  getHubProjects,
};
