async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

window.addEventListener('app:ready', async (e) => {
  // nav.js already redirects non-admins away from this page — if we get
  // here, the user is an admin. Still guard against the brief moment
  // before that redirect fires.
  if (!e.detail.user || e.detail.user.role !== 'admin') return;
  document.getElementById('license-status').textContent = e.detail.revizto.licenseId || 'Not set';
  document.getElementById('license-status').className = 'badge ' + (e.detail.revizto.licenseId ? 'badge-success' : 'badge-neutral');
  if (e.detail.revizto.connected) await loadLicenseOptions(e.detail.revizto.licenseId);
  if (e.detail.revizto.connected && e.detail.revizto.licenseId) await loadReviztoProjectOptions();
  document.getElementById('revizto-region-hidden').value = e.detail.revizto.region || 'virginia';
  await loadProjects();
  await loadActiveProjectOptions();
});

// ─── Shared project selector (warnings + field mapping) ───────────

async function loadActiveProjectOptions() {
  const { projects } = await api('/api/projects');
  const select = document.getElementById('active-project-select');
  select.innerHTML = '<option value="">Select a project</option>' + projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

  const lastProjectId = localStorage.getItem('setup:lastProjectId');
  if (lastProjectId && projects.some((p) => String(p.id) === lastProjectId)) {
    select.value = lastProjectId;
    await onActiveProjectChange(lastProjectId);
  }
}

async function onActiveProjectChange(projectId) {
  const warningsEl = document.getElementById('setup-warnings');
  const mappingPanels = document.getElementById('mapping-panels');
  if (!projectId) {
    warningsEl.classList.add('hidden');
    mappingPanels.classList.add('hidden');
    return;
  }
  warningsEl.classList.remove('hidden');
  mappingPanels.classList.remove('hidden');
  await loadMappingWarnings(projectId);
  await loadFieldMapping(projectId);
}

document.getElementById('active-project-select').addEventListener('change', async (e) => {
  const projectId = e.target.value;
  if (projectId) localStorage.setItem('setup:lastProjectId', projectId);
  else localStorage.removeItem('setup:lastProjectId');
  await onActiveProjectChange(projectId);
});

async function loadMappingWarnings(projectId) {
  const warningsEl = document.getElementById('setup-warnings');
  warningsEl.textContent = 'Loading...';
  try {
    const { unmappedStatuses, unmappedStamps } = await api(`/api/projects/${projectId}/mapping-warnings`);
    const warnings = [];
    if (unmappedStatuses.length) {
      warnings.push(`⚠️ ${unmappedStatuses.length} status${unmappedStatuses.length === 1 ? '' : 'es'} in use but not mapped: ${unmappedStatuses.join(', ')}`);
    }
    if (unmappedStamps.length) {
      warnings.push(`⚠️ ${unmappedStamps.length} stamp${unmappedStamps.length === 1 ? '' : 's'} in use but not mapped: ${unmappedStamps.join(', ')}`);
    }
    warningsEl.innerHTML = warnings.length
      ? warnings.map((w) => `<div class="dashboard-warning">${w}</div>`).join('')
      : '<div class="hint">All in-use statuses and stamps are mapped.</div>';
  } catch (err) {
    warningsEl.textContent = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
  }
}

async function loadLicenseOptions(currentLicenseId) {
  const select = document.getElementById('license-select');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const { licenses } = await api('/api/revizto/licenses');
    if (!licenses.length) {
      select.innerHTML = '<option value="">No licenses found</option>';
      return;
    }
    select.innerHTML = licenses
      .map(
        (l) =>
          `<option value="${l.uuid}" ${String(l.uuid) === String(currentLicenseId) ? 'selected' : ''}>${l.name} (${l.region}${l.frozen ? ' — suspended' : ''})</option>`
      )
      .join('');
  } catch (err) {
    select.innerHTML = '<option value="">—</option>';
  }
}

document.getElementById('license-save-btn').addEventListener('click', async () => {
  const licenseId = document.getElementById('license-select').value;
  if (!licenseId) return;
  const statusEl = document.getElementById('license-status');
  try {
    await api('/auth/revizto/license', { method: 'POST', body: JSON.stringify({ licenseId }) });
    statusEl.textContent = licenseId;
    statusEl.className = 'badge badge-success';
    await loadReviztoProjectOptions();
  } catch (err) {
    alert(err.message);
  }
});

// ─── Field mapping ────────────────────────────────────────────────

let mappingOptions = null;

async function loadFieldMapping(projectId) {
  const statusRows = document.getElementById('status-map-rows');
  const typeRows = document.getElementById('type-map-rows');
  statusRows.textContent = 'Loading...';
  typeRows.textContent = 'Loading...';
  try {
    const [options, statusMapRes, typeMapRes] = await Promise.all([
      api(`/api/projects/${projectId}/mapping-options`),
      api(`/api/projects/${projectId}/status-map`),
      api(`/api/projects/${projectId}/type-map`),
    ]);
    mappingOptions = options;
    renderStatusMapRows(options, statusMapRes.map);
    renderTypeMapRows(options, typeMapRes.map);
  } catch (err) {
    const msg = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
    statusRows.textContent = msg;
    typeRows.textContent = msg;
  }
}

