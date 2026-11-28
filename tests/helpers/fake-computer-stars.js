export function fakeComputerStars(records = []) {
  const stars = new Map(records.map((record) => [record.id, record]));
  let sequence = Math.max(0, ...records.map(({ seq }) => seq));
  const requests = [];
  const success = (data) => Response.json({ ok: true, data });
  const failure = (status = 500) => Response.json({ ok: false, error: { message: 'Disk full' } }, { status });
  const server = {
    stars, requests, failRead: false, failWrite: () => false, replyToWrite: success,
    fetch(path, options) {
      if (path === '/api/v1/session') return success({ token: 'local-stars' });
      if (path !== '/api/v1/computer/stars') throw new Error(`Unexpected request ${path}`);
      if (options.method === 'GET') {
        requests.push({ method: 'GET' });
        return server.failRead ? failure() : success({ stars: [...stars.values()], count: stars.size });
      }
      const { add = [], remove = [] } = JSON.parse(options.body);
      requests.push({ method: 'POST', add, remove });
      const refused = server.failWrite(add, remove);
      if (refused) return failure(Number(refused) || 500);
      if (add.length + remove.length > 2_000 || new TextEncoder().encode(options.body).byteLength > 1024 * 1024) {
        return failure(400);
      }
      const updates = new Map(add.map(({ id, snap }) => [id, snap]));
      const fresh = [...updates.keys()].filter((id) => !stars.has(id));
      sequence += fresh.length;
      const positions = new Map(fresh.map((id, index) => [id, sequence - index]));
      const added = [...updates].map(([id, snap]) => {
        const { t, seq } = stars.get(id) || { t: 1234, seq: positions.get(id) };
        stars.set(id, { id, t, seq, snap });
        return { id, t, seq };
      });
      const removed = remove.filter((id) => stars.delete(id));
      return server.replyToWrite({ added, removed, count: stars.size }, { add, remove });
    },
  };
  return server;
}
