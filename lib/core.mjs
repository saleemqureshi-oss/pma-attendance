// PMA Attendance API. Hosting-independent: takes a key/value store and turns a
// web-standard Request into a Response. See netlify/functions/api.mjs and server.mjs.
//
// Storage layout:
//   meta, users, students, settings   whole-collection JSON documents (admin writes only)
//   att/<date>/<userId>               one document per day per person who marked
//   fail/<username>                   failed-login counter
// Attendance is sharded per writer so teachers saving at the same moment can never
// overwrite each other. Reads merge the shards; the newest entry per student wins.
import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { buildSeed } from './seed.mjs';

const scrypt = promisify(scryptCb);

const STATUSES = ['present', 'absent', 'late'];
const SESSION_DAYS = 14;
const COOKIE = 'pma_session';
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const MAX_REPORT_DAYS = 366;
const MAX_REMARK = 500;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'hex');
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(secret, token) {
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

// The madarsah's local date and time, whatever timezone the server runs in.
export function clock(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}`, weekday: weekdayOf(date) };
}

const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatTime(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Why this user may not edit this date, or null when they may.
function editBlock(user, date, settings, now) {
  const today = now.date;
  if (date > today) return 'Attendance cannot be marked for a future date.';
  if (user.role === 'admin') return null;
  if (date < today) return 'Past days are read-only for teachers. Ask the admin to correct them.';
  if (!settings.enforceSchedule) return null;
  if (!settings.days.includes(now.weekday)) {
    const names = settings.days.map((d) => DAY_NAMES[d]).join(', ');
    return `No class today. Attendance is taken on: ${names}.`;
  }
  if (now.time < settings.startTime) return `Attendance opens at ${formatTime(settings.startTime)} today.`;
  return null;
}

function cleanText(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    gender: u.gender,
    active: u.active,
    defaultPassword: !!u.defaultPassword,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function createApi(store, { now: nowFn = () => new Date() } = {}) {
  async function ensureSeed() {
    const meta = await store.get('meta');
    if (meta) return meta;
    const seed = await buildSeed(nowFn());
    await store.set('users', seed.users);
    await store.set('students', seed.students);
    await store.set('settings', seed.settings);
    await mapLimit(Object.entries(seed.attendance), 20, ([key, value]) => store.set(key, value));
    const created = { secret: randomBytes(32).toString('hex'), sample: true };
    await store.set('meta', created); // last, so an interrupted seed runs again
    return created;
  }

  // ---- attendance storage ----

  async function loadRecords(from, to) {
    const prefix = from === to ? `att/${from}/` : 'att/';
    const keys = (await store.list(prefix)).filter((key) => {
      const date = key.split('/')[1];
      return date >= from && date <= to;
    });
    const shards = await mapLimit(keys, 30, async (key) => [key.split('/')[1], await store.get(key)]);
    const merged = new Map();
    for (const [date, shard] of shards) {
      for (const [studentId, rec] of Object.entries(shard || {})) {
        const k = `${date}|${studentId}`;
        const cur = merged.get(k);
        if (!cur || rec.at > cur.at) merged.set(k, { ...rec, date, studentId });
      }
    }
    return [...merged.values()].filter((r) => r.status); // null status = cleared
  }

  // ---- handlers ----

  const routes = {
    async 'POST login'({ body, meta }) {
      const username = cleanText(body.username).toLowerCase();
      const password = String(body.password ?? '');
      const failKey = `fail/${username}`;
      const users = await store.get('users');
      const user = users.find((u) => u.username === username && u.active);
      if (user) {
        const fail = await store.get(failKey);
        if (fail && fail.until > nowFn().getTime()) {
          throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
        }
      }
      const ok = user && (await verifyPassword(password, user.password));
      if (!ok) {
        if (user) {
          const fail = (await store.get(failKey)) || { count: 0, until: 0 };
          fail.count += 1;
          if (fail.count >= MAX_FAILS) {
            fail.count = 0;
            fail.until = nowFn().getTime() + LOCK_MS;
          }
          await store.set(failKey, fail);
        }
        throw new HttpError(401, 'Wrong username or password.');
      }
      await store.delete(failKey);
      return { data: { ok: true }, cookie: sessionCookie(meta, user) };
    },

    async 'POST logout'() {
      return { data: { ok: true }, cookie: '' };
    },

    async 'GET me'({ user, settings, meta, users }) {
      return {
        user: publicUser(user),
        settings,
        clock: clock(settings.timezone, nowFn()),
        sample: !!meta.sample,
        defaultPasswords:
          user.role === 'admin' ? users.filter((u) => u.defaultPassword && u.active).map((u) => u.name) : [],
      };
    },

    async 'POST password'({ user, users, body, meta }) {
      if (!(await verifyPassword(String(body.current ?? ''), user.password))) {
        throw bad('Your current password is not correct.');
      }
      const next = String(body.next ?? '');
      if (next.length < 6) throw bad('The new password must be at least 6 characters.');
      user.password = await hashPassword(next);
      user.defaultPassword = false;
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      await store.set('users', users);
      return { data: { ok: true }, cookie: sessionCookie(meta, user) };
    },

    async 'GET attendance'({ user, users, settings, url }) {
      const now = clock(settings.timezone, nowFn());
      const date = url.searchParams.get('date') || now.date;
      if (!isValidDate(date)) throw bad('Invalid date.');
      const all = await store.get('students');
      const students = all
        .filter((s) => s.active && (user.role === 'admin' || s.teacherId === user.id))
        .sort(byClassThenName);
      const ids = new Set(students.map((s) => s.id));
      const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
      const records = {};
      for (const r of await loadRecords(date, date)) {
        if (ids.has(r.studentId)) {
          records[r.studentId] = { status: r.status, remark: r.remark || '', at: r.at, byName: names[r.by] || '' };
        }
      }
      return {
        date,
        students,
        records,
        block: editBlock(user, date, settings, now),
        teachers: user.role === 'admin' ? users.filter((u) => u.role === 'teacher').map(publicUser) : [],
      };
    },

    async 'PUT attendance'({ user, settings, body }) {
      const now = clock(settings.timezone, nowFn());
      const date = body.date;
      if (!isValidDate(date)) throw bad('Invalid date.');
      const block = editBlock(user, date, settings, now);
      if (block) throw new HttpError(403, block);
      if (!Array.isArray(body.entries) || !body.entries.length) throw bad('Nothing to save.');
      const students = await store.get('students');
      const allowed = new Set(
        students.filter((s) => s.active && (user.role === 'admin' || s.teacherId === user.id)).map((s) => s.id),
      );
      const key = `att/${date}/${user.id}`;
      const shard = (await store.get(key)) || {};
      const at = nowFn().getTime();
      for (const entry of body.entries) {
        if (!allowed.has(entry.studentId)) throw new HttpError(403, 'That student is not in your list.');
        if (entry.status !== null && !STATUSES.includes(entry.status)) throw bad('Invalid status.');
        shard[entry.studentId] = {
          status: entry.status,
          remark: cleanText(entry.remark, MAX_REMARK),
          by: user.id,
          at,
        };
      }
      await store.set(key, shard);
      return { ok: true, saved: body.entries.length };
    },

    // ---- admin ----

    async 'GET dashboard'({ settings, users, url }) {
      const now = clock(settings.timezone, nowFn());
      const date = url.searchParams.get('date') || now.date;
      if (!isValidDate(date)) throw bad('Invalid date.');
      const students = (await store.get('students')).filter((s) => s.active);
      const from = addDays(date, -20);
      const records = await loadRecords(from, date);
      const todays = new Map(records.filter((r) => r.date === date).map((r) => [r.studentId, r]));

      const tally = (list) => {
        const t = { total: list.length, marked: 0, present: 0, absent: 0, late: 0 };
        for (const s of list) {
          const r = todays.get(s.id);
          if (r) {
            t.marked += 1;
            t[r.status] += 1;
          }
        }
        return t;
      };

      const teachers = users.filter((u) => u.role === 'teacher' && u.active);
      const teacherIds = new Set(teachers.map((t) => t.id));
      const perTeacher = teachers.map((t) => ({
        id: t.id,
        name: t.name,
        ...tally(students.filter((s) => s.teacherId === t.id)),
      }));
      const orphans = students.filter((s) => !teacherIds.has(s.teacherId));
      if (orphans.length) perTeacher.push({ id: null, name: 'No teacher assigned', ...tally(orphans) });

      const teacherName = Object.fromEntries(users.map((u) => [u.id, u.name]));
      const exceptions = students
        .filter((s) => ['absent', 'late'].includes(todays.get(s.id)?.status))
        .map((s) => ({
          id: s.id,
          name: s.name,
          rollNo: s.rollNo,
          className: s.className,
          teacher: teacherName[s.teacherId] || '',
          status: todays.get(s.id).status,
          remark: todays.get(s.id).remark || '',
        }))
        .sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name));

      const byDay = new Map();
      for (const r of records) {
        const d = byDay.get(r.date) || { date: r.date, present: 0, late: 0, absent: 0 };
        d[r.status] += 1;
        byDay.set(r.date, d);
      }
      const trend = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-10);

      return { date, overall: tally(students), perTeacher, exceptions, trend, isClassDay: settings.days.includes(weekdayOf(date)) };
    },

    async 'GET students'() {
      return { students: (await store.get('students')).sort(byClassThenName) };
    },

    async 'POST students'({ body, users }) {
      const students = await store.get('students');
      const student = readStudent(body, users);
      assertUniqueRoll(students, student.rollNo);
      student.id = randomUUID();
      student.active = true;
      students.push(student);
      await store.set('students', students);
      return { student };
    },

    async 'PUT students/:id'({ body, users, params }) {
      const students = await store.get('students');
      const student = students.find((s) => s.id === params.id);
      if (!student) throw new HttpError(404, 'Student not found.');
      const fields = readStudent(body, users);
      assertUniqueRoll(students, fields.rollNo, student.id);
      Object.assign(student, fields, { active: body.active !== false });
      await store.set('students', students);
      return { student };
    },

    async 'POST students/import'({ body, users }) {
      if (!Array.isArray(body.rows)) throw bad('No rows to import.');
      const students = await store.get('students');
      const skipped = [];
      let added = 0;
      body.rows.forEach((row, i) => {
        try {
          const teacher = users.find(
            (u) => u.role === 'teacher' && u.username === cleanText(row.teacher).toLowerCase(),
          );
          if (cleanText(row.teacher) && !teacher) throw bad(`unknown teacher username "${cleanText(row.teacher)}"`);
          const student = readStudent({ ...row, teacherId: teacher?.id ?? '' }, users);
          assertUniqueRoll(students, student.rollNo);
          students.push({ ...student, id: randomUUID(), active: true });
          added += 1;
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          skipped.push({ line: i + 2, reason: e.message });
        }
      });
      await store.set('students', students);
      return { added, skipped };
    },

    async 'GET teachers'({ users }) {
      const students = await store.get('students');
      return {
        teachers: users
          .filter((u) => u.role === 'teacher')
          .map((u) => ({
            ...publicUser(u),
            studentCount: students.filter((s) => s.active && s.teacherId === u.id).length,
          })),
      };
    },

    async 'POST teachers'({ body, users }) {
      const fields = readTeacher(body, users);
      if (String(body.password ?? '').length < 6) throw bad('The password must be at least 6 characters.');
      const teacher = {
        ...fields,
        id: randomUUID(),
        role: 'teacher',
        active: true,
        tokenVersion: 0,
        password: await hashPassword(String(body.password)),
      };
      users.push(teacher);
      await store.set('users', users);
      return { teacher: publicUser(teacher) };
    },

    async 'PUT teachers/:id'({ body, users, params }) {
      const teacher = users.find((u) => u.id === params.id && u.role === 'teacher');
      if (!teacher) throw new HttpError(404, 'Teacher not found.');
      Object.assign(teacher, readTeacher(body, users, teacher.id));
      const active = body.active !== false;
      if (teacher.active && !active) teacher.tokenVersion = (teacher.tokenVersion || 0) + 1;
      teacher.active = active;
      if (body.password) {
        if (String(body.password).length < 6) throw bad('The password must be at least 6 characters.');
        teacher.password = await hashPassword(String(body.password));
        teacher.defaultPassword = false;
        teacher.tokenVersion = (teacher.tokenVersion || 0) + 1;
      }
      await store.set('users', users);
      return { teacher: publicUser(teacher) };
    },

    async 'GET reports'({ users, url }) {
      const q = url.searchParams;
      const from = q.get('from');
      const to = q.get('to');
      if (!isValidDate(from) || !isValidDate(to)) throw bad('Choose a valid date range.');
      if (from > to) throw bad('The start date is after the end date.');
      if ((new Date(to) - new Date(from)) / 86400000 >= MAX_REPORT_DAYS) throw bad('Choose a range of one year or less.');

      const teacherId = q.get('teacherId');
      const className = q.get('className');
      const studentId = q.get('studentId');
      const status = q.get('status');
      const students = (await store.get('students')).filter(
        (s) =>
          (!teacherId || s.teacherId === teacherId) &&
          (!className || s.className === className) &&
          (!studentId || s.id === studentId),
      );
      const byId = new Map(students.map((s) => [s.id, s]));
      const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
      const records = (await loadRecords(from, to)).filter((r) => byId.has(r.studentId));

      const summary = new Map(
        students.map((s) => [
          s.id,
          { studentId: s.id, name: s.name, rollNo: s.rollNo, className: s.className, teacher: names[s.teacherId] || '', active: s.active, present: 0, late: 0, absent: 0 },
        ]),
      );
      for (const r of records) summary.get(r.studentId)[r.status] += 1;

      const rows = records
        .filter((r) => !status || r.status === status)
        .map((r) => {
          const s = byId.get(r.studentId);
          return { date: r.date, name: s.name, rollNo: s.rollNo, className: s.className, status: r.status, remark: r.remark || '', markedBy: names[r.by] || '' };
        })
        .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));

      return {
        summary: [...summary.values()].sort((a, b) => a.name.localeCompare(b.name)),
        rows,
        days: new Set(records.map((r) => r.date)).size,
      };
    },

    async 'PUT settings'({ body, settings }) {
      const startTime = String(body.startTime ?? '');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw bad('Invalid start time.');
      if (!isValidTimeZone(body.timezone)) throw bad('Unknown timezone.');
      const days = Array.isArray(body.days) ? [...new Set(body.days.map(Number))].filter((d) => d >= 0 && d <= 6).sort() : [];
      if (!days.length) throw bad('Choose at least one class day.');
      const next = { ...settings, startTime, timezone: body.timezone, days, enforceSchedule: !!body.enforceSchedule };
      await store.set('settings', next);
      return { settings: next };
    },

    async 'POST reset-sample'({ body, meta }) {
      if (!meta.sample) throw bad('The sample data has already been removed.');
      if (body.confirm !== 'DELETE') throw bad('Type DELETE to confirm.');
      const keys = await store.list('att/');
      await mapLimit(keys, 30, (key) => store.delete(key));
      await store.set('students', []);
      await store.set('meta', { ...meta, sample: false });
      return { ok: true };
    },
  };

  const PUBLIC = new Set(['POST login', 'POST logout']);
  const ADMIN_ONLY = /^(GET dashboard|(GET|POST|PUT) (students|teachers)|GET reports|PUT settings|POST reset-sample)/;

  function sessionCookie(meta, user) {
    return sign(meta.secret, {
      u: user.id,
      v: user.tokenVersion || 0,
      exp: nowFn().getTime() + SESSION_DAYS * 86400000,
    });
  }

  function matchRoute(method, path) {
    const exact = `${method} ${path}`;
    if (routes[exact]) return { name: exact, params: {} };
    const [resource, id, extra] = path.split('/');
    if (id && !extra && routes[`${method} ${resource}/:id`]) {
      return { name: `${method} ${resource}/:id`, params: { id } };
    }
    return null;
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
    const secure = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
    try {
      const route = matchRoute(req.method, path);
      if (!route) throw new HttpError(404, 'Not found.');

      let body = {};
      if (req.method !== 'GET') {
        // Requiring JSON blocks cross-site form posts, on top of the SameSite cookie.
        if (!(req.headers.get('content-type') || '').includes('application/json')) {
          throw new HttpError(415, 'Expected JSON.');
        }
        try {
          body = (await req.json()) ?? {};
        } catch {
          throw bad('Invalid JSON.');
        }
      }

      const meta = await ensureSeed();
      const ctx = { body, url, meta, params: route.params };

      if (!PUBLIC.has(route.name)) {
        const session = unsign(meta.secret, readCookie(req));
        const users = await store.get('users');
        const user = session && session.exp > nowFn().getTime() && users.find((u) => u.id === session.u);
        if (!user || !user.active || (user.tokenVersion || 0) !== session.v) {
          throw new HttpError(401, 'Please sign in.');
        }
        if (ADMIN_ONLY.test(route.name) && user.role !== 'admin') {
          throw new HttpError(403, 'Only the admin can do that.');
        }
        Object.assign(ctx, { user, users, settings: await store.get('settings') });
      }

      const result = await routes[route.name](ctx);
      const hasCookie = result && 'cookie' in result;
      return json(200, hasCookie ? result.data : result, hasCookie ? setCookie(result.cookie, secure) : undefined);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: 'Something went wrong on the server. Please try again.' });
    }
  };
}

function readStudent(body, users) {
  const name = cleanText(body.name);
  if (!name) throw bad('Student name is required.');
  const gender = cleanText(body.gender).toLowerCase();
  if (!['boy', 'girl'].includes(gender)) throw bad('Gender must be boy or girl.');
  const teacherId = cleanText(body.teacherId);
  if (teacherId && !users.some((u) => u.id === teacherId && u.role === 'teacher')) throw bad('Unknown teacher.');
  const phone = cleanText(body.phone, 30);
  if (phone && !/^\+?[0-9][0-9 ()-]{5,}$/.test(phone)) throw bad('Phone number can only use digits, spaces, brackets, dashes and a leading +.');
  return {
    name,
    gender,
    phone,
    teacherId: teacherId || null,
    rollNo: cleanText(body.rollNo, 20),
    className: cleanText(body.className, 40),
  };
}

function assertUniqueRoll(students, rollNo, exceptId) {
  if (rollNo && students.some((s) => s.rollNo === rollNo && s.id !== exceptId)) {
    throw bad(`Roll number ${rollNo} is already used.`);
  }
}

function readTeacher(body, users, exceptId) {
  const name = cleanText(body.name);
  if (!name) throw bad('Teacher name is required.');
  const username = cleanText(body.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw bad('Username must be 3 or more letters or numbers, without spaces.');
  }
  if (users.some((u) => u.username === username && u.id !== exceptId)) throw bad('That username is already taken.');
  const gender = cleanText(body.gender).toLowerCase();
  if (!['male', 'female'].includes(gender)) throw bad('Please choose male or female.');
  return { name, username, gender };
}

function byClassThenName(a, b) {
  return (a.className || '').localeCompare(b.className || '') || a.name.localeCompare(b.name);
}

function readCookie(req) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

function setCookie(value, secure) {
  const maxAge = value ? SESSION_DAYS * 86400 : 0;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function json(status, data, cookie) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (cookie !== undefined) headers['set-cookie'] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}
