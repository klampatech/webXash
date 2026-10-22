/**
 * A2S server queries for the landing page's server browser.
 *
 * WHY A VITE PLUGIN AND NOT THE WS/UDP BRIDGE
 * ------------------------------------------
 * The page is served over HTTPS (CheerpX needs cross-origin isolation)
 * while ts-udp-bridge.js speaks plain HTTP on :27017. A browser blocks that
 * fetch as mixed content. Serving the query from the same origin as the
 * page removes CORS and mixed-content from the problem entirely.
 *
 * A browser still cannot emit UDP, so this must run in Node — which is
 * what a Vite plugin is. `vite build` will not run this; the endpoint is
 * dev-server only until a real deploy target exists (see the repo README).
 *
 * WHY TWO QUERIES
 * ---------------
 * GoldSrc does not answer A2S_INFO (0x49 'I') — that is the Source
 * protocol. A HL1 server answers the classic handshake string with 0x6D
 * 'm' (A2S_PLAYER_RULES), which carries name/map/folder/game but NOT a
 * player count. Player counts come from a separate 0x55 'U' query.
 * Sending only the handshake and reading players out of it yields zeros.
 */

import dgram from 'node:dgram';

const A2S_MAGIC = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const A2S_INFO_PAYLOAD = Buffer.concat([
  A2S_MAGIC,
  Buffer.from('TSource Engine Query\0', 'ascii'),
]);
const A2S_PLAYER_COUNT_PAYLOAD = Buffer.concat([A2S_MAGIC, Buffer.from('U', 'ascii')]);

const QUERY_TIMEOUT_MS = 1200;

/** Read a NUL-terminated string starting at `offset`; returns null if none. */
function readZString(buf, offset) {
  const end = buf.indexOf(0, offset);
  if (end === -1) return null;
  return { value: buf.toString('utf8', offset, end), next: end + 1 };
}

/**
 * Parse an A2S_PLAYER_RULES ('m') reply.
 *   string address, string name, string map, string folder, string game
 */
function parseRules(buf) {
  if (buf.length < 5 || buf.readUInt32BE(0) !== 0xffffffff) return null;
  if (buf[4] !== 0x6d /* 'm' */) return null;
  let o = 5;
  const address = readZString(buf, o);
  if (!address) return null;
  o = address.next;
  const name = readZString(buf, o);
  if (!name) return null;
  o = name.next;
  const map = readZString(buf, o);
  if (!map) return null;
  o = map.next;
  readZString(buf, o); // folder — unused
  const game = readZString(buf, o + 0);
  return {
    name: name.value || 'Unnamed server',
    map: map.value || 'unknown',
    game: game?.value ?? '',
  };
}

/** Parse a Source A2S_INFO ('I') reply, in case the peer is not GoldSrc. */
function parseInfo(buf) {
  if (buf.length < 6 || buf.readUInt32BE(0) !== 0xffffffff) return null;
  if (buf[4] !== 0x49 /* 'I' */) return null;
  let o = 6; // magic + type + protocol byte
  const name = readZString(buf, o);
  if (!name) return null;
  o = name.next;
  const map = readZString(buf, o);
  if (!map) return null;
  const folder = readZString(buf, map.next);
  if (!folder) return null;
  const game = readZString(buf, folder.next);
  if (!game) return null;
  // appid is a uint16 after the game string
  o = game.next + 2;
  const players = buf[o];
  const maxPlayers = buf[o + 1];
  return {
    name: name.value || 'Unnamed server',
    map: map.value || 'unknown',
    game: game.value,
    players,
    maxPlayers,
  };
}

/** One request/response round trip on a throwaway socket. */
function query(host, port, payload, timeoutMs = QUERY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    sock.on('error', () => done(null));
    sock.on('message', (msg) => done(msg));
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    sock.send(payload, port, host, (err) => {
      if (err) done(null);
    });
  });
}

/**
 * The HL1 rules string, e.g. "The Specialists v3.0.8 (DM)", is the most
 * informative mode indicator the server exposes — prefer it over guessing
 * from cvars.
 */
function modeFromGame(game) {
  const m = /\(([^)]+)\)/.exec(game ?? '');
  if (m) return m[1];
  if (/specialists/i.test(game ?? '')) return 'Specialists';
  return 'DeathMatch';
}

/** Query one server. Resolves to null if it does not answer in time. */
export async function queryServer(address, port, id, publicAddress) {
  const raw = await query(address, port, A2S_INFO_PAYLOAD);
  if (!raw) return null;

  const info = parseInfo(raw);
  let name;
  let map;
  let game;
  let players = 0;
  let maxPlayers = 0;

  if (info) {
    ({ name, map, game, players, maxPlayers } = info);
  } else {
    const rules = parseRules(raw);
    if (!rules) return null;
    ({ name, map, game } = rules);
    // GoldSrc carries no player count in 'm' — ask separately.
    const counts = await query(address, port, A2S_PLAYER_COUNT_PAYLOAD);
    if (counts && counts.length >= 6 && counts.readUInt32BE(0) === 0xffffffff) {
      players = counts[5];
      maxPlayers = counts[6];
    }
  }

  return {
    id: id ?? `${address}:${port}`,
    name,
    map,
    mode: modeFromGame(game),
    players,
    maxPlayers: maxPlayers || 0,
    address,
    port,
    // Omitted when it matches the queried address, so the browser only
    // ever sees a rewrite when one is genuinely needed.
    ...(publicAddress && publicAddress !== address ? { publicAddress } : {}),
  };
}

/** Vite plugin: GET <base>api/servers -> { servers: [...] } */
export function a2sServerListPlugin({ targets }) {
  const list = Array.isArray(targets) ? targets : [];
  return {
    name: 'ts-a2s-server-list',
    configureServer(server) {
      server.middlewares.use('/webXash/api/servers', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const results = await Promise.all(
            list.map((t) =>
              queryServer(t.host, t.port, t.id, t.publicAddress).catch(() => null),
            ),
          );
          // A server that does not answer is not an error — just absent.
          res.end(JSON.stringify({ servers: results.filter(Boolean) }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err), servers: [] }));
        }
      });
    },
  };
}