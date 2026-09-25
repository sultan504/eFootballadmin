// ==================================================================
// Admin panel logic
//
// Security notes
//  • Signing in is not enough: after login we ask the database
//    `is_admin()`. Accounts that aren't on the admin list are signed
//    straight back out. (The database enforces this again on every
//    request, so hiding buttons here is only a convenience.)
//  • Secret team codes are stored scrambled (bcrypt) — they can't be read.
//    "New code" issues a fresh one and shows it once.
//  • team_private has column-level permissions: always list its columns
//    explicitly (select('*') would be refused).
// ==================================================================

let adminTeams = [];      // teams + .priv (owner/phone/lock info)
let adminMatches = [];
let adminGroups = [];
let adminStandings = [];
let adminSubs = [];       // each player's own score claim
let auditRows = [];
let settings = null;

let teamsSearchQuery = '';
let approvalsSearchQuery = '';
let matchesSearchQuery = '';

let dashboardUser = null;  // guards against re-initialising on token refresh
let realtimeChannel = null;

const ADMIN_SECTIONS = ['adminTeams', 'adminGroups', 'adminBracket', 'adminApprovals', 'adminMatches', 'adminSettings'];
const $ = (id) => document.getElementById(id);

// Text shown on a match badge. NOTE: a played match says "Full-Time";
// the word "Final" is only ever the name of the championship round.
const STATUS_LABEL_ADMIN = {
  pending_teams:     { text: 'TBD',              cls: 'badge-eliminated' },
  awaiting_schedule: { text: 'Needs schedule',   cls: 'badge-pending' },
  scheduled:         { text: 'Scheduled',        cls: 'badge-live' },
  awaiting_opponent: { text: 'One score in',     cls: 'badge-pending' },
  pending_approval:  { text: 'Pending approval', cls: 'badge-pending' },
  approved:          { text: 'Full-Time',        cls: 'badge-approved' },
  disputed:          { text: 'Disputed',         cls: 'badge-disputed' }
};

// ---------------------------------------------------------------- boot
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initModals();
  initLoginForm();

  $('logoutBtn').addEventListener('click', () => sb.auth.signOut());
  $('settingsForm').addEventListener('submit', saveSettings);
  $('resetTournamentBtn').addEventListener('click', resetTournament);
  $('bracketAddForm').addEventListener('submit', addFixture);
  $('byeForm').addEventListener('submit', addBye);
  $('addGroupForm').addEventListener('submit', addGroup);
  $('startGroupStageBtn').addEventListener('click', startGroupStage);
  $('finalizeGroupsBtn').addEventListener('click', finalizeGroupStage);
  $('finalizeBtn').addEventListener('click', finalizeBracket);

  $('teamsSearch').addEventListener('input', (e) => { teamsSearchQuery = e.target.value.trim().toLowerCase(); renderTeamsAdmin(); });
  $('approvalsSearch').addEventListener('input', (e) => { approvalsSearchQuery = e.target.value.trim().toLowerCase(); renderApprovals(); });
  $('matchesSearch').addEventListener('input', (e) => { matchesSearchQuery = e.target.value.trim().toLowerCase(); renderMatchesAdmin(); });

  // one delegated listener per list instead of one per button
  $('approvalsList').addEventListener('click', onResultClick);
  $('approvalsList').addEventListener('input', onResultInput);
  $('resultModalBody').addEventListener('click', onResultClick);
  $('resultModalBody').addEventListener('input', onResultInput);

  if (PUBLIC_SITE_URL) {
    const a = $('viewSiteLink');
    a.href = PUBLIC_SITE_URL;
    a.hidden = false;
  }

  sb.auth.onAuthStateChange((_event, session) => { handleSession(session); });
  sb.auth.getSession().then(({ data: { session } }) => handleSession(session));
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------------------------------------------------------------- auth
async function handleSession(session) {
  if (!session) { dashboardUser = null; showLogin(); return; }
  if (dashboardUser === session.user.id) return;      // token refresh — nothing to do
  const { data: ok } = await sb.rpc('is_admin');
  if (ok !== true) {
    await sb.auth.signOut();
    showLogin('This account is not an admin of this tournament.');
    return;
  }
  dashboardUser = session.user.id;
  showDashboard();
}

function showLogin(errorText) {
  $('loginWrap').hidden = false;
  $('adminShell').hidden = true;
  if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
  if (errorText) {
    const msg = $('loginMsg');
    msg.className = 'msg show msg-err';
    msg.textContent = errorText;
  }
}

function showDashboard() {
  $('loginWrap').hidden = true;
  $('adminShell').hidden = false;
  const target = location.hash.slice(1);
  activateSection(ADMIN_SECTIONS.includes(target) ? target : 'adminTeams');
  loadAllAdmin();
  subscribeAdminRealtime();
}

function initLoginForm() {
  const form = $('loginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('loginMsg');
    msg.className = 'msg';
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; btn.innerHTML = '<span class="loader"></span> Signing in…';
    const { error } = await sb.auth.signInWithPassword({
      email: $('loginEmail').value.trim(),
      password: $('loginPassword').value
    });
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) {
      msg.classList.add('show', 'msg-err');
      msg.textContent = 'Sign-in failed — check your email and password.';
    } else {
      $('loginPassword').value = '';
    }
  });
}

// ---------------------------------------------------------------- navigation / modals
function initNav() {
  document.querySelectorAll('.admin-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateSection(btn.dataset.target);
      history.replaceState(null, '', '#' + btn.dataset.target);
    });
  });
  window.addEventListener('hashchange', () => {
    const target = location.hash.slice(1);
    if (ADMIN_SECTIONS.includes(target)) activateSection(target);
  });
}

