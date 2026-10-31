import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../lib/core.mjs';

function memoryStore() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : null),
    set: async (k, v) => void map.set(k, structuredClone(v)),
    delete: async (k) => void map.delete(k),
    list: async (p) => [...map.keys()].filter((k) => k.startsWith(p)),
  };
}

// Saskatchewan is UTC-6 with no daylight saving; the seed's default timezone.
const at = (local) => new Date(`${local}:00-06:00`);
const FRIDAY_OPEN = '2026-10-30T17:45';
const FRIDAY_EARLY = '2026-10-30T16:00';
const SATURDAY = '2026-10-31T18:00';

function setup() {
  const clockRef = { now: at(FRIDAY_OPEN) };
  const handle = createApi(memoryStore(), { now: () => clockRef.now });
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await handle(
        new Request(`http://x/api/${path}`, {
          method,
          headers: { 'content-type': 'application/json', cookie },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
    return call;
  };
  return { clockRef, client };
}

async function login(client, username, password) {
  const call = client();
  const res = await call('POST', 'login', { username, password });
  assert.equal(res.status, 200);
  return call;
}

test('seed creates five teachers and 100 students', async () => {
  const { client } = setup();
  const admin = await login(client, 'admin', 'admin123');
  const { data: t } = await admin('GET', 'teachers');
  const { data: s } = await admin('GET', 'students');
  assert.equal(t.teachers.length, 5);
  assert.equal(t.teachers.filter((x) => x.gender === 'female').length, 2);
  assert.equal(s.students.length, 100);
  assert.ok(t.teachers.every((x) => !('password' in x)));
});

test('wrong password rejected, and account locks after repeated failures', async () => {
  const { client } = setup();
  const call = client();
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', 'login', { username: 'ahmed', password: 'nope' })).status, 401);
  }
  assert.equal((await call('POST', 'login', { username: 'ahmed', password: 'teacher123' })).status, 429);
});

test('requests without a session are refused', async () => {
  const { client } = setup();
  assert.equal((await client()('GET', 'attendance')).status, 401);
});

test('teacher sees and marks only their own students, with remarks', async () => {
  const { client } = setup();
  const t = await login(client, 'ahmed', 'teacher123');
  const { data } = await t('GET', 'attendance');
  assert.equal(data.students.length, 20);
  assert.equal(data.block, null);
  const id = data.students[0].id;
  const saved = await t('PUT', 'attendance', {
    date: data.date,
    entries: [{ studentId: id, status: 'late', remark: 'Bus delay' }],
  });
  assert.equal(saved.status, 200);
  const again = await t('GET', 'attendance');
  assert.equal(again.data.records[id].status, 'late');
  assert.equal(again.data.records[id].remark, 'Bus delay');

  const other = await login(client, 'aisha', 'teacher123');
  const { data: hers } = await other('GET', 'attendance');
  const res = await t('PUT', 'attendance', { date: data.date, entries: [{ studentId: hers.students[0].id, status: 'present' }] });
  assert.equal(res.status, 403);
});

test('teachers saving at the same time do not lose each other\'s marks', async () => {
  const { client } = setup();
  const a = await login(client, 'ahmed', 'teacher123');
  const b = await login(client, 'aisha', 'teacher123');
  const { data: da } = await a('GET', 'attendance');
  const { data: db } = await b('GET', 'attendance');
  await Promise.all([
    a('PUT', 'attendance', { date: da.date, entries: da.students.map((s) => ({ studentId: s.id, status: 'present' })) }),
    b('PUT', 'attendance', { date: db.date, entries: db.students.map((s) => ({ studentId: s.id, status: 'absent' })) }),
  ]);
  const admin = await login(client, 'admin', 'admin123');
  const { data } = await admin('GET', 'dashboard');
  assert.equal(data.overall.present, 20);
  assert.equal(data.overall.absent, 20);
});

test('schedule: closed before 5:30 PM and at weekends; open after', async () => {
  const { client, clockRef } = setup();
  const t = await login(client, 'ahmed', 'teacher123');
  const { data } = await t('GET', 'attendance');
  const entry = [{ studentId: data.students[0].id, status: 'present' }];

  clockRef.now = at(FRIDAY_EARLY);
  let res = await t('PUT', 'attendance', { date: '2026-10-30', entries: entry });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /5:30 PM/);

  clockRef.now = at(SATURDAY);
  res = await t('PUT', 'attendance', { date: '2026-10-31', entries: entry });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /No class today/);

  clockRef.now = at(FRIDAY_OPEN);
  assert.equal((await t('PUT', 'attendance', { date: '2026-10-30', entries: entry })).status, 200);
});

