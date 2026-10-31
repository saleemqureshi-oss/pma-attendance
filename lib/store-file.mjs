// Stores each key as a JSON file. Used on ordinary Node web hosting and for local runs.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function fileStore(dir) {
  const fileFor = (key) => path.join(dir, `${encodeURIComponent(key)}.json`);
  let ready;
  const ensureDir = () => (ready ??= mkdir(dir, { recursive: true }));

  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(fileFor(key), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async set(key, value) {
      await ensureDir();
      // Write then rename, so a crash mid-write cannot leave a half-written file.
      const tmp = `${fileFor(key)}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, fileFor(key));
    },
    async delete(key) {
      await rm(fileFor(key), { force: true });
    },
    async list(prefix) {
      await ensureDir();
      return (await readdir(dir))
        .filter((f) => f.endsWith('.json'))
        .map((f) => decodeURIComponent(f.slice(0, -5)))
        .filter((key) => key.startsWith(prefix));
    },
  };
}