function activateSection(target) {
  document.querySelectorAll('.admin-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.target === target));
  document.querySelectorAll('.admin-view').forEach((v) => v.classList.toggle('active', v.id === target));
  window.scrollTo({ top: 0 });
}

function initModals() {
  document.querySelectorAll('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('click', (e) => {
      if (e.target === bd || e.target.closest('[data-close-modal]')) bd.classList.remove('show');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop.show').forEach((m) => m.classList.remove('show'));
  });
  $('codeModalCopy').addEventListener('click', (e) => copyText($('codeModalValue').textContent, e.currentTarget));
}

// ---------------------------------------------------------------- loading
async function loadAllAdmin() {
  await Promise.all([loadTeamsAdmin(), loadMatchesAdmin(), loadSettingsAdmin(), loadGroupsAdmin(), loadSubmissions(), loadAudit()]);
  renderEverything();
}

function renderEverything() {
  updateApprovalsBadge();
  renderTeamsAdmin();
  renderGroupsAdmin();
  renderBracketBuilder();
  renderApprovals();
  renderMatchesAdmin();
  renderAudit();
}

function subscribeAdminRealtime() {
  if (realtimeChannel) return;
  const refresh = (loader, ...renders) => () => loader().then(() => renders.forEach((r) => r()));
  realtimeChannel = sb.channel('admin-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' },
      refresh(loadMatchesAdmin, updateApprovalsBadge, renderBracketBuilder, renderGroupsAdmin, renderApprovals, renderMatchesAdmin))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'match_submissions' },
      refresh(loadSubmissions, renderApprovals))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' },
      refresh(loadTeamsAdmin, renderTeamsAdmin, renderBracketBuilder, renderGroupsAdmin, renderMatchesAdmin))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'groups' },
      refresh(loadGroupsAdmin, renderGroupsAdmin, renderBracketBuilder))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_settings' },
      refresh(loadSettingsAdmin, renderGroupsAdmin, renderBracketBuilder, renderMatchesAdmin))
    .subscribe();
}

async function loadTeamsAdmin() {
  const [{ data: teams, error }, { data: priv }] = await Promise.all([
    sb.from('teams').select('*').order('created_at', { ascending: true }),
    sb.from('team_private').select('team_id, owner_name, phone, preferred_time, failed_attempts, locked_until')
  ]);
  if (error) return;
  const byId = {};
  (priv || []).forEach((p) => { byId[p.team_id] = p; });
  adminTeams = (teams || []).map((t) => ({ ...t, priv: byId[t.id] || {} }));
}

async function loadGroupsAdmin() {
  const [{ data: groups, error: gErr }, { data: standings, error: sErr }] = await Promise.all([
    sb.from('groups').select('*').order('name', { ascending: true }),
    sb.from('group_standings').select('*')
  ]);
  if (!gErr) adminGroups = groups || [];
  if (!sErr) adminStandings = standings || [];
}

async function loadMatchesAdmin() {
  const { data, error } = await sb
    .from('matches')
    .select('*, team1:team1_id(id,team_name,logo), team2:team2_id(id,team_name,logo)')
    .order('round', { ascending: true })
    .order('match_index', { ascending: true });
  if (!error) adminMatches = data || [];
}

async function loadSubmissions() {
  const { data, error } = await sb.from('match_submissions').select('*');
  if (!error) adminSubs = data || [];
}

async function loadAudit() {
  const { data, error } = await sb.from('audit_log').select('*').order('at', { ascending: false }).limit(40);
  if (!error) auditRows = data || [];
}

async function loadSettingsAdmin() {
  const { data, error } = await sb.from('tournament_settings').select('*').eq('id', 1).single();
  if (error || !data) return;
  settings = data;
  // don't overwrite what the admin is typing
  if (document.activeElement !== $('settingsName')) $('settingsName').value = data.tournament_name;
  if (document.activeElement !== $('settingsQualifiers')) $('settingsQualifiers').value = data.qualifiers_per_group ?? 2;
  if (document.activeElement !== $('settingsWindow')) $('settingsWindow').value = data.submission_open_minutes ?? 10;
  const statusEl = $('settingsStatus');
  const text = { registration: 'registration', group_stage: 'group stage', knockout: 'knockout', completed: 'completed' }[data.status] || data.status;
  statusEl.textContent = text;
  statusEl.className = 'badge ' + (
    data.status === 'knockout' ? 'badge-live' :
    data.status === 'completed' ? 'badge-champion' : 'badge-pending'
  );
}

// ---------------------------------------------------------------- helpers
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function crest(team, cls = 'crest-sm') {
  const key = team && /^logo-\d{2}$/.test(team.logo || '') ? team.logo : 'logo-01';
  return `<img class="crest ${cls}" src="logos/${key}.svg" alt="" width="22" height="22" loading="lazy">`;
}

function teamName(t) { return escapeHtml((t && t.team_name) || 'TBD'); }
function teamTag(t) { return t ? `<span class="team-tag">${crest(t)}<span>${teamName(t)}</span></span>` : '<span class="muted">TBD</span>'; }
const isGroupMatch = (m) => (m.phase || 'knockout') === 'group';
const roundLabel = (m) => (isGroupMatch(m) ? 'Group stage' : (m.round_name || 'Round ' + m.round));

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => {});
  else done();
}

function flash(el, ok, text) {
  el.className = 'msg show ' + (ok ? 'msg-ok' : 'msg-err');
  el.textContent = text;
}

