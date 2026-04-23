// Claude Settings Manager — frontend

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  context: null,
  files: [],
  rules: [],
  mcp: [],
};

// ---------- Utilities ----------

function api(path, opts = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

function shortPath(p) {
  if (!state.context) return p;
  return p.startsWith(state.context.home) ? '~' + p.slice(state.context.home.length) : p;
}

function scopeClass(scope) {
  return scope === 'user' ? 'pill-user' : scope === 'local' ? 'pill-local' : 'pill-project';
}

function scopeLabel(f) {
  if (f.scope === 'user') return 'user';
  if (f.scope === 'local') return 'local';
  return 'project';
}

// ---------- Tabs ----------

function setupTabs() {
  $$('.tab').forEach(btn => btn.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const name = btn.dataset.tab;
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    $('#tab-' + name).classList.add('active');
    if (name === 'files') loadFiles();
    if (name === 'permissions') loadPermissions();
    if (name === 'mcp') loadMcp();
  }));
}

// ---------- Files tab ----------

async function loadFiles() {
  try {
    const { files } = await api('/api/files');
    state.files = files;
    renderFiles();
  } catch (e) { toast(e.message, 'bad'); }
}

function renderFiles() {
  const tbody = $('#files-table tbody');
  tbody.innerHTML = '';
  for (const f of state.files) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.dataset.path = f.path;
    const counts = f.counts || {};
    tr.innerHTML = `
      <td><span class="pill ${scopeClass(f.scope)}">${scopeLabel(f)}</span></td>
      <td>${f.kind}</td>
      <td class="mono" title="${f.path}">${shortPath(f.path)}</td>
      <td>${counts.allow ?? '-'}</td>
      <td>${counts.deny ?? '-'}</td>
      <td>${counts.ask ?? '-'}</td>
      <td class="muted small">${fmtBytes(f.size)}</td>
      <td class="muted small">${fmtDate(f.mtime)}</td>
    `;
    tr.addEventListener('click', () => openViewer(f.path));
    tbody.appendChild(tr);
  }
  const users = state.files.filter(f => f.scope === 'user').length;
  const projs = state.files.filter(f => f.scope === 'project').length;
  const locs = state.files.filter(f => f.scope === 'local').length;
  $('#files-summary').textContent = `${state.files.length} files  •  user: ${users}  •  project: ${projs}  •  local: ${locs}`;
}

const viewer = {
  path: null,
  editing: false,
  originalText: '',
};

