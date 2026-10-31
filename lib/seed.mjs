// First-run sample data so the demo has something to show. The admin removes it
// with one click in Settings before entering real students.
import { clock, hashPassword } from './core.mjs';

const DEFAULT_TIMEZONE = 'America/Regina'; // Saskatoon, SK: no daylight saving

const TEACHERS = [
  { id: 't1', name: 'Ustad Ahmed', username: 'ahmed', gender: 'male', className: 'Hifz Boys A' },
  { id: 't2', name: 'Ustad Bilal', username: 'bilal', gender: 'male', className: 'Hifz Boys B' },
  { id: 't3', name: 'Ustad Hamza', username: 'hamza', gender: 'male', className: 'Nazra Boys' },
  { id: 't4', name: 'Ustazah Aisha', username: 'aisha', gender: 'female', className: 'Hifz Girls' },
  { id: 't5', name: 'Ustazah Maryam', username: 'maryam', gender: 'female', className: 'Nazra Girls' },
];

const BOYS = ['Abdullah', 'Ibrahim', 'Yusuf', 'Umar', 'Ali', 'Hassan', 'Hussain', 'Zaid', 'Hamza', 'Bilal', 'Usman', 'Idris', 'Musa', 'Isa', 'Khalid', 'Tariq', 'Saad', 'Salman', 'Yahya', 'Anas'];
const GIRLS = ['Fatima', 'Aisha', 'Maryam', 'Khadija', 'Zainab', 'Hafsa', 'Sumayya', 'Ruqayya', 'Safiya', 'Asma', 'Amina', 'Sara', 'Hajar', 'Laila', 'Noor', 'Huda', 'Iman', 'Salma', 'Yusra', 'Maimuna'];
const FAMILIES = ['Khan', 'Ahmed', 'Qureshi', 'Siddiqui', 'Ansari', 'Sheikh', 'Malik', 'Farooqi'];

const REMARKS_ABSENT = ['Sick', 'Family travel', 'No message from parents', 'Doctor appointment'];
const REMARKS_LATE = ['Arrived 10 minutes late', 'School bus delay', 'Arrived after Asr', ''];

export async function buildSeed(now) {
  // Set these on the host so a live site never starts with passwords published in the repo.
  const adminEnv = process.env.PMA_ADMIN_PASSWORD;
  const teacherEnv = process.env.PMA_TEACHER_PASSWORD;
  const adminPassword = await hashPassword(adminEnv || 'admin123');
  const teacherPassword = await hashPassword(teacherEnv || 'teacher123');

  const users = [
    { id: 'admin', name: 'Administrator', username: 'admin', role: 'admin', gender: 'male', active: true, defaultPassword: !adminEnv, tokenVersion: 0, password: adminPassword },
    ...TEACHERS.map(({ className, ...t }) => ({ ...t, role: 'teacher', active: true, defaultPassword: !teacherEnv, tokenVersion: 0, password: teacherPassword })),
  ];

  let n = 0;
  const students = TEACHERS.flatMap((t, ti) =>
    Array.from({ length: 20 }, (_, i) => {
      n += 1;
      const firsts = t.gender === 'male' ? BOYS : GIRLS;
      return {
        id: `s${String(n).padStart(3, '0')}`,
        name: `${firsts[i]} ${FAMILIES[(i + ti * 3) % FAMILIES.length]}`,
        rollNo: String(100 + n),
        gender: t.gender === 'male' ? 'boy' : 'girl',
        className: t.className,
        teacherId: t.id,
        active: true,
      };
    }),
  );

  const settings = {
    madarsahName: 'PMA Attendance',
    startTime: '17:30',
    days: [1, 2, 3, 4, 5],
    timezone: DEFAULT_TIMEZONE,
    enforceSchedule: true,
  };

  // Ten earlier class days of plausible history, so reports are not empty in a demo.
  const attendance = {};
  const today = clock(DEFAULT_TIMEZONE, now).date;
  const cursor = new Date(`${today}T00:00:00Z`);
  let filled = 0;
  let tick = 7;
  const pick = (list) => list[(tick = (tick * 31 + 11) % 1009) % list.length];
  while (filled < 10) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const day = cursor.getUTCDay();
    if (day === 0 || day === 6) continue;
    filled += 1;
    const date = cursor.toISOString().slice(0, 10);
    const at = cursor.getTime() + 18 * 3600000;
    for (const teacher of TEACHERS) {
      const shard = {};
      for (const s of students.filter((st) => st.teacherId === teacher.id)) {
        tick = (tick * 31 + 11) % 1009;
        const roll = tick % 100;
        if (roll < 8) shard[s.id] = { status: 'absent', remark: pick(REMARKS_ABSENT), by: teacher.id, at };
        else if (roll < 18) shard[s.id] = { status: 'late', remark: pick(REMARKS_LATE), by: teacher.id, at };
        else shard[s.id] = { status: 'present', remark: '', by: teacher.id, at };
      }
      attendance[`att/${date}/${teacher.id}`] = shard;
    }
  }

  return { users, students, settings, attendance };
}