// ---------------------------------------------------------------- teams
function isLocked(t) {
  return !!(t.priv && t.priv.locked_until) && new Date(t.priv.locked_until) > new Date();
}

function renderTeamsAdmin() {
  const wrap = $('teamsAdminTable');
  if (!adminTeams.length) { wrap.innerHTML = '<div class="empty-state">No teams have registered yet.</div>'; return; }
  const q = teamsSearchQuery;
  const list = !q ? adminTeams : adminTeams.filter((t) =>
    (t.team_name || '').toLowerCase().includes(q) ||
    (t.priv.owner_name || '').toLowerCase().includes(q) ||
    (t.priv.phone || '').toLowerCase().includes(q));
  if (!list.length) { wrap.innerHTML = `<div class="empty-state">No teams match "${escapeHtml(teamsSearchQuery)}".</div>`; return; }

  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Team</th><th>Owner</th><th>Phone</th><th>Preferred time</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map((t) => `
      <tr>
        <td><span class="team-tag">${crest(t, 'crest-md')}<span>${teamName(t)}</span></span></td>
        <td>${escapeHtml(t.priv.owner_name || '—')}</td>
        <td class="mono">${escapeHtml(t.priv.phone || '—')}</td>
        <td>${escapeHtml(t.priv.preferred_time || '—')}</td>
        <td>
          <span class="badge ${t.status === 'active' ? 'badge-live' : t.status === 'champion' ? 'badge-champion' : 'badge-eliminated'}">${escapeHtml(t.status)}</span>
          ${isLocked(t) ? '<span class="badge badge-disputed" style="margin-left:6px;" title="Too many wrong code attempts">🔒 Locked</span>' : ''}
        </td>
        <td><div class="pill-row">
          <button type="button" class="btn btn-sm" data-newcode="${t.id}">New code</button>
          ${isLocked(t) ? `<button type="button" class="btn btn-sm" data-unlock="${t.id}">Unlock</button>` : ''}
          ${t.status !== 'withdrawn'
            ? `<button type="button" class="btn btn-sm btn-danger" data-withdraw="${t.id}">Withdraw</button>`
            : `<button type="button" class="btn btn-sm" data-reactivate="${t.id}">Reactivate</button>`}
          <button type="button" class="btn btn-sm btn-danger" data-delete-team="${t.id}">Delete</button>
        </div></td>
      </tr>`).join('')}
    </tbody></table></div>`;

  const on = (sel, fn) => wrap.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
  on('[data-newcode]', (b) => issueNewCode(b.dataset.newcode));
  on('[data-unlock]', (b) => unlockTeam(b.dataset.unlock));
  on('[data-withdraw]', (b) => {
    if (confirm("Withdraw this team? They'll be marked as out but stay on record.")) setTeamStatus(b.dataset.withdraw, 'withdrawn');
  });
  on('[data-reactivate]', (b) => setTeamStatus(b.dataset.reactivate, 'active'));
  on('[data-delete-team]', (b) => deleteTeam(b.dataset.deleteTeam));
}

async function issueNewCode(id) {
  const t = adminTeams.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`Issue a NEW code for "${t.team_name}"? Their old code stops working immediately.`)) return;
  const { data, error } = await sb.rpc('admin_reset_team_code', { p_team_id: id });
  if (error || !data || !data.ok) { alert((error && error.message) || 'Could not issue a new code.'); return; }
  $('codeModalTeam').textContent = t.team_name;
  $('codeModalValue').textContent = data.code;
  $('codeModal').classList.add('show');
  loadTeamsAdmin().then(renderTeamsAdmin);
}

async function unlockTeam(id) {
  const { error } = await sb.from('team_private').update({ failed_attempts: 0, locked_until: null }).eq('team_id', id);
  if (error) { alert(error.message); return; }
  loadTeamsAdmin().then(renderTeamsAdmin);
}

async function setTeamStatus(id, status) {
  const { error } = await sb.from('teams').update({ status }).eq('id', id);
  if (error) { alert(error.message); return; }
  loadTeamsAdmin().then(renderTeamsAdmin);
}

async function deleteTeam(id) {
  const t = adminTeams.find((x) => x.id === id);
  const name = t ? t.team_name : 'this team';
  if (adminMatches.some((m) => m.team1_id === id || m.team2_id === id)) {
    alert(`"${name}" already has a fixture, so it can't be deleted (that would break match history). Withdraw it instead.`);
    return;
  }
  if (!confirm(`Permanently delete "${name}"? This can't be undone.`)) return;
  const { data, error } = await sb.from('teams').delete().eq('id', id).select();
  if (error) { alert(error.message); return; }
  if (!data || !data.length) { alert('Nothing was deleted — is your account on the admin list? (see SETUP_GUIDE.md)'); return; }
  loadTeamsAdmin().then(() => { renderTeamsAdmin(); renderGroupsAdmin(); renderBracketBuilder(); });
}

// ---------------------------------------------------------------- groups
function renderGroupsAdmin() {
  const isRegistration = settings && settings.status === 'registration';
  const isGroupStage = settings && settings.status === 'group_stage';

  $('groupsAdminBody').hidden = !(isRegistration || isGroupStage);
  $('groupsUnavailableNote').hidden = !!(isRegistration || isGroupStage);
  $('groupsLockedNote').hidden = !isGroupStage;
  $('addGroupForm').hidden = !isRegistration;

  renderGroupsList(isRegistration);
  renderGroupsStandingsAdmin();

  const unassigned = adminTeams.filter((t) => t.status === 'active' && !t.group_id).length;
  $('startGroupWrap').hidden = !isRegistration;
  $('startGroupStageBtn').disabled = !(isRegistration && adminGroups.length > 0 && adminTeams.some((t) => t.status === 'active') && unassigned === 0);

  const groupMatches = adminMatches.filter(isGroupMatch);
  const unapproved = groupMatches.filter((m) => m.status !== 'approved').length;
  $('finalizeGroupWrap').hidden = !isGroupStage;
  $('finalizeGroupsBtn').disabled = !(isGroupStage && groupMatches.length > 0 && unapproved === 0);
}

