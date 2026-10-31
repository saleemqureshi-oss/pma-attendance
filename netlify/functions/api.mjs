import { getStore } from '@netlify/blobs';
import { createApi } from '../../lib/core.mjs';

function blobStore() {
  const blobs = getStore({ name: 'pma-attendance', consistency: 'strong' });
  return {
    get: (key) => blobs.get(key, { type: 'json' }),
    set: (key, value) => blobs.setJSON(key, value),
    delete: (key) => blobs.delete(key),
    list: async (prefix) => (await blobs.list({ prefix })).blobs.map((b) => b.key),
  };
}

export default (req) => createApi(blobStore())(req);

export const config = { path: '/api/*' };
