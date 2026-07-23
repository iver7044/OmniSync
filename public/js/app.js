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

async function refreshMe() {
  const { user, acc, revizto } = await api('/auth/me');
  if (!user) {
    document.getElementById('connections-section').classList.add('hidden');
    document.getElementById('projects-section').classList.add('hidden');
    return;
  }
  document.getElementById('whoami').textContent = `Signed in as ${user.email}`;
  document.getElementById('connections-section').classList.remove('hidden');
  document.getElementById('projects-section').classList.remove('hidden');

  document.getElementById('acc-status').textContent = acc.connected ? `Connected (expires ${new Date(acc.expiresAt).toLocaleString()})` : 'Not connected';
  document.getElementById('acc-connect-btn').textContent = acc.connected ? 'Reconnect ACC' : 'Connect ACC';

  document.getElementById('revizto-status').textContent = revizto.connected
    ? `Connected (reconnect by ${new Date(revizto.refreshExpiresAt).toLocaleDateString()})`
    : 'Not connected';

  document.getElementById('license-status').textContent = revizto.licenseId ? revizto.licenseId : 'Not set';
  document.getElementById('revizto-region-hidden').value = revizto.region || 'virginia';

  await loadProjects();
  if (revizto.connected) await loadLicenseOptions(revizto.licenseId);
  if (revizto.connected && revizto.licenseId) await loadReviztoProjectOptions();
  // ACC hub/project dropdown loading is disabled in the UI for now (manual
  // entry only) until the ACC Custom Integration is approved — see README.
  // accService.getHubs/getHubProjects and their routes are still in place
  // for when it's ready to re-enable.
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
          `<option value="${l.uuid}" data-region="${l.region}" ${String(l.uuid) === String(currentLicenseId) ? 'selected' : ''}>${l.name} (${l.region}${l.frozen ? ' — suspended' : ''})</option>`
      )
      .join('');
  } catch (err) {
    select.innerHTML = '<option value="">—</option>';
  }
}