function renderGroupsList(editable) {
  const wrap = $('groupsList');
  if (!adminGroups.length) { wrap.innerHTML = '<div class="empty-state">No groups yet — add one above.</div>'; return; }
  const free = adminTeams.filter((t) => t.status === 'active' && !t.group_id);
  wrap.innerHTML = adminGroups.map((g) => {
    const inGroup = adminTeams.filter((t) => t.group_id === g.id);
    return `<div class="glass glass-pad" style="margin-bottom:14px;">
      <div class="pill-row" style="justify-content:space-between; margin-bottom:10px;">
        <h3 style="margin:0;">${escapeHtml(g.name)}</h3>
        ${editable ? `<button type="button" class="btn btn-sm btn-danger" data-del-group="${g.id}">Delete</button>` : ''}
      </div>
      ${inGroup.length ? `<div class="pill-row" style="margin-bottom:${editable ? '12px' : '0'};">
        ${inGroup.map((t) => `<span class="badge badge-live">${crest(t)} ${teamName(t)}
          ${editable ? `<button type="button" class="chip-x" data-unassign="${t.id}" aria-label="Remove from group">&times;</button>` : ''}</span>`).join('')}
      </div>` : `<div class="hint" style="margin-bottom:${editable ? '12px' : '0'};">No teams assigned yet.</div>`}
      ${editable && free.length ? `<div class="field" style="margin-bottom:0;">
        <select data-assign-into="${g.id}" aria-label="Add a team to ${escapeHtml(g.name)}">
          <option value="">Add a team…</option>
          ${free.map((t) => `<option value="${t.id}">${teamName(t)}</option>`).join('')}
        </select></div>` : ''}
    </div>`;
  }).join('');

  if (editable) {
    wrap.querySelectorAll('[data-del-group]').forEach((b) => b.addEventListener('click', () => deleteGroup(b.dataset.delGroup)));
    wrap.querySelectorAll('[data-unassign]').forEach((b) => b.addEventListener('click', () => assignTeamToGroup(b.dataset.unassign, null)));
    wrap.querySelectorAll('[data-assign-into]').forEach((s) => s.addEventListener('change', (e) => {
      if (e.target.value) assignTeamToGroup(e.target.value, e.target.dataset.assignInto);
    }));
  }
}

