'use strict';

const $app = document.getElementById('app');
const STATUS = { present: 'Present', late: 'Late', absent: 'Absent' };
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let me = null; // response of GET /api/me
let leaveGuard = null; // returns true when the current page has unsaved work
let currentHash = '';

// ---------- helpers ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login' && me) {
    me = null;
    leaveGuard = null;
    renderLogin('Your session has ended. Please sign in again.');
    throw new Error('Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || 'Could not reach the server. Please try again.');
  return data;
}

function toast(message, isError) {
  const el = document.createElement('div');
  el.textContent = message;
  if (isError) el.className = 'err';
  document.getElementById('toast').append(el);
  setTimeout(() => el.remove(), isError ? 6000 : 2800);
}

function fmtTime(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function fmtDate(date, opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function pill(status) {
  return `<span class="pill ${esc(status)}">${esc(STATUS[status] || 'Not marked')}</span>`;
}

function options(list, selected, blank) {
  const opts = list.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`);
  return (blank !== undefined ? [`<option value="">${esc(blank)}</option>`] : []).concat(opts).join('');
}

function telHref(phone) {
  return `tel:${phone.replace(/[^0-9+]/g, '')}`;
}

function loading(el) {
  el.innerHTML = '<div class="empty">Loading…</div>';
}

function pageError(el, e) {
  el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
}

function downloadCsv(filename, rows) {
  // A leading apostrophe stops spreadsheets running a name like =SUM(...) as a formula.
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Opens a form in a dialog. onSubmit receives the form values; throw to show an error.
function formDialog({ title, body, submit = 'Save', danger, onSubmit }) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" novalidate>
    <h2>${esc(title)}</h2>
    <div>${body}</div>
    <p class="error" hidden></p>
    <div class="btns">
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(submit)}</button>
    </div>
  </form>`;
  document.body.append(d);
  const form = d.querySelector('form');
  const err = d.querySelector('.error');
  const close = () => { d.close(); d.remove(); };
  d.querySelector('[data-close]').onclick = close;
  d.addEventListener('cancel', () => d.remove());
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    err.hidden = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), form);
      close();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };
  d.showModal();
  return d;
}

// ---------- sign in ----------

function renderLogin(message) {
  $app.innerHTML = `<div class="login"><form class="login-card">
    <img src="logo.webp" alt="Prairie Muslim Association logo">
    <h1>PMA Attendance</h1>
    <p class="sub">Sign in to mark or review attendance</p>
    <p class="error" ${message ? '' : 'hidden'}>${esc(message || '')}</p>
    <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" autocapitalize="none" required></label>
    <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn primary">Sign in</button>
  </form></div>`;
  const form = $app.querySelector('form');
  form.username.focus();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button');
    const err = form.querySelector('.error');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await api('POST', 'login', { username: form.username.value, password: form.password.value });
      await start();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  };
}

// ---------- shell and routing ----------

const ROUTES = {
  dashboard: { label: 'Dashboard', admin: true, view: viewDashboard },
  mark: { label: 'Mark attendance', view: viewMark },
  students: { label: 'Students', admin: true, view: viewStudents },
  teachers: { label: 'Teachers', admin: true, view: viewTeachers },
  reports: { label: 'Reports', admin: true, view: viewReports },
  settings: { label: 'Settings', admin: true, view: viewSettings },
  account: { label: 'My account', view: viewAccount },
};

const isAdmin = () => me.user.role === 'admin';

function renderShell() {
  $app.innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand"><img src="logo.webp" alt=""><div><b>PMA Attendance</b><small>${isAdmin() ? 'Admin panel' : 'Teacher'}</small></div></div>
      <nav class="nav" aria-label="Main"></nav>
      <div class="who"><b>${esc(me.user.name)}</b><button type="button" id="logout">Sign out</button></div>
    </aside>
    <main id="page"></main>
  </div>`;
  $app.querySelector('nav').innerHTML = Object.entries(ROUTES)
    .filter(([, r]) => !r.admin || isAdmin())
    .map(([key, r]) => `<a href="#/${key}" data-route="${key}">${esc(r.label)}</a>`)
    .join('');
  document.getElementById('logout').onclick = async () => {
    if (leaveGuard?.() && !confirm('You have unsaved attendance. Sign out anyway?')) return;
    leaveGuard = null;
    await api('POST', 'logout', {});
    me = null;
    location.hash = '';
    renderLogin();
  };
}

function route() {
  if (!me) return;
  if (leaveGuard?.() && location.hash !== currentHash) {
    if (!confirm('You have unsaved attendance. Leave this page without saving?')) {
      history.replaceState(null, '', currentHash);
      return;
    }
  }
  leaveGuard = null;
  let key = location.hash.replace('#/', '');
  if (!ROUTES[key] || (ROUTES[key].admin && !isAdmin())) {
    key = isAdmin() ? 'dashboard' : 'mark';
    history.replaceState(null, '', `#/${key}`);
  }
  currentHash = location.hash;
  $app.querySelectorAll('.nav a').forEach((a) => {
    const on = a.dataset.route === key;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const page = document.getElementById('page');
  loading(page);
  window.scrollTo(0, 0);
  ROUTES[key].view(page).catch((e) => pageError(page, e));
}

async function start() {
  me = await api('GET', 'me');
  renderShell();
  route();
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (leaveGuard?.()) e.preventDefault();
});