test('teachers cannot edit past or future days; admin can correct the past', async () => {
  const { client } = setup();
  const t = await login(client, 'ahmed', 'teacher123');
  const admin = await login(client, 'admin', 'admin123');
  const { data } = await t('GET', 'attendance');
  const entries = [{ studentId: data.students[0].id, status: 'absent', remark: 'Corrected' }];
  assert.equal((await t('PUT', 'attendance', { date: '2026-10-29', entries })).status, 403);
  assert.equal((await t('PUT', 'attendance', { date: '2026-10-31', entries })).status, 403);
  assert.equal((await admin('PUT', 'attendance', { date: '2026-10-31', entries })).status, 403);
  assert.equal((await admin('PUT', 'attendance', { date: '2026-10-29', entries })).status, 200);
  const { data: after } = await t('GET', 'attendance?date=2026-10-29');
  assert.equal(after.records[entries[0].studentId].remark, 'Corrected');
});

test('teachers are refused every admin route', async () => {
  const { client } = setup();
  const t = await login(client, 'ahmed', 'teacher123');
  for (const [m, p] of [['GET', 'dashboard'], ['GET', 'students'], ['GET', 'teachers'], ['GET', 'reports?from=2026-10-01&to=2026-10-30'], ['PUT', 'settings'], ['POST', 'reset-sample'], ['POST', 'teachers'], ['POST', 'students/import']]) {
    assert.equal((await t(m, p, m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
  }
});

test('changing a password ends other sessions; deactivated teacher is signed out', async () => {
  const { client } = setup();
  const phone = await login(client, 'ahmed', 'teacher123');
  const laptop = await login(client, 'ahmed', 'teacher123');
  assert.equal((await phone('POST', 'password', { current: 'wrong', next: 'newpass1' })).status, 400);
  assert.equal((await phone('POST', 'password', { current: 'teacher123', next: 'newpass1' })).status, 200);
  assert.equal((await phone('GET', 'me')).status, 200);
  assert.equal((await laptop('GET', 'me')).status, 401);

  const admin = await login(client, 'admin', 'admin123');
  await admin('PUT', 'teachers/t1', { name: 'Ustad Ahmed', username: 'ahmed', gender: 'male', active: false });
  assert.equal((await phone('GET', 'me')).status, 401);
  assert.equal((await client()('POST', 'login', { username: 'ahmed', password: 'newpass1' })).status, 401);
});

test('reports summarise a range and history survives archiving a student', async () => {
  const { client } = setup();
  const admin = await login(client, 'admin', 'admin123');
  const { data } = await admin('GET', 'reports?from=2026-10-01&to=2026-10-30&studentId=s001');
  assert.equal(data.summary.length, 1);
  const s = data.summary[0];
  assert.equal(s.present + s.late + s.absent, data.days);
  assert.ok(data.days > 0);

  const { data: all } = await admin('GET', 'students');
  const student = all.students.find((x) => x.id === 's001');
  await admin('PUT', 'students/s001', { ...student, active: false });
  const { data: after } = await admin('GET', 'reports?from=2026-10-01&to=2026-10-30&studentId=s001');
  assert.equal(after.summary[0].active, false);
  assert.equal(after.days, data.days);
  const { data: dash } = await admin('GET', 'dashboard');
  assert.equal(dash.overall.total, 99);
});

test('CSV import adds valid rows and reports bad ones', async () => {
  const { client } = setup();
  const admin = await login(client, 'admin', 'admin123');
  const { data } = await admin('POST', 'students/import', {
    rows: [
      { name: 'New Boy', gender: 'boy', rollNo: '900', className: 'X', teacher: 'ahmed' },
      { name: '', gender: 'boy' },
      { name: 'Dup', gender: 'girl', rollNo: '900' },
      { name: 'Who', gender: 'boy', teacher: 'nobody' },
    ],
  });
  assert.equal(data.added, 1);
  assert.deepEqual(data.skipped.map((s) => s.line), [3, 4, 5]);
});

test('removing the sample data empties students and attendance but keeps logins', async () => {
  const { client } = setup();
  const admin = await login(client, 'admin', 'admin123');
  assert.equal((await admin('POST', 'reset-sample', { confirm: 'no' })).status, 400);
  assert.equal((await admin('POST', 'reset-sample', { confirm: 'DELETE' })).status, 200);
  assert.equal((await admin('GET', 'students')).data.students.length, 0);
  assert.equal((await admin('GET', 'reports?from=2026-10-01&to=2026-10-30')).data.rows.length, 0);
  assert.equal((await admin('GET', 'me')).data.sample, false);
  assert.equal((await admin('POST', 'reset-sample', { confirm: 'DELETE' })).status, 400);
  await login(client, 'ahmed', 'teacher123');
});

test('phone numbers: saved, validated, optional, and shown to a teacher only for their own students', async () => {
  const { client } = setup();
  const admin = await login(client, 'admin', 'admin123');
  const { data: all } = await admin('GET', 'students');
  const student = all.students.find((x) => x.id === 's001');
  assert.equal(student.phone, undefined); // records saved before this field existed still load

  assert.equal((await admin('PUT', 'students/s001', { ...student, phone: 'call me' })).status, 400);
  assert.equal((await admin('PUT', 'students/s001', { ...student, phone: '+1 (306) 555-0100' })).status, 200);

  const own = await login(client, 'ahmed', 'teacher123');
  const { data: mine } = await own('GET', 'attendance');
  assert.equal(mine.students.find((s) => s.id === 's001').phone, '+1 (306) 555-0100');

  const other = await login(client, 'aisha', 'teacher123');
  const { data: hers } = await other('GET', 'attendance');
  assert.ok(!hers.students.some((s) => s.id === 's001'));

  const { data: imported } = await admin('POST', 'students/import', {
    rows: [
      { name: 'With Phone', gender: 'boy', phone: '306-555-0101' },
      { name: 'No Phone', gender: 'girl' },
      { name: 'Bad Phone', gender: 'girl', phone: 'abc' },
    ],
  });
  assert.equal(imported.added, 2);
  assert.deepEqual(imported.skipped.map((s) => s.line), [4]);
});

test('first-run passwords can come from the environment, replacing the published defaults', async (t) => {
  process.env.PMA_ADMIN_PASSWORD = 'private-admin';
  process.env.PMA_TEACHER_PASSWORD = 'private-teacher';
  t.after(() => {
    delete process.env.PMA_ADMIN_PASSWORD;
    delete process.env.PMA_TEACHER_PASSWORD;
  });
  const { client } = setup();
  assert.equal((await client()('POST', 'login', { username: 'admin', password: 'admin123' })).status, 401);
  assert.equal((await client()('POST', 'login', { username: 'ahmed', password: 'teacher123' })).status, 401);
  await login(client, 'ahmed', 'private-teacher');
  const admin = await login(client, 'admin', 'private-admin');
  assert.deepEqual((await admin('GET', 'me')).data.defaultPasswords, []);
});