function renderGroupsStandingsAdmin() {
  const wrap = $('groupsStandingsAdmin');
  if (!adminGroups.length) { wrap.innerHTML = '<div class="empty-state">No groups yet.</div>'; return; }
  const qualifiers = (settings && settings.qualifiers_per_group) || 2;
  wrap.innerHTML = `<div class="groups-grid">${adminGroups.map((g) => {
    const rows = adminStandings.filter((r) => r.group_id === g.id).sort((a, b) => a.position - b.position);
    if (!rows.length) return `<div class="glass group-card"><h3>${escapeHtml(g.name)}</h3><div class="group-hint">No teams assigned.</div></div>`;
    return `<div class="glass group-card">
      <h3>${escapeHtml(g.name)}</h3>
      <div class="table-wrap" style="box-shadow:none; padding:0;">
        <table class="standings-table">
          <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr class="${r.position <= qualifiers ? 'qualified' : ''}">
              <td><span class="pos-cell">${r.position}</span></td>
              <td><span class="team-tag">${crest(r)}<span>${escapeHtml(r.team_name)}</span></span></td>
              <td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
              <td>${r.goal_diff > 0 ? '+' : ''}${r.goal_diff}</td>
              <td class="pts">${r.points}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }).join('')}</div>`;
}

async function addGroup(e) {
  e.preventDefault();
  const input = $('newGroupName');
  const msg = $('addGroupMsg');
  msg.className = 'msg';
  const name = input.value.trim();
  if (!name) { flash(msg, false, 'Enter a group name.'); return; }
  const { error } = await sb.from('groups').insert({ name });
  if (error) { flash(msg, false, error.message.includes('duplicate') ? 'A group with that name already exists.' : error.message); return; }
  input.value = '';
  loadGroupsAdmin().then(renderGroupsAdmin);
}

async function deleteGroup(id) {
  if (adminTeams.some((t) => t.group_id === id)) { alert('Remove every team from this group before deleting it.'); return; }
  if (!confirm('Delete this group?')) return;
  const { error } = await sb.from('groups').delete().eq('id', id);
  if (error) { alert(error.message); return; }
  loadGroupsAdmin().then(() => { renderGroupsAdmin(); renderBracketBuilder(); });
}

async function assignTeamToGroup(teamId, groupId) {
  const { error } = await sb.from('teams').update({ group_id: groupId }).eq('id', teamId);
  if (error) { alert(error.message); return; }
  await loadTeamsAdmin();
  renderGroupsAdmin();
  renderTeamsAdmin();
}

async function runStage(rpcName, btnId, msgId, idleHtml, busyText, okText) {
  const msg = $(msgId);
  const btn = $(btnId);
  msg.className = 'msg';
  btn.disabled = true; btn.innerHTML = `<span class="loader"></span> ${busyText}`;
  const { error } = await sb.rpc(rpcName);
  btn.innerHTML = idleHtml;
  if (error) { flash(msg, false, error.message); btn.disabled = false; return; }
  flash(msg, true, okText);
  loadAllAdmin();
}

function startGroupStage() {
  runStage('start_group_stage', 'startGroupStageBtn', 'startGroupStageMsg', 'Start group stage', 'Starting…', 'Group stage started — fixtures are ready for scheduling.');
}

function finalizeGroupStage() {
  if (!confirm("Finalize the group stage and open the knockout bracket? Every team that didn't qualify is eliminated.")) return;
  runStage('finalize_group_stage', 'finalizeGroupsBtn', 'finalizeGroupsMsg', 'Finalize &amp; start knockouts', 'Finalizing…', 'Knockout stage is live.');
}

// ---------------------------------------------------------------- bracket builder
const round1Matches = () => adminMatches
  .filter((m) => m.round === 1 && !isGroupMatch(m))
  .sort((a, b) => a.match_index - b.match_index);

function renderBracketBuilder() {
  const round1 = round1Matches();
  const used = new Set();
  round1.forEach((m) => { if (m.team1_id) used.add(m.team1_id); if (m.team2_id) used.add(m.team2_id); });
  const available = adminTeams.filter((t) => t.status === 'active' && !used.has(t.id));
  const opts = available.map((t) => `<option value="${t.id}">${teamName(t)}</option>`).join('');
  $('fixtureTeam1').innerHTML = `<option value="">Team A…</option>${opts}`;
  $('fixtureTeam2').innerHTML = `<option value="">Team B…</option>${opts}`;
  $('byeTeam').innerHTML = `<option value="">Select team…</option>${opts}`;

  const isRegistration = !!settings && settings.status === 'registration';
  const usingGroups = adminGroups.length > 0;
  const list = $('round1List');
  if (!round1.length) {
    list.innerHTML = '<div class="empty-state">No Round 1 fixtures created yet.</div>';
  } else {
    list.innerHTML = round1.map((m) => {
      const st = STATUS_LABEL_ADMIN[m.status] || {};
      return `<div class="list-item">
        <div>${teamTag(m.team1)} ${m.is_bye ? '<span class="hint">(bye)</span>' : 'vs ' + teamTag(m.team2)}</div>
        <div class="pill-row">
          <span class="badge ${st.cls || ''}">${st.text || escapeHtml(m.status)}</span>
          ${isRegistration ? `<button type="button" class="btn btn-sm btn-danger" data-del-match="${m.id}">Remove</button>` : ''}
        </div></div>`;
    }).join('');
    list.querySelectorAll('[data-del-match]').forEach((b) => b.addEventListener('click', () => deleteMatch(b.dataset.delMatch)));
  }

  $('bracketSkipGroupsNote').hidden = !usingGroups;
  $('bracketLockedNote').hidden = isRegistration || !settings;
  $('bracketForms').hidden = usingGroups || !isRegistration;
  $('finalizeBtn').disabled = !(isRegistration && round1.length > 0 && !usingGroups);
}

async function addFixture(e) {
  e.preventDefault();
  const t1 = $('fixtureTeam1').value;
  const t2 = $('fixtureTeam2').value;
  const msg = $('bracketMsg');
  msg.className = 'msg';
  if (!t1 || !t2 || t1 === t2) { flash(msg, false, 'Pick two different teams.'); return; }
  const { error } = await sb.from('matches').insert({
    phase: 'knockout', round: 1, match_index: round1Matches().length,
    team1_id: t1, team2_id: t2, status: 'awaiting_schedule'
  });
  if (error) { flash(msg, false, error.message); return; }
  flash(msg, true, 'Fixture added.');
  $('bracketAddForm').reset();
  loadMatchesAdmin().then(renderBracketBuilder);
}

async function addBye(e) {
  e.preventDefault();
  const t1 = $('byeTeam').value;
  const msg = $('byeMsg');
  msg.className = 'msg';
  if (!t1) { flash(msg, false, 'Select a team.'); return; }
  const { error } = await sb.from('matches').insert({
    phase: 'knockout', round: 1, match_index: round1Matches().length,
    team1_id: t1, is_bye: true, status: 'awaiting_schedule'
  });
  if (error) { flash(msg, false, error.message); return; }
  flash(msg, true, 'Bye added — confirm it under "Fixtures" once the bracket is locked.');
  $('byeForm').reset();
  loadMatchesAdmin().then(renderBracketBuilder);
}

async function deleteMatch(id) {
  if (!confirm('Remove this fixture?')) return;
  const { data, error } = await sb.from('matches').delete().eq('id', id).select();
  if (error) { alert(error.message); return; }
  if (!data || !data.length) { alert('Nothing was removed — is your account on the admin list? (see SETUP_GUIDE.md)'); return; }
  loadMatchesAdmin().then(() => { renderBracketBuilder(); renderMatchesAdmin(); });
}

async function finalizeBracket() {
  if (!confirm('Lock the bracket and start the knockout stage? Fixtures can no longer be added or removed.')) return;
  runStage('finalize_bracket', 'finalizeBtn', 'finalizeMsg', 'Finalize bracket &amp; start tournament', 'Locking…', 'Bracket locked — the knockout stage is live.');
}

// ---------------------------------------------------------------- results: approve / edit
// One form is used in three places (Approvals list, "Enter result" and
// "Edit result" on the Fixtures list). It reads/writes through data-f
// attributes, so the same match can be on screen twice without id clashes.

function claimsFor(m) {
  return adminSubs.filter((s) => s.match_id === m.id);
}

function claimLine(m, s) {
  const who = s.team_id === m.team1_id ? m.team1 : m.team2;
  const pens = s.team1_penalties != null ? ` <span class="hint">(pens ${s.team1_penalties}–${s.team2_penalties})</span>` : '';
  return `<div class="claim"><span class="team-tag">${crest(who)}<span>${teamName(who)}</span></span> says <strong class="mono">${s.team1_score} – ${s.team2_score}</strong>${pens}</div>`;
}

function claimsHtml(m) {
  const subs = claimsFor(m);
  const missing = [m.team1, m.team2].filter((t) => t && !subs.some((s) => s.team_id === t.id));
  return `<div class="claims">
    ${subs.map((s) => claimLine(m, s)).join('')}
    ${missing.map((t) => `<div class="claim muted">${teamName(t)} hasn't submitted yet</div>`).join('')}
  </div>`;
}

// Starting values for the form: the official score if there is one, otherwise
// the players' score when both (or the only one) agree.
function prefill(m, mode) {
  if (mode === 'edit' || m.team1_score != null) {
    return { s1: m.team1_score, s2: m.team2_score, p1: m.team1_penalties, p2: m.team2_penalties };
  }
  const subs = claimsFor(m);
  if (subs.length && subs.every((s) => s.team1_score === subs[0].team1_score && s.team2_score === subs[0].team2_score
      && s.team1_penalties === subs[0].team1_penalties && s.team2_penalties === subs[0].team2_penalties)) {
    const s = subs[0];
    return { s1: s.team1_score, s2: s.team2_score, p1: s.team1_penalties, p2: s.team2_penalties };
  }
  return { s1: null, s2: null, p1: null, p2: null };
}

function resultFormHtml(m, mode) {
  const v = prefill(m, mode);
  const knockout = !isGroupMatch(m);
  const level = v.s1 != null && v.s2 != null && v.s1 === v.s2;
  const val = (x) => (x == null ? '' : x);
  const n1 = teamName(m.team1), n2 = teamName(m.team2);
  return `<div class="result-form" data-match-id="${m.id}" data-mode="${mode}" data-knockout="${knockout ? 1 : 0}">
    <div class="field-row">
      <div class="field"><label>${n1}</label><input type="number" inputmode="numeric" min="0" max="99" data-f="s1" value="${val(v.s1)}"></div>
      <div class="field"><label>${n2}</label><input type="number" inputmode="numeric" min="0" max="99" data-f="s2" value="${val(v.s2)}"></div>
    </div>
    ${knockout ? `<div class="pen-wrap" ${level ? '' : 'hidden'}>
      <div class="hint" style="margin:0 0 8px;">Level score — enter the penalty shoot-out.</div>
      <div class="field-row">
        <div class="field"><label>${n1} penalties</label><input type="number" inputmode="numeric" min="0" max="99" data-f="p1" value="${val(v.p1)}"></div>
        <div class="field"><label>${n2} penalties</label><input type="number" inputmode="numeric" min="0" max="99" data-f="p2" value="${val(v.p2)}"></div>
      </div></div>` : ''}
    <div class="pill-row">
      ${mode === 'edit'
        ? '<button type="button" class="btn btn-primary btn-sm" data-save-edit>Save correction</button>'
        : `<button type="button" class="btn btn-primary btn-sm" data-approve>Approve${knockout ? ' &amp; advance' : ''}</button>
           ${m.status !== 'disputed' ? '<button type="button" class="btn btn-danger btn-sm" data-dispute>Mark disputed</button>' : ''}`}
    </div>
    <div class="msg" data-msg></div>
  </div>`;
}

function readForm(form) {
  const num = (k) => {
    const el = form.querySelector(`[data-f="${k}"]`);
    if (!el || el.value === '') return null;
    const n = parseInt(el.value, 10);
    return Number.isInteger(n) && n >= 0 && n <= 99 ? n : NaN;
  };
  return { s1: num('s1'), s2: num('s2'), p1: num('p1'), p2: num('p2') };
}

function onResultInput(e) {
  const form = e.target.closest('.result-form');
  if (!form || form.dataset.knockout !== '1') return;
  const { s1, s2 } = readForm(form);
  const wrap = form.querySelector('.pen-wrap');
  if (wrap) wrap.hidden = !(s1 != null && s2 != null && s1 === s2);
}

function onResultClick(e) {
  const btn = e.target.closest('[data-approve], [data-dispute], [data-save-edit]');
  if (!btn) return;
  const form = btn.closest('.result-form');
  if (!form) return;
  const id = form.dataset.matchId;
  if (btn.hasAttribute('data-approve')) submitResult(form, id, 'approve_match', btn);
  else if (btn.hasAttribute('data-save-edit')) submitResult(form, id, 'edit_match_result', btn);
  else disputeMatch(id);
}

async function submitResult(form, id, rpcName, btn) {
  const msg = form.querySelector('[data-msg]');
  msg.className = 'msg';
  const { s1, s2, p1, p2 } = readForm(form);
  if (s1 == null || s2 == null || Number.isNaN(s1) || Number.isNaN(s2) || Number.isNaN(p1) || Number.isNaN(p2)) {
    flash(msg, false, 'Enter both scores (0–99).'); return;
  }
  const level = s1 === s2 && form.dataset.knockout === '1';
  if (level && (p1 == null || p2 == null || p1 === p2)) {
    flash(msg, false, 'Level knockout score — enter a penalty result (it cannot be a tie).'); return;
  }
  if (rpcName === 'edit_match_result' &&
      !confirm('Save this correction? If it changes the winner, the bracket is updated automatically (only possible while the winner\'s next match has not been played).')) return;

  btn.disabled = true;
  const { error } = await sb.rpc(rpcName, {
    p_match_id: id, p_score1: s1, p_score2: s2,
    p_pen1: level ? p1 : null, p_pen2: level ? p2 : null
  });
  btn.disabled = false;
  if (error) { flash(msg, false, error.message); return; }
  $('resultModal').classList.remove('show');
  loadAllAdmin();
}

async function disputeMatch(id) {
  const { error } = await sb.from('matches').update({ status: 'disputed' }).eq('id', id);
  if (error) { alert(error.message); return; }
  loadMatchesAdmin().then(() => { updateApprovalsBadge(); renderApprovals(); renderMatchesAdmin(); });
}

function openResultModal(id, mode) {
  const m = adminMatches.find((x) => x.id === id);
  if (!m) return;
  $('resultModalBody').innerHTML = `
    <h3>${mode === 'edit' ? 'Correct the result' : 'Enter the result'}</h3>
    <div style="margin-bottom:6px;">${teamTag(m.team1)} <span class="muted">vs</span> ${teamTag(m.team2)}</div>
    <div class="hint mono" style="margin:0 0 12px;">${escapeHtml(roundLabel(m))}</div>
    ${claimsHtml(m)}
    ${mode === 'edit' ? '<p class="hint" style="margin:10px 0;">Fixing a mistake? Save and everything downstream (bracket, standings, champion) updates automatically.</p>' : ''}
    ${resultFormHtml(m, mode)}`;
  $('resultModal').classList.add('show');
}

// ---------------------------------------------------------------- approvals
const APPROVAL_STATES = ['disputed', 'pending_approval', 'awaiting_opponent'];

function updateApprovalsBadge() {
  const count = adminMatches.filter((m) => m.status === 'pending_approval' || m.status === 'disputed').length;
  const badge = $('approvalsNavBadge');
  badge.textContent = count > 0 ? count : '';
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function matchesQuery(m, q) {
  return (m.team1 && m.team1.team_name || '').toLowerCase().includes(q) ||
         (m.team2 && m.team2.team_name || '').toLowerCase().includes(q);
}

function renderApprovals() {
  const list = $('approvalsList');
  // don't wipe a score the admin is in the middle of typing
  if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  let pending = adminMatches
    .filter((m) => APPROVAL_STATES.includes(m.status) && !m.is_bye)
    .sort((a, b) => APPROVAL_STATES.indexOf(a.status) - APPROVAL_STATES.indexOf(b.status));
  if (approvalsSearchQuery) pending = pending.filter((m) => matchesQuery(m, approvalsSearchQuery));
  if (!pending.length) {
    list.innerHTML = `<div class="empty-state">${approvalsSearchQuery ? `No matches for "${escapeHtml(approvalsSearchQuery)}".` : 'Nothing waiting on you right now.'}</div>`;
    return;
  }
  list.innerHTML = pending.map((m) => {
    const st = STATUS_LABEL_ADMIN[m.status];
    return `<div class="glass glass-pad" style="margin-bottom:14px;">
      <div class="pill-row" style="margin-bottom:10px;">
        <span class="badge ${st.cls}">${st.text}</span>
        <span class="hint">${escapeHtml(roundLabel(m))}${m.scheduled_time ? ' · ' + escapeHtml(fmtDateTime(m.scheduled_time)) : ''}</span>
      </div>
      <div style="margin-bottom:8px;">${teamTag(m.team1)} <span class="muted">vs</span> ${teamTag(m.team2)}</div>
      ${claimsHtml(m)}
      ${resultFormHtml(m, 'approve')}
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------- fixtures list
function renderMatchesAdmin() {
  const wrap = $('matchesAdminList');
  if (wrap.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  if (!adminMatches.length) { wrap.innerHTML = '<div class="empty-state">No fixtures yet — build Round 1 or start the group stage first.</div>'; return; }
  let matches = adminMatches;
  if (matchesSearchQuery) matches = matches.filter((m) => matchesQuery(m, matchesSearchQuery));
  if (!matches.length) { wrap.innerHTML = `<div class="empty-state">No fixtures match "${escapeHtml(matchesSearchQuery)}".</div>`; return; }

  const rounds = {};
  matches.forEach((m) => { (rounds[isGroupMatch(m) ? 'group' : 'k' + m.round] = rounds[isGroupMatch(m) ? 'group' : 'k' + m.round] || []).push(m); });
  const keys = Object.keys(rounds).sort((a, b) => {
    if (a === 'group') return -1;
    if (b === 'group') return 1;
    return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
  });

  wrap.innerHTML = keys.map((key) => `
    <h3 style="margin-top:28px;">${escapeHtml(roundLabel(rounds[key][0]))}</h3>
    ${rounds[key].sort((a, b) => a.match_index - b.match_index).map((m) => {
      const st = STATUS_LABEL_ADMIN[m.status] || {};
      const ready = !m.is_bye && m.team1_id && m.team2_id;
      const done = m.status === 'approved';
      return `<div class="glass list-item">
        <div>
          <div style="font-weight:600;">${teamTag(m.team1)} ${m.is_bye ? '<span class="hint">(bye)</span>' : 'vs ' + teamTag(m.team2)}</div>
          <div class="pill-row" style="margin-top:6px;">
            <span class="badge ${st.cls || ''}">${st.text || escapeHtml(m.status)}</span>
            ${m.scheduled_time ? `<span class="hint mono">${escapeHtml(fmtDateTime(m.scheduled_time))}</span>` : ''}
            ${done && ready ? `<span class="hint mono">${m.team1_score} – ${m.team2_score}${m.team1_penalties != null ? ` (pens ${m.team1_penalties}–${m.team2_penalties})` : ''}</span>` : ''}
            ${done && m.approved_at ? `<span class="hint">Approved ${escapeHtml(fmtDateTime(m.approved_at))}</span>` : ''}
          </div>
        </div>
        <div class="pill-row">
          ${m.is_bye && !done ? `<button type="button" class="btn btn-sm btn-primary" data-confirm-bye="${m.id}">Confirm bye</button>` : ''}
          ${ready && !done ? `
            <input type="datetime-local" data-sched-input="${m.id}" value="${toLocalInput(m.scheduled_time)}" style="width:auto;" aria-label="Kick-off time">
            <button type="button" class="btn btn-sm" data-schedule="${m.id}">${m.scheduled_time ? 'Change time' : 'Set time'}</button>
            <button type="button" class="btn btn-sm" data-enter="${m.id}">Enter result</button>` : ''}
          ${ready && done ? `<button type="button" class="btn btn-sm" data-edit="${m.id}">Edit result</button>` : ''}
        </div>
      </div>`;
    }).join('')}`).join('');

  const on = (sel, fn) => wrap.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
  on('[data-schedule]', (b) => setSchedule(b.dataset.schedule));
  on('[data-confirm-bye]', (b) => confirmBye(b.dataset.confirmBye));
  on('[data-enter]', (b) => openResultModal(b.dataset.enter, 'approve'));
  on('[data-edit]', (b) => openResultModal(b.dataset.edit, 'edit'));
}

async function setSchedule(id) {
  const input = document.querySelector(`[data-sched-input="${id}"]`);
  if (!input || !input.value) { alert('Pick a date and time first.'); return; }
  const m = adminMatches.find((x) => x.id === id);
  const patch = { scheduled_time: new Date(input.value).toISOString() };
  // only a fixture that was waiting for a time becomes "scheduled" —
  // changing the time of one already in progress must not reset its status
  if (m && m.status === 'awaiting_schedule') patch.status = 'scheduled';
  const { error } = await sb.from('matches').update(patch).eq('id', id);
  if (error) { alert(error.message); return; }
  loadMatchesAdmin().then(renderMatchesAdmin);
}

async function confirmBye(id) {
  const { error } = await sb.rpc('approve_match', { p_match_id: id });
  if (error) alert(error.message);
  loadAllAdmin();
}

// ---------------------------------------------------------------- settings
async function saveSettings(e) {
  e.preventDefault();
  const msg = $('settingsMsg');
  msg.className = 'msg';
  const name = $('settingsName').value.trim();
  const qualifiers = parseInt($('settingsQualifiers').value, 10);
  const windowMin = parseInt($('settingsWindow').value, 10);
  if (!name || !(qualifiers >= 1 && qualifiers <= 8) || !(windowMin >= 0 && windowMin <= 180)) {
    flash(msg, false, 'Check the values: qualifiers 1–8, score-entry window 0–180 minutes.'); return;
  }
  const { error } = await sb.from('tournament_settings')
    .update({ tournament_name: name, qualifiers_per_group: qualifiers, submission_open_minutes: windowMin })
    .eq('id', 1);
  if (error) { flash(msg, false, error.message); return; }
  flash(msg, true, 'Saved.');
}

// ---------------------------------------------------------------- audit trail
const AUDIT_TEXT = {
  approve: 'Approved a result', edit_result: 'Corrected an approved result',
  reset_team_code: 'Issued a new team code', start_group_stage: 'Started the group stage',
  finalize_group_stage: 'Finalized the group stage', finalize_bracket: 'Locked the bracket',
  reset_tournament: 'Reset the tournament'
};

function renderAudit() {
  const box = $('auditList');
  if (!auditRows.length) { box.innerHTML = '<div class="hint" style="margin:0;">Nothing yet.</div>'; return; }
  box.innerHTML = auditRows.map((r) => {
    const m = r.match_id && adminMatches.find((x) => x.id === r.match_id);
    const who = m ? ` — ${teamName(m.team1)} vs ${teamName(m.team2)}` : '';
    let score = '';
    const d = r.details || {};
    if (r.action === 'approve' && d.score) score = ` (${d.score[0]}–${d.score[1]})`;
    if (r.action === 'edit_result' && d.old && d.new) score = ` (${d.old.score[0]}–${d.old.score[1]} → ${d.new.score[0]}–${d.new.score[1]})`;
    return `<div class="audit-row"><span>${escapeHtml(AUDIT_TEXT[r.action] || r.action)}${who}${score}</span><span class="hint mono">${escapeHtml(fmtDateTime(r.at))}</span></div>`;
  }).join('');
}

// ---------------------------------------------------------------- danger zone
async function resetTournament() {
  const msg = $('resetMsg');
  msg.className = 'msg';
  const typed = prompt('This wipes EVERYTHING: every team, every match, every score — and puts the tournament back to "registration". This cannot be undone.\n\nType RESET to confirm.');
  if (typed !== 'RESET') return;
  const btn = $('resetTournamentBtn');
  btn.disabled = true; btn.innerHTML = '<span class="loader"></span> Resetting…';
  const { error } = await sb.rpc('reset_tournament');
  btn.disabled = false; btn.textContent = 'Reset tournament';
  if (error) { flash(msg, false, error.message || 'Reset failed.'); return; }
  flash(msg, true, 'Tournament reset. Registration is open again with no teams.');
  loadAllAdmin();
}