// ---------- mark attendance ----------

async function viewMark(page, date) {
  me = await api('GET', 'me');
  const data = await api('GET', `attendance${date ? `?date=${encodeURIComponent(date)}` : ''}`);
  const today = me.clock.date;
  const work = {};
  for (const s of data.students) {
    const r = data.records[s.id];
    work[s.id] = { status: r?.status ?? null, remark: r?.remark ?? '' };
  }
  const saved = JSON.parse(JSON.stringify(work));
  const filter = { q: '', cls: '', teacher: '' };
  const canEdit = !data.block;

  const changedIds = () => data.students.map((s) => s.id).filter((id) => work[id].status !== saved[id].status || work[id].remark.trim() !== saved[id].remark);
  leaveGuard = () => changedIds().length > 0;

  const classes = [...new Set(data.students.map((s) => s.className).filter(Boolean))].sort();
  const schedule = `${me.settings.days.map((d) => DAY_SHORT[d]).join(', ')} from ${fmtTime(me.settings.startTime)}`;

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Mark attendance</h1><p>${esc(fmtDate(data.date))}${data.date === today ? ' · Today' : ''} · Class: ${esc(schedule)}</p></div>
      <div class="date-nav">
        <button class="btn" id="prev" aria-label="Previous day">‹</button>
        <input type="date" id="date" value="${esc(data.date)}" max="${esc(today)}" aria-label="Date">
        <button class="btn" id="next" aria-label="Next day" ${data.date >= today ? 'disabled' : ''}>›</button>
      </div>
    </div>
    ${data.block ? `<div class="notice warn">${esc(data.block)}</div>` : ''}
    ${isAdmin() && !me.settings.days.includes(new Date(`${data.date}T00:00:00Z`).getUTCDay()) ? '<div class="notice warn">This is not a class day. As admin you can still mark it.</div>' : ''}
    ${data.students.length ? `
      <div class="toolbar no-print">
        <input type="search" id="q" placeholder="Search name or roll no." aria-label="Search students">
        ${classes.length > 1 ? `<select id="cls" aria-label="Class">${options(classes.map((c) => [c, c]), '', 'All classes')}</select>` : ''}
        ${isAdmin() ? `<select id="teacher" aria-label="Teacher">${options(data.teachers.map((t) => [t.id, t.name]), '', 'All teachers')}</select>` : ''}
        ${canEdit ? '<button class="btn" id="all-present">Mark the rest present</button>' : ''}
      </div>
      <div class="counts" id="counts"></div>
      <div class="rows" id="rows"></div>
      <div class="savebar">
        <span id="save-state" class="muted"></span>
        ${canEdit ? '<button class="btn primary" id="save">Save attendance</button>' : ''}
      </div>` : `<div class="card empty">${isAdmin() ? 'No students yet. Add them on the Students page.' : 'No students are assigned to you yet. Please ask the admin.'}</div>`}`;

  const goTo = (d) => {
    if (leaveGuard() && !confirm('You have unsaved attendance. Change date without saving?')) {
      page.querySelector('#date').value = data.date;
      return;
    }
    leaveGuard = null;
    viewMark(page, d).catch((e) => pageError(page, e));
  };
  page.querySelector('#prev').onclick = () => goTo(addDays(data.date, -1));
  page.querySelector('#next').onclick = () => goTo(addDays(data.date, 1));
  page.querySelector('#date').onchange = (e) => { if (e.target.value) goTo(e.target.value); };
  if (!data.students.length) return;

  const visible = () => {
    const q = filter.q.toLowerCase();
    return data.students.filter((s) =>
      (!q || s.name.toLowerCase().includes(q) || (s.rollNo || '').toLowerCase().includes(q)) &&
      (!filter.cls || s.className === filter.cls) &&
      (!filter.teacher || s.teacherId === filter.teacher));
  };

  const rowsEl = page.querySelector('#rows');

  function renderRows() {
    const list = visible();
    rowsEl.innerHTML = list.length ? list.map((s) => {
      const w = work[s.id];
      const r = data.records[s.id];
      const buttons = Object.entries(STATUS).map(([k, label]) =>
        `<button type="button" class="${k}" data-status="${k}" aria-pressed="${w.status === k}" ${canEdit ? '' : 'disabled'}>${label}</button>`).join('');
      return `<article class="row ${esc(w.status || '')}" data-id="${esc(s.id)}">
        <div class="name"><b>${esc(s.name)}</b><small>${s.rollNo ? `Roll ${esc(s.rollNo)}` : 'No roll no.'}${s.className ? ` · ${esc(s.className)}` : ''}${r?.byName && isAdmin() ? ` · by ${esc(r.byName)}` : ''}${s.phone ? ` · <a href="${esc(telHref(s.phone))}">${esc(s.phone)}</a>` : ''}</small></div>
        <div class="seg" role="group" aria-label="Attendance for ${esc(s.name)}">${buttons}</div>
        <input type="text" class="remark" maxlength="500" placeholder="Remarks (optional)" aria-label="Remarks for ${esc(s.name)}" value="${esc(w.remark)}" ${canEdit ? '' : 'disabled'}>
      </article>`;
    }).join('') : '<div class="card empty">No students match your search.</div>';
  }

  function renderCounts() {
    const list = visible();
    const n = { present: 0, late: 0, absent: 0, none: 0 };
    list.forEach((s) => { n[work[s.id].status || 'none'] += 1; });
    page.querySelector('#counts').innerHTML = `
      <span class="pill present">Present ${n.present}</span>
      <span class="pill late">Late ${n.late}</span>
      <span class="pill absent">Absent ${n.absent}</span>
      <span class="pill none">Not marked ${n.none}</span>`;
    const changed = changedIds().length;
    page.querySelector('#save-state').textContent = !canEdit ? 'Read-only'
      : changed ? `${changed} unsaved change${changed === 1 ? '' : 's'}`
      : 'All changes saved';
    const save = page.querySelector('#save');
    if (save) save.disabled = !changed;
  }

  rowsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-status]');
    if (!btn || btn.disabled) return;
    const row = btn.closest('.row');
    const w = work[row.dataset.id];
    w.status = w.status === btn.dataset.status ? null : btn.dataset.status;
    row.className = `row ${w.status || ''}`;
    row.querySelectorAll('button[data-status]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === w.status)));
    renderCounts();
  });
  rowsEl.addEventListener('input', (e) => {
    if (!e.target.classList.contains('remark')) return;
    work[e.target.closest('.row').dataset.id].remark = e.target.value;
    renderCounts();
  });

  page.querySelector('#q').oninput = (e) => { filter.q = e.target.value.trim(); renderRows(); renderCounts(); };
  const cls = page.querySelector('#cls');
  if (cls) cls.onchange = (e) => { filter.cls = e.target.value; renderRows(); renderCounts(); };
  const tch = page.querySelector('#teacher');
  if (tch) tch.onchange = (e) => { filter.teacher = e.target.value; renderRows(); renderCounts(); };

  const allPresent = page.querySelector('#all-present');
  if (allPresent) allPresent.onclick = () => {
    visible().forEach((s) => { if (!work[s.id].status) work[s.id].status = 'present'; });
    renderRows();
    renderCounts();
  };

  const save = page.querySelector('#save');
  if (save) save.onclick = async () => {
    const ids = changedIds();
    const missing = ids.filter((id) => !work[id].status && work[id].remark.trim());
    if (missing.length) {
      toast('Choose Present, Late or Absent for students with a remark.', true);
      filter.q = ''; filter.cls = ''; filter.teacher = '';
      page.querySelector('#q').value = '';
      if (cls) cls.value = '';
      if (tch) tch.value = '';
      renderRows();
      renderCounts();
      missing.forEach((id) => rowsEl.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('need'));
      rowsEl.querySelector('.need')?.scrollIntoView({ block: 'center' });
      return;
    }
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await api('PUT', 'attendance', {
        date: data.date,
        entries: ids.map((id) => ({ studentId: id, status: work[id].status, remark: work[id].remark.trim() })),
      });
      ids.forEach((id) => { saved[id] = { status: work[id].status, remark: work[id].remark.trim() }; });
      toast(`Saved attendance for ${ids.length} student${ids.length === 1 ? '' : 's'}.`);
    } catch (e) {
      toast(e.message, true);
    }
    save.textContent = 'Save attendance';
    renderCounts();
  };

  renderRows();
  renderCounts();
}

// ---------- admin: dashboard ----------

function meter(t) {
  const pct = (n) => (t.total ? (n / t.total) * 100 : 0);
  return `<div class="meter" aria-hidden="true">
    ${['present', 'late', 'absent'].map((k) => (t[k] ? `<i class="${k}" style="width:${pct(t[k]).toFixed(2)}%"></i>` : '')).join('')}
  </div>`;
}

function trendChart(trend) {
  if (!trend.length) return '<p class="muted">No attendance recorded yet.</p>';
  const max = Math.max(...trend.map((d) => d.present + d.late + d.absent), 1);
  const bars = trend.map((d) => {
    const total = d.present + d.late + d.absent;
    const rate = total ? Math.round(((d.present + d.late) / total) * 100) : 0;
    const tip = `${fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}\nPresent ${d.present}\nLate ${d.late}\nAbsent ${d.absent}\nAttended ${rate}%`;
    const seg = (k) => (d[k] ? `<i class="${k}" style="height:${((d[k] / max) * 100).toFixed(2)}%"></i>` : '');
    return `<div class="bar-col" data-tip="${esc(tip)}" tabindex="0" aria-label="${esc(tip.replace(/\n/g, ', '))}">${seg('absent')}${seg('late')}${seg('present')}</div>`;
  }).join('');
  const labels = trend.map((d) => `<span>${esc(fmtDate(d.date, { day: 'numeric', month: 'numeric' }))}</span>`).join('');
  return `<div class="legend">
      <span><i class="dot present"></i>Present</span><span><i class="dot late"></i>Late</span><span><i class="dot absent"></i>Absent</span>
    </div>
    <div class="bars">${bars}</div><div class="bar-labels">${labels}</div>`;
}

function bindTips(root) {
  const tip = document.getElementById('tip');
  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(x - w / 2, innerWidth - w - 8))}px`;
    tip.style.top = `${Math.max(8, y - h - 12)}px`;
  };
  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => show(el, e.clientX, e.clientY));
    el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); });
    el.addEventListener('click', () => { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); });
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
    el.addEventListener('blur', () => { tip.hidden = true; });
  });
}