document.getElementById('license-save-btn').addEventListener('click', async () => {
  const licenseId = document.getElementById('license-select').value;
  if (!licenseId) return;
  try {
    await api('/auth/revizto/license', { method: 'POST', body: JSON.stringify({ licenseId }) });
    await refreshMe();
  } catch (err) {
    alert(err.message);
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
    errorEl.textContent = err.data?.message || err.message;
  }
}

document.getElementById('revizto-project-refresh').addEventListener('click', loadReviztoProjectOptions);

// ACC hub/project browsing (loadAccHubOptions, the hub/project <select>
// change handlers) is intentionally removed from the UI for now — manual
// ID entry only, until the ACC Custom Integration is approved. The
// backend routes (/api/acc/hubs, /api/acc/hubs/:id/projects) are still
// there; re-add the dropdown markup + these handlers when ready.

document.getElementById('identify-btn').addEventListener('click', async () => {
  const email = document.getElementById('email-input').value.trim();
  if (!email) return;
  await api('/auth/identify', { method: 'POST', body: JSON.stringify({ email }) });
  await refreshMe();
});

document.getElementById('revizto-connect-btn').addEventListener('click', () => {
  window.open('https://ws.revizto.com/login?request=accessCode', '_blank');
  document.getElementById('revizto-code-panel').classList.remove('hidden');
});

document.getElementById('revizto-submit-btn').addEventListener('click', async () => {
  const accessCode = document.getElementById('revizto-code-input').value.trim();
  const region = document.getElementById('revizto-region-input').value.trim() || 'virginia';
  const resultEl = document.getElementById('revizto-exchange-result');
  if (!accessCode) return;
  try {
    await api('/auth/revizto/exchange', { method: 'POST', body: JSON.stringify({ accessCode, region }) });
    resultEl.textContent = 'Connected ✓';
    await refreshMe();
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

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
      <button data-id="${p.id}" class="btn load-issues-btn">Link new issues</button>
      <button data-id="${p.id}" class="btn secondary load-linked-btn">Show linked issues</button>
      <button data-id="${p.id}" class="btn secondary register-webhook-btn">Register ACC webhook</button>
      <span class="webhook-result" data-id="${p.id}"></span>
    `;
    list.appendChild(row);
    const issuesPanel = document.createElement('div');
    issuesPanel.className = 'issues-panel hidden';
    issuesPanel.dataset.id = p.id;
    list.appendChild(issuesPanel);
    const linkedPanel = document.createElement('div');
    linkedPanel.className = 'linked-panel hidden';
    linkedPanel.dataset.id = p.id;
    list.appendChild(linkedPanel);
  }
  list.querySelectorAll('.load-issues-btn').forEach((btn) => {
    btn.addEventListener('click', () => loadIssuesForProject(btn.dataset.id));
  });
  list.querySelectorAll('.load-linked-btn').forEach((btn) => {
    btn.addEventListener('click', () => loadLinkedIssues(btn.dataset.id));
  });
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

async function loadLinkedIssues(projectId) {
  const panel = document.querySelector(`.linked-panel[data-id="${projectId}"]`);
  panel.classList.remove('hidden');
  panel.innerHTML = 'Loading linked issues...';
  try {
    const { pairs } = await api(`/api/projects/${projectId}/linked-issues`);
    if (!pairs.length) {
      panel.innerHTML = 'No linked issues yet — use "Link new issues" first.';
      return;
    }
    panel.innerHTML =
      '<div class="linked-header"><span>Revizto</span><span>ACC</span></div>' +
      pairs
        .map(
          (p) => `<div class="linked-row">
            <span>#${p.reviztoIssueId} — ${p.revizto?.title ?? p.revizto?.error} <em>(${p.revizto?.status ?? '?'})</em></span>
            <span>#${p.accIssueId} — ${p.acc?.title ?? p.acc?.error} <em>(${p.acc?.status ?? '?'})</em></span>
          </div>`
        )
        .join('');
  } catch (err) {
    panel.innerHTML = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
  }
}

async function loadIssuesForProject(projectId) {
  const panel = document.querySelector(`.issues-panel[data-id="${projectId}"]`);
  panel.classList.remove('hidden');
  panel.innerHTML = 'Loading Revizto issues...';
  try {
    const [{ issues }, { pairs }] = await Promise.all([
      api(`/api/projects/${projectId}/revizto-issues`),
      api(`/api/projects/${projectId}/linked-issues`).catch(() => ({ pairs: [] })),
    ]);
    if (!issues.length) {
      panel.innerHTML = 'No open Revizto issues found.';
      return;
    }
    const linkedIds = new Set(pairs.map((p) => String(p.reviztoIssueId)));
    panel.innerHTML =
      issues
        .map((i) => {
          const isLinked = linkedIds.has(String(i.id));
          return `<label class="issue-row">
            <input type="checkbox" value="${i.id}" ${isLinked ? 'disabled' : ''} />
            #${i.id} — ${i.title} <em>(${i.status})</em> ${isLinked ? '<strong>(already linked)</strong>' : ''}
          </label>`;
        })
        .join('') +
      `<button class="btn link-selected-btn">Link &amp; push selected</button><div class="sync-result"></div>`;
    panel.querySelector('.link-selected-btn').addEventListener('click', async () => {
      const issueIds = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
      const resultEl = panel.querySelector('.sync-result');
      if (!issueIds.length) {
        resultEl.textContent = 'Select at least one issue first.';
        return;
      }
      resultEl.textContent = 'Linking & pushing...';
      try {
        const { results } = await api(`/api/projects/${projectId}/sync`, {
          method: 'POST',
          body: JSON.stringify({ issueIds }),
        });
        const errors = results.filter((r) => r.action === 'error');
        resultEl.innerHTML = errors.length
          ? `${results.length} processed, ${errors.length} errors:<br>` + errors.map((e) => `#${e.reviztoId}: ${e.error}`).join('<br>')
          : `${results.length} linked and pushed. They'll now auto-resync every 2 minutes — check "Show linked issues".`;
      } catch (err) {
        resultEl.textContent = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
      }
    });
  } catch (err) {
    panel.innerHTML = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
  }
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

refreshMe();