function prettyStatus(s) {
  const withSpaces = s.replace(/_/g, ' ');
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

function renderStatusMapRows(options, currentMap) {
  const container = document.getElementById('status-map-rows');
  if (!options.reviztoStatuses.length) {
    container.textContent = 'No Revizto statuses found for this project.';
    return;
  }
  container.innerHTML = options.reviztoStatuses
    .map(
      (s) => `<div class="mapping-row" data-revizto-status="${s}">
        <span>${s}</span>
        <span class="bridge-connector" aria-hidden="true">→</span>
        <select class="status-select">
          <option value="">— default —</option>
          ${options.accStatuses.map((a) => `<option value="${a}" ${currentMap[s] === a ? 'selected' : ''}>${prettyStatus(a)}</option>`).join('')}
        </select>
      </div>`
    )
    .join('');
}

document.getElementById('save-status-map-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('active-project-select').value;
  const resultEl = document.getElementById('status-map-result');
  const mappings = [...document.querySelectorAll('#status-map-rows .mapping-row')]
    .map((row) => ({ reviztoStatus: row.dataset.reviztoStatus, accStatus: row.querySelector('.status-select').value }))
    .filter((m) => m.accStatus);
  try {
    await api(`/api/projects/${projectId}/status-map`, { method: 'POST', body: JSON.stringify({ mappings }) });
    resultEl.textContent = 'Saved ✓';
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

function renderTypeMapRows(options, currentMap) {
  const container = document.getElementById('type-map-rows');
  const entries = Object.entries(currentMap);
  container.innerHTML = '';
  if (!entries.length) {
    addTypeMapRow('', '');
  } else {
    for (const [reviztoType, accSubtypeId] of entries) addTypeMapRow(reviztoType, accSubtypeId);
  }
}

function addTypeMapRow(reviztoType, accSubtypeId) {
  const container = document.getElementById('type-map-rows');
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.innerHTML = `
    <select class="type-select">
      <option value="">-Select Revizto Stamp-</option>
      ${(mappingOptions?.reviztoStamps || []).map((s) => `<option value="${s.value}" ${s.value === reviztoType ? 'selected' : ''}>${s.label}</option>`).join('')}
    </select>
    <span class="bridge-connector" aria-hidden="true">→</span>
    <select class="subtype-select">
      <option value="">-Select ACC Issue Type-</option>
      ${(mappingOptions?.accSubtypes || []).map((s) => `<option value="${s.id}" ${s.id === accSubtypeId ? 'selected' : ''}>${s.label}</option>`).join('')}
    </select>
    <button type="button" class="btn secondary remove-row-btn">Remove</button>
  `;
  row.querySelector('.remove-row-btn').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

document.getElementById('add-type-row-btn').addEventListener('click', () => addTypeMapRow('', ''));

document.getElementById('save-type-map-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('active-project-select').value;
  const resultEl = document.getElementById('type-map-result');
  const mappings = [...document.querySelectorAll('#type-map-rows .mapping-row')]
    .map((row) => ({
      reviztoType: row.querySelector('.type-select').value,
      accSubtypeId: row.querySelector('.subtype-select').value,
    }))
    .filter((m) => m.reviztoType && m.accSubtypeId);
  try {
    await api(`/api/projects/${projectId}/type-map`, { method: 'POST', body: JSON.stringify({ mappings }) });
    resultEl.textContent = 'Saved ✓';
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

async function loadReviztoProjectOptions() {
  const select = document.getElementById('revizto-project-select');
  const errorEl = document.getElementById('revizto-project-error');
  select.innerHTML = '<option value="">Loading...</option>';
  errorEl.textContent = '';
  try {
    const { projects } = await api('/api/revizto/projects');
    if (!projects.length) {
      select.innerHTML = '<option value="">No Revizto projects found</option>';
      return;
    }
    select.innerHTML = projects.map((p) => `<option value="${p.uuid}">${p.title} (${p.uuid})</option>`).join('');
  } catch (err) {
    select.innerHTML = '<option value="">—</option>';
    errorEl.textContent = err.data?.message || err.message || 'Connect Revizto on My Connections first.';
  }
}

document.getElementById('revizto-project-refresh').addEventListener('click', loadReviztoProjectOptions);

async function loadProjects() {
  const { projects } = await api('/api/projects');
  const list = document.getElementById('projects-list');
  list.innerHTML = '';
  if (!projects.length) {
    list.textContent = 'No projects paired yet.';
    return;
  }
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'project-row';
    row.innerHTML = `
      <strong>${p.name}</strong>
      <span>Revizto: ${p.revizto_project_uuid} (${p.revizto_region})</span>
      <span>ACC: ${p.acc_project_id}</span>
      <button data-id="${p.id}" class="btn secondary register-webhook-btn">Register ACC webhook</button>
      <span class="webhook-result" data-id="${p.id}"></span>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('.register-webhook-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const resultEl = document.querySelector(`.webhook-result[data-id="${id}"]`);
      resultEl.textContent = 'Registering...';
      try {
        await api(`/api/projects/${id}/register-webhook`, { method: 'POST' });
        resultEl.textContent = 'Webhook registered ✓';
      } catch (err) {
        resultEl.textContent = err.message;
      }
    });
  });
}

document.getElementById('project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = Object.fromEntries(form.entries());
  body.makeMeOwner = form.get('makeMeOwner') === 'on';
  try {
    await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    await loadProjects();
  } catch (err) {
    alert(err.message);
  }
});