async function viewDashboard(page, date) {
  me = await api('GET', 'me');
  const d = await api('GET', `dashboard${date ? `?date=${encodeURIComponent(date)}` : ''}`);
  const o = d.overall;
  const rate = o.marked ? `${Math.round(((o.present + o.late) / o.marked) * 100)}%` : '–';
  const pending = d.perTeacher.filter((t) => t.total && t.marked < t.total).length;

  page.innerHTML = `
    ${me.sample ? '<div class="notice info"><span>You are looking at <b>sample data</b>. When you are ready for real students, remove it in <a href="#/settings">Settings</a>.</span></div>' : ''}
    ${me.defaultPasswords.length ? `<div class="notice warn"><span><b>Default passwords still in use:</b> ${esc(me.defaultPasswords.join(', '))}. Change them before real use, in <a href="#/account">My account</a> and <a href="#/teachers">Teachers</a>.</span></div>` : ''}
    <div class="page-head">
      <div><h1>Dashboard</h1><p>${esc(fmtDate(d.date))}${d.isClassDay ? '' : ' · Not a class day'}</p></div>
      <div class="date-nav"><input type="date" id="date" value="${esc(d.date)}" max="${esc(me.clock.date)}" aria-label="Date"></div>
    </div>
    <div class="tiles">
      <div class="tile hero"><b>${rate}</b><span>Attended (of marked)</span></div>
      <div class="tile"><b>${o.present}</b><span><i class="dot present"></i>Present</span></div>
      <div class="tile"><b>${o.late}</b><span><i class="dot late"></i>Late</span></div>
      <div class="tile"><b>${o.absent}</b><span><i class="dot absent"></i>Absent</span></div>
      <div class="tile"><b>${o.total - o.marked}</b><span><i class="dot none"></i>Not marked</span></div>
    </div>
    <div class="grid-2">
      <section class="card">
        <h2>Teacher progress</h2>
        ${pending ? `<p class="muted">${pending} teacher list${pending === 1 ? '' : 's'} not finished.</p>` : ''}
        ${d.perTeacher.map((t) => `<div class="t-row">
          <div class="top"><b>${esc(t.name)}</b><span>${t.marked} of ${t.total} marked</span></div>
          ${meter(t)}
        </div>`).join('') || '<p class="muted">No teachers yet.</p>'}
      </section>
      <section class="card">
        <h2>Daily attendance, last ${d.trend.length || ''} recorded days</h2>
        ${trendChart(d.trend)}
      </section>
    </div>
    <section class="card">
      <h2>Absent and late</h2>
      ${d.exceptions.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Student</th><th>Status</th><th>Teacher</th><th>Remarks</th></tr></thead>
        <tbody>${d.exceptions.map((x) => `<tr>
          <td>${esc(x.name)}<span class="sub">${x.rollNo ? `Roll ${esc(x.rollNo)} · ` : ''}${esc(x.className)}</span></td>
          <td>${pill(x.status)}</td><td>${esc(x.teacher)}</td><td>${esc(x.remark) || '<span class="muted">–</span>'}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nobody is marked absent or late for this day.</p>'}
    </section>`;
  page.querySelector('#date').onchange = (e) => {
    if (e.target.value) viewDashboard(page, e.target.value).catch((err) => pageError(page, err));
  };
  bindTips(page);
}

// ---------- admin: students ----------

async function viewStudents(page) {
  const [{ students }, { teachers }] = await Promise.all([api('GET', 'students'), api('GET', 'teachers')]);
  const teacherName = Object.fromEntries(teachers.map((t) => [t.id, t.name]));
  const teacherOptions = teachers.filter((t) => t.active).map((t) => [t.id, t.name]);
  const filter = { q: '', teacher: '', gender: '', state: 'active' };
  const reload = () => viewStudents(page).catch((e) => pageError(page, e));

  const form = (s = {}) => `
    <label class="field"><span>Full name</span><input type="text" name="name" maxlength="120" value="${esc(s.name)}" required></label>
    <label class="field"><span>Phone number (optional)</span><input type="tel" name="phone" maxlength="30" autocomplete="off" value="${esc(s.phone)}"></label>
    <div class="form-grid">
      <label class="field"><span>Roll no.</span><input type="text" name="rollNo" maxlength="20" value="${esc(s.rollNo)}"></label>
      <label class="field"><span>Gender</span><select name="gender">${options([['boy', 'Boy'], ['girl', 'Girl']], s.gender || 'boy')}</select></label>
    </div>
    <div class="form-grid" style="margin-top:13px">
      <label class="field"><span>Class</span><input type="text" name="className" maxlength="40" value="${esc(s.className)}"></label>
      <label class="field"><span>Teacher</span><select name="teacherId">${options(teacherOptions, s.teacherId, 'Not assigned')}</select></label>
    </div>
    ${s.id ? `<label class="check" style="margin-top:13px"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}><span>Active<small class="muted" style="display:block">Inactive students leave the marking list but keep their history.</small></span></label>` : ''}`;

  const editStudent = (s) => formDialog({
    title: s ? 'Edit student' : 'Add student',
    body: form(s || {}),
    onSubmit: async (v) => {
      if (s) await api('PUT', `students/${encodeURIComponent(s.id)}`, { ...v, active: v.active === 'on' });
      else await api('POST', 'students', v);
      toast('Student saved.');
      reload();
    },
  });

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Students</h1><p>${students.filter((s) => s.active).length} active, ${students.filter((s) => s.gender === 'boy' && s.active).length} boys and ${students.filter((s) => s.gender === 'girl' && s.active).length} girls</p></div>
      <div class="actions">
        <button class="btn" id="import">Import CSV</button>
        <button class="btn primary" id="add">Add student</button>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search name, roll, phone or class" aria-label="Search students">
      <select id="teacher" aria-label="Teacher">${options(teachers.map((t) => [t.id, t.name]), '', 'All teachers')}</select>
      <select id="gender" aria-label="Gender">${options([['boy', 'Boys'], ['girl', 'Girls']], '', 'Boys and girls')}</select>
      <select id="state" aria-label="Status">${options([['active', 'Active'], ['inactive', 'Inactive'], ['all', 'Active and inactive']], 'active')}</select>
    </div>
    <section class="card"><div class="table-wrap"><table>
      <thead><tr><th>Roll</th><th>Name</th><th>Phone</th><th>Gender</th><th>Class</th><th>Teacher</th><th></th></tr></thead>
      <tbody id="tbody"></tbody></table></div></section>`;

  const tbody = page.querySelector('#tbody');
  function render() {
    const q = filter.q.toLowerCase();
    const list = students.filter((s) =>
      (!q || `${s.name} ${s.rollNo} ${s.className} ${s.phone || ''}`.toLowerCase().includes(q)) &&
      (!filter.teacher || s.teacherId === filter.teacher) &&
      (!filter.gender || s.gender === filter.gender) &&
      (filter.state === 'all' || s.active === (filter.state === 'active')));
    tbody.innerHTML = list.map((s) => `<tr class="${s.active ? '' : 'off'}">
      <td>${esc(s.rollNo)}</td>
      <td>${esc(s.name)}${s.active ? '' : ' <span class="pill none">Inactive</span>'}</td>
      <td>${s.phone ? `<a href="${esc(telHref(s.phone))}">${esc(s.phone)}</a>` : '<span class="muted">–</span>'}</td>
      <td>${s.gender === 'girl' ? 'Girl' : 'Boy'}</td>
      <td>${esc(s.className)}</td>
      <td>${esc(teacherName[s.teacherId] || 'Not assigned')}</td>
      <td class="num"><button class="link" data-edit="${esc(s.id)}">Edit</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No students found.</td></tr>';
  }
  tbody.onclick = (e) => {
    const id = e.target.dataset.edit;
    if (id) editStudent(students.find((s) => s.id === id));
  };
  page.querySelector('#q').oninput = (e) => { filter.q = e.target.value.trim(); render(); };
  for (const key of ['teacher', 'gender', 'state']) {
    page.querySelector(`#${key}`).onchange = (e) => { filter[key] = e.target.value; render(); };
  }
  page.querySelector('#add').onclick = () => editStudent(null);
  page.querySelector('#import').onclick = () => formDialog({
    title: 'Import students from CSV',
    submit: 'Import',
    body: `<p>Columns: <b>name, rollNo, gender, className, teacher, phone</b>. Gender is boy or girl. Teacher is the teacher's username. Phone is optional.</p>
      <p><button type="button" class="link" id="template">Download a template</button></p>
      <label class="field"><span>CSV file</span><input type="file" name="file" accept=".csv,text/csv" required></label>`,
    onSubmit: async (_, f) => {
      const file = f.file.files[0];
      if (!file) throw new Error('Choose a CSV file first.');
      const [header, ...rows] = parseCsv(await file.text()).filter((r) => r.some((c) => c.trim()));
      if (!header) throw new Error('That file is empty.');
      const cols = header.map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
      for (const needed of ['name', 'gender']) {
        if (!cols.includes(needed)) throw new Error(`The file has no "${needed}" column.`);
      }
      const at = (row, ...names) => {
        const i = cols.findIndex((c) => names.includes(c));
        return i < 0 ? '' : row[i] ?? '';
      };
      const res = await api('POST', 'students/import', {
        rows: rows.map((r) => ({
          name: at(r, 'name'),
          rollNo: at(r, 'rollno', 'roll'),
          gender: at(r, 'gender'),
          className: at(r, 'classname', 'class'),
          teacher: at(r, 'teacher'),
          phone: at(r, 'phone', 'phonenumber'),
        })),
      });
      toast(`Imported ${res.added} student${res.added === 1 ? '' : 's'}.`);
      if (res.skipped.length) {
        const shown = res.skipped.slice(0, 5).map((s) => `line ${s.line}: ${s.reason}`).join('; ');
        toast(`Skipped ${res.skipped.length}: ${shown}`, true);
      }
      reload();
    },
  }).querySelector('#template').addEventListener('click', () => {
    downloadCsv('students-template.csv', [
      ['name', 'rollNo', 'gender', 'className', 'teacher', 'phone'],
      ['Student Name', '101', 'boy', 'Hifz Boys A', teachers[0]?.username || '', '306-555-0100'],
    ]);
  });
  render();
}

// ---------- admin: teachers ----------

async function viewTeachers(page) {
  const { teachers } = await api('GET', 'teachers');
  const reload = () => viewTeachers(page).catch((e) => pageError(page, e));

  const editTeacher = (t) => formDialog({
    title: t ? 'Edit teacher' : 'Add teacher',
    body: `
      <label class="field"><span>Full name</span><input type="text" name="name" maxlength="120" value="${esc(t?.name)}" required></label>
      <div class="form-grid">
        <label class="field"><span>Username</span><input type="text" name="username" maxlength="40" autocapitalize="none" autocomplete="off" value="${esc(t?.username)}" required></label>
        <label class="field"><span>Gender</span><select name="gender">${options([['male', 'Male'], ['female', 'Female']], t?.gender || 'male')}</select></label>
      </div>
      <label class="field" style="margin-top:13px"><span>${t ? 'New password' : 'Password'}</span><input type="password" name="password" autocomplete="new-password" minlength="6"><small>${t ? 'Leave empty to keep the current password. ' : ''}At least 6 characters.</small></label>
      ${t ? `<label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}><span>Active: can sign in and mark attendance</span></label>` : ''}`,
    onSubmit: async (v) => {
      if (t) await api('PUT', `teachers/${encodeURIComponent(t.id)}`, { ...v, active: v.active === 'on' });
      else await api('POST', 'teachers', v);
      toast('Teacher saved.');
      reload();
    },
  });

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Teachers</h1><p>${teachers.filter((t) => t.gender === 'male' && t.active).length} male and ${teachers.filter((t) => t.gender === 'female' && t.active).length} female. Each teacher marks the students assigned to them.</p></div>
      <div class="actions"><button class="btn primary" id="add">Add teacher</button></div>
    </div>
    <section class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Gender</th><th class="num">Students</th><th>Password</th><th></th></tr></thead>
      <tbody>${teachers.map((t) => `<tr class="${t.active ? '' : 'off'}">
        <td>${esc(t.name)}${t.active ? '' : ' <span class="pill none">Inactive</span>'}</td>
        <td>${esc(t.username)}</td>
        <td>${t.gender === 'female' ? 'Female' : 'Male'}</td>
        <td class="num">${t.studentCount}</td>
        <td>${t.defaultPassword ? '<span class="pill late">Default</span>' : 'Changed'}</td>
        <td class="num"><button class="link" data-edit="${esc(t.id)}">Edit</button></td>
      </tr>`).join('')}</tbody></table></div></section>`;
  page.querySelector('tbody').onclick = (e) => {
    const id = e.target.dataset.edit;
    if (id) editTeacher(teachers.find((t) => t.id === id));
  };
  page.querySelector('#add').onclick = () => editTeacher(null);
}

// ---------- admin: reports ----------

async function viewReports(page) {
  me = await api('GET', 'me');
  const [{ students }, { teachers }] = await Promise.all([api('GET', 'students'), api('GET', 'teachers')]);
  const today = me.clock.date;
  const classes = [...new Set(students.map((s) => s.className).filter(Boolean))].sort();
  let tab = 'summary';
  let result = null;

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Reports</h1><p>Attendance by student and day, ready to export or print</p></div>
      <div class="actions no-print">
        <button class="btn" id="csv" disabled>Export CSV</button>
        <button class="btn" id="print" disabled>Print</button>
      </div>
    </div>
    <form class="card no-print" id="filters">
      <div class="form-grid">
        <label class="field"><span>From</span><input type="date" name="from" value="${esc(addDays(today, -29))}" max="${esc(today)}"></label>
        <label class="field"><span>To</span><input type="date" name="to" value="${esc(today)}" max="${esc(today)}"></label>
        <label class="field"><span>Teacher</span><select name="teacherId">${options(teachers.map((t) => [t.id, t.name]), '', 'All teachers')}</select></label>
        <label class="field"><span>Class</span><select name="className">${options(classes.map((c) => [c, c]), '', 'All classes')}</select></label>
        <label class="field"><span>Student</span><select name="studentId">${options([...students].sort((a, b) => a.name.localeCompare(b.name)).map((s) => [s.id, s.name + (s.rollNo ? ` (${s.rollNo})` : '')]), '', 'All students')}</select></label>
        <label class="field"><span>Status (daily list)</span><select name="status">${options(Object.entries(STATUS), '', 'All statuses')}</select></label>
        <button class="btn primary">Run report</button>
      </div>
    </form>
    <section class="card" id="result"></section>`;

  const out = page.querySelector('#result');
  const form = page.querySelector('#filters');

  function render() {
    const { summary, rows, days } = result;
    const rate = (s) => {
      const n = s.present + s.late + s.absent;
      return n ? `${Math.round(((s.present + s.late) / n) * 100)}%` : '–';
    };
    out.innerHTML = `
      <div class="tabs no-print" role="tablist">
        <button type="button" data-tab="summary" class="${tab === 'summary' ? 'on' : ''}">By student (${summary.length})</button>
        <button type="button" data-tab="daily" class="${tab === 'daily' ? 'on' : ''}">Daily list (${rows.length})</button>
      </div>
      <p class="muted">${esc(fmtDate(form.from.value, { day: 'numeric', month: 'short', year: 'numeric' }))} to ${esc(fmtDate(form.to.value, { day: 'numeric', month: 'short', year: 'numeric' }))} · ${days} day${days === 1 ? '' : 's'} recorded</p>
      <div class="table-wrap">${tab === 'summary' ? `<table>
        <thead><tr><th>Student</th><th>Class</th><th>Teacher</th><th class="num">Present</th><th class="num">Late</th><th class="num">Absent</th><th class="num">Attended</th></tr></thead>
        <tbody>${summary.map((s) => `<tr><td>${esc(s.name)}${s.rollNo ? `<span class="sub">Roll ${esc(s.rollNo)}${s.active ? '' : ' · Inactive'}</span>` : ''}</td><td>${esc(s.className)}</td><td>${esc(s.teacher)}</td>
          <td class="num">${s.present}</td><td class="num">${s.late}</td><td class="num">${s.absent}</td><td class="num"><b>${rate(s)}</b></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No students match.</td></tr>'}</tbody></table>` : `<table>
        <thead><tr><th>Date</th><th>Student</th><th>Class</th><th>Status</th><th>Remarks</th><th>Marked by</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(fmtDate(r.date, { day: 'numeric', month: 'short', year: 'numeric' }))}</td><td>${esc(r.name)}${r.rollNo ? `<span class="sub">Roll ${esc(r.rollNo)}</span>` : ''}</td><td>${esc(r.className)}</td><td>${pill(r.status)}</td><td>${esc(r.remark)}</td><td>${esc(r.markedBy)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No attendance matches these filters.</td></tr>'}</tbody></table>`}</div>`;
    out.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; render(); }; });
    page.querySelector('#csv').disabled = false;
    page.querySelector('#print').disabled = false;
  }

  async function run() {
    loading(out);
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) params.set(k, v);
    try {
      result = await api('GET', `reports?${params}`);
      render();
    } catch (e) {
      pageError(out, e);
    }
  }

  form.onsubmit = (e) => { e.preventDefault(); run(); };
  page.querySelector('#print').onclick = () => window.print();
  page.querySelector('#csv').onclick = () => {
    const range = `${form.from.value}_to_${form.to.value}`;
    if (tab === 'summary') {
      downloadCsv(`attendance-summary_${range}.csv`, [
        ['Student', 'Roll no', 'Class', 'Teacher', 'Present', 'Late', 'Absent'],
        ...result.summary.map((s) => [s.name, s.rollNo, s.className, s.teacher, s.present, s.late, s.absent]),
      ]);
    } else {
      downloadCsv(`attendance-daily_${range}.csv`, [
        ['Date', 'Student', 'Roll no', 'Class', 'Status', 'Remarks', 'Marked by'],
        ...result.rows.map((r) => [r.date, r.name, r.rollNo, r.className, STATUS[r.status], r.remark, r.markedBy]),
      ]);
    }
  };
  run();
}

// ---------- admin: settings ----------

async function viewSettings(page) {
  me = await api('GET', 'me');
  const s = me.settings;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  page.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Class schedule and data</p></div></div>
    <form class="card" id="sched">
      <h2>Class schedule</h2>
      <div class="field"><span>Class days</span><div class="days">
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" name="day" value="${d}" ${s.days.includes(d) ? 'checked' : ''}>${DAY_SHORT[d]}</label>`).join('')}
      </div></div>
      <div class="form-grid">
        <label class="field"><span>Start time</span><input type="time" name="startTime" value="${esc(s.startTime)}"></label>
        <label class="field"><span>Timezone of the madarsah</span><input type="text" name="timezone" list="zones" value="${esc(s.timezone)}" autocomplete="off"><datalist id="zones">${zones.map((z) => `<option value="${esc(z)}">`).join('')}</datalist></label>
      </div>
      <p class="muted">Madarsah clock right now: ${esc(fmtDate(me.clock.date, { weekday: 'short', day: 'numeric', month: 'short' }))}, ${esc(fmtTime(me.clock.time))}</p>
      <label class="check"><input type="checkbox" name="enforceSchedule" ${s.enforceSchedule ? 'checked' : ''}><span><b>Lock teacher marking to the schedule</b><small class="muted" style="display:block">When on, teachers can only mark on class days from the start time until midnight. Turn it off to let teachers try the app at any time during a demo. The admin can always mark.</small></span></label>
      <button class="btn primary">Save schedule</button>
    </form>
    ${me.sample ? `<section class="card">
      <h2>Sample data</h2>
      <p>The app started with 100 sample students and 10 days of sample attendance. Removing it also clears anything marked so far. Teacher accounts stay.</p>
      <button class="btn danger" id="reset">Remove sample data</button>
    </section>` : ''}`;
  page.querySelector('#sched').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('PUT', 'settings', {
        startTime: f.startTime.value,
        timezone: f.timezone.value.trim(),
        days: [...f.querySelectorAll('[name=day]:checked')].map((c) => Number(c.value)),
        enforceSchedule: f.enforceSchedule.checked,
      });
      toast('Schedule saved.');
      viewSettings(page).catch((err) => pageError(page, err));
    } catch (err) {
      toast(err.message, true);
    }
  };
  const reset = page.querySelector('#reset');
  if (reset) reset.onclick = () => formDialog({
    title: 'Remove sample data?',
    danger: true,
    submit: 'Delete permanently',
    body: `<p>This permanently deletes every student and all attendance records. It cannot be undone.</p>
      <label class="field"><span>Type DELETE to confirm</span><input type="text" name="confirm" autocomplete="off"></label>`,
    onSubmit: async (v) => {
      await api('POST', 'reset-sample', { confirm: v.confirm.trim() });
      toast('Sample data removed.');
      viewSettings(page).catch((err) => pageError(page, err));
    },
  });
}

// ---------- my account ----------

async function viewAccount(page) {
  me = await api('GET', 'me');
  page.innerHTML = `
    <div class="page-head"><div><h1>My account</h1><p>${esc(me.user.name)} · Username: ${esc(me.user.username)}</p></div></div>
    ${me.user.defaultPassword ? '<div class="notice warn">You are still using the default password. Please change it.</div>' : ''}
    <form class="card" id="pw" style="max-width:440px">
      <h2>Change password</h2>
      <label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>New password</span><input type="password" name="next" autocomplete="new-password" minlength="6" required><small>At least 6 characters.</small></label>
      <button class="btn primary">Change password</button>
    </form>`;
  page.querySelector('#pw').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', 'password', { current: e.target.current.value, next: e.target.next.value });
      toast('Password changed.');
      viewAccount(page).catch((err) => pageError(page, err));
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- start ----------

start().catch(() => renderLogin());