async function openViewer(path) {
  try {
    const data = await api('/api/file?path=' + encodeURIComponent(path));
    viewer.path = path;
    viewer.editing = false;
    const text = data.ok ? JSON.stringify(data.data, null, 2) : `// ERROR parsing file:\n// ${data.error}`;
    viewer.originalText = text;
    $('#viewer-path').textContent = shortPath(path);
    $('#viewer-editor').value = text;
    $('#viewer-editor').readOnly = true;
    $('#viewer-editor').classList.remove('invalid');
    $('#viewer-mode').textContent = data.redacted ? 'read-only · redacted' : 'read-only';
    $('#viewer-warning').classList.add('hidden');
    $('#edit-file').classList.toggle('hidden', !data.ok);
    $('#save-file').classList.add('hidden');
    $('#cancel-edit').classList.add('hidden');
    $('#viewer-status').textContent = '';
    $('#file-viewer').classList.remove('hidden');
    $('#file-viewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { toast(e.message, 'bad'); }
}

async function enterEditMode() {
  if (!viewer.path) return;
  try {
    const data = await api('/api/file?path=' + encodeURIComponent(viewer.path) + '&raw=true');
    if (!data.ok) return toast(`Cannot edit — parse error: ${data.error}`, 'bad');
    const text = JSON.stringify(data.data, null, 2);
    viewer.editing = true;
    viewer.originalText = text;
    $('#viewer-editor').value = text;
    $('#viewer-editor').readOnly = false;
    $('#viewer-editor').focus();
    $('#viewer-mode').textContent = 'editing (raw)';
    $('#viewer-warning').classList.remove('hidden');
    $('#edit-file').classList.add('hidden');
    $('#save-file').classList.remove('hidden');
    $('#cancel-edit').classList.remove('hidden');
    validateEditor();
  } catch (e) { toast(e.message, 'bad'); }
}

function exitEditMode() {
  viewer.editing = false;
  $('#viewer-editor').value = viewer.originalText;
  $('#viewer-editor').readOnly = true;
  $('#viewer-editor').classList.remove('invalid');
  $('#viewer-mode').textContent = 'read-only';
  $('#viewer-warning').classList.add('hidden');
  $('#edit-file').classList.remove('hidden');
  $('#save-file').classList.add('hidden');
  $('#cancel-edit').classList.add('hidden');
  $('#viewer-status').textContent = '';
  // Re-fetch redacted view so secrets leave the DOM once editing ends.
  if (viewer.path) openViewer(viewer.path);
}

function validateEditor() {
  const txt = $('#viewer-editor').value;
  try {
    JSON.parse(txt);
    $('#viewer-editor').classList.remove('invalid');
    $('#save-file').disabled = false;
    $('#viewer-status').textContent = txt === viewer.originalText ? 'no changes' : 'valid JSON · unsaved';
    $('#viewer-status').style.color = '';
    return true;
  } catch (e) {
    $('#viewer-editor').classList.add('invalid');
    $('#save-file').disabled = true;
    $('#viewer-status').textContent = `invalid JSON: ${e.message}`;
    $('#viewer-status').style.color = 'var(--bad)';
    return false;
  }
}

async function saveEditor() {
  if (!viewer.path || !viewer.editing) return;
  if (!validateEditor()) return;
  const content = $('#viewer-editor').value;
  if (content === viewer.originalText) { toast('No changes to save', ''); return; }
  try {
    const res = await api('/api/file/save', {
      method: 'POST',
      body: JSON.stringify({ filePath: viewer.path, content }),
    });
    toast(`Saved. Backup: ${res.backup ? shortPath(res.backup) : 'none'}`, 'good');
    await loadFiles();
    exitEditMode();
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------- Permissions tab ----------

async function loadPermissions() {
  try {
    const { rules } = await api('/api/permissions');
    state.rules = rules;
    renderPermissions();
  } catch (e) { toast(e.message, 'bad'); }
}

function isDuplicate(rule) {
  const total = rule.allow.length + rule.deny.length + rule.ask.length;
  return total > 1;
}

function renderPermissions() {
  const tbody = $('#perms-table tbody');
  const filterText = $('#perms-filter').value.trim().toLowerCase();
  const onlyDupes = $('#only-duplicates').checked;

  tbody.innerHTML = '';
  let shown = 0;
  let dupes = 0;

  const sorted = [...state.rules].sort((a, b) => {
    const da = isDuplicate(a) ? 1 : 0;
    const db = isDuplicate(b) ? 1 : 0;
    if (db !== da) return db - da;
    return a.rule.localeCompare(b.rule);
  });

  for (const r of sorted) {
    const dup = isDuplicate(r);
    if (dup) dupes++;
    if (onlyDupes && !dup) continue;
    if (filterText && !r.rule.toLowerCase().includes(filterText)) continue;
    shown++;

    const bucketBadges = [];
    if (r.allow.length) bucketBadges.push(`<span class="badge allow">allow × ${r.allow.length}</span>`);
    if (r.deny.length)  bucketBadges.push(`<span class="badge deny">deny × ${r.deny.length}</span>`);
    if (r.ask.length)   bucketBadges.push(`<span class="badge ask">ask × ${r.ask.length}</span>`);

    const allOccs = [...r.allow.map(o => ({ ...o, bucket: 'allow' })),
                     ...r.deny.map(o => ({ ...o, bucket: 'deny' })),
                     ...r.ask.map(o => ({ ...o, bucket: 'ask' }))];

    const sourceHtml = allOccs.map(o =>
      `<div><span class="pill ${scopeClass(o.scope)}">${o.scope}</span> <span class="badge ${o.bucket}">${o.bucket}</span> <code>${shortPath(o.path)}</code></div>`
    ).join('');

    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.innerHTML = `
      <td class="rule-cell"><code>${escapeHtml(r.rule)}</code>${dup ? ' <span class="badge dup">DUP</span>' : ''}</td>
      <td>${bucketBadges.join(' ')}</td>
      <td>${sourceHtml}</td>
      <td></td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      toggleRuleActions(tr, r);
    });
    tbody.appendChild(tr);
  }
  $('#perms-summary').textContent = `${state.rules.length} unique rules  •  ${dupes} with duplicates  •  ${shown} shown`;
}

function toggleRuleActions(tr, r) {
  const existing = tr.nextElementSibling;
  if (existing && existing.classList.contains('actions-row')) {
    existing.remove();
    tr.classList.remove('expanded');
    return;
  }
  tr.classList.add('expanded');
  const actions = document.createElement('tr');
  actions.className = 'actions-row';
  const td = document.createElement('td');
  td.colSpan = 4;
  td.innerHTML = `
    <div class="inline-actions">
      <button data-act="promote">Promote to global (user) …</button>
      <button data-act="promote-custom">Move to…</button>
      <button data-act="remove-all" class="danger">Remove from all</button>
    </div>
  `;
  actions.appendChild(td);
  tr.after(actions);

  td.querySelector('[data-act="promote"]').addEventListener('click', () => promoteToGlobal(r));
  td.querySelector('[data-act="promote-custom"]').addEventListener('click', () => openPromoteDialog(r));
  td.querySelector('[data-act="remove-all"]').addEventListener('click', () => removeFromAll(r));
}

async function promoteToGlobal(r) {
  // Choose the dominant bucket (allow > deny > ask), and move to user settings.
  const bucket = r.allow.length ? 'allow' : r.deny.length ? 'deny' : 'ask';
  const globalFile = state.files.find(f => f.scope === 'user' && f.kind === 'settings');
  if (!globalFile) return toast('No global settings file found', 'bad');
  const sources = [...r.allow, ...r.deny, ...r.ask].map(o => o.path);
  try {
    await api('/api/rule/promote', {
      method: 'POST',
      body: JSON.stringify({ from: sources, to: globalFile.path, bucket, rule: r.rule }),
    });
    toast(`Promoted to global (${bucket}): ${r.rule}`, 'good');
    await Promise.all([loadPermissions(), loadFiles()]);
  } catch (e) { toast(e.message, 'bad'); }
}

async function removeFromAll(r) {
  if (!confirm(`Remove rule from all files?\n\n${r.rule}`)) return;
  const tasks = [];
  for (const bucket of ['allow', 'deny', 'ask']) {
    for (const o of r[bucket]) {
      tasks.push(api('/api/rule/remove', {
        method: 'POST',
        body: JSON.stringify({ filePath: o.path, bucket, rule: r.rule }),
      }));
    }
  }
  try {
    await Promise.all(tasks);
    toast('Removed from all files', 'good');
    await Promise.all([loadPermissions(), loadFiles()]);
  } catch (e) { toast(e.message, 'bad'); }
}

function openPromoteDialog(r) {
  const dialog = $('#promote-dialog');
  $('#promote-rule').textContent = r.rule;
  const bucketSel = $('#promote-bucket');
  bucketSel.value = r.allow.length ? 'allow' : r.deny.length ? 'deny' : 'ask';

  const targetSel = $('#promote-target');
  targetSel.innerHTML = '';
  state.files
    .filter(f => f.kind === 'settings')
    .forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = `[${f.scope}] ${shortPath(f.path)}`;
      targetSel.appendChild(opt);
    });

  const sourcesDiv = $('#promote-sources');
  sourcesDiv.innerHTML = '';
  const allSources = [...r.allow, ...r.deny, ...r.ask];
  const seen = new Set();
  allSources.forEach(o => {
    if (seen.has(o.path)) return;
    seen.add(o.path);
    const id = 'src-' + btoa(o.path).replace(/=/g, '');
    const row = document.createElement('label');
    row.innerHTML = `<input type="checkbox" id="${id}" checked data-path="${o.path}"> <span class="pill ${scopeClass(o.scope)}">${o.scope}</span> <code>${shortPath(o.path)}</code>`;
    sourcesDiv.appendChild(row);
  });

  dialog._rule = r;
  dialog.showModal();
}

$('#promote-confirm').addEventListener('click', async (e) => {
  const dialog = $('#promote-dialog');
  const r = dialog._rule;
  if (!r) return;
  const to = $('#promote-target').value;
  const bucket = $('#promote-bucket').value;
  const from = Array.from(dialog.querySelectorAll('#promote-sources input[type=checkbox]'))
    .filter(cb => cb.checked).map(cb => cb.dataset.path);
  try {
    await api('/api/rule/promote', {
      method: 'POST',
      body: JSON.stringify({ from, to, bucket, rule: r.rule }),
    });
    toast('Rule moved', 'good');
    await Promise.all([loadPermissions(), loadFiles()]);
  } catch (err) { toast(err.message, 'bad'); e.preventDefault(); }
});

// ---------- MCP tab ----------

async function loadMcp() {
  try {
    const { servers } = await api('/api/mcp');
    state.mcp = servers;
    renderMcp();
  } catch (e) { toast(e.message, 'bad'); }
}

function renderMcp() {
  const tbody = $('#mcp-table tbody');
  tbody.innerHTML = '';
  const grouped = new Map();
  for (const s of state.mcp) {
    if (!grouped.has(s.name)) grouped.set(s.name, []);
    grouped.get(s.name).push(s);
  }
  for (const [name, entries] of grouped) {
    for (const s of entries) {
      const tr = document.createElement('tr');
      const status = s.mode ? `<span class="badge ${s.mode === 'enabled' ? 'allow' : 'deny'}">${s.mode}</span>` : '';
      const cfg = s.config ? `<code>${escapeHtml(JSON.stringify(s.config).slice(0, 180))}</code>` : '';
      tr.innerHTML = `
        <td><strong>${escapeHtml(name)}</strong></td>
        <td><span class="pill ${scopeClass(s.scope)}">${s.scope}</span></td>
        <td class="mono" title="${s.source}">${shortPath(s.source)}</td>
        <td>${status} ${cfg}</td>
      `;
      tbody.appendChild(tr);
    }
  }
  const unique = grouped.size;
  $('#mcp-summary').textContent = `${state.mcp.length} entries  •  ${unique} distinct servers`;
}

// ---------- Misc ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadContext() {
  try {
    state.context = await api('/api/context');
    $('#context').textContent = `scanning ${state.context.scanRoots.join(', ')} · node ${state.context.nodeVersion}`;
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------- Boot ----------

$('#refresh-files').addEventListener('click', loadFiles);
$('#refresh-perms').addEventListener('click', loadPermissions);
$('#refresh-mcp').addEventListener('click', loadMcp);
$('#close-viewer').addEventListener('click', () => {
  if (viewer.editing && $('#viewer-editor').value !== viewer.originalText) {
    if (!confirm('You have unsaved changes. Discard and close?')) return;
  }
  $('#file-viewer').classList.add('hidden');
  viewer.path = null;
  viewer.editing = false;
});
$('#edit-file').addEventListener('click', enterEditMode);
$('#save-file').addEventListener('click', saveEditor);
$('#cancel-edit').addEventListener('click', () => {
  if ($('#viewer-editor').value !== viewer.originalText && !confirm('Discard unsaved changes?')) return;
  exitEditMode();
});
$('#viewer-editor').addEventListener('input', validateEditor);
$('#viewer-editor').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveEditor(); }
});
$('#perms-filter').addEventListener('input', renderPermissions);
$('#only-duplicates').addEventListener('change', renderPermissions);

setupTabs();
loadContext().then(loadFiles);
