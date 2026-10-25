/**
 * Server list for the landing page's server browser.
 *
 * Backed by a real A2S query — see `vite-a2s-plugin.mjs` for why it runs
 * in Node behind a same-origin Vite middleware rather than here: a browser
 * cannot emit UDP, and the page is HTTPS while ts-udp-bridge.js speaks
 * plain HTTP, so a direct fetch would be blocked as mixed content.
 *
 * GoldSrc does not answer A2S_INFO — that is the Source protocol. A HL1
 * server answers the classic handshake with 'm' (rules), which carries
 * name/map/folder/game but no player count, so a second 'U' query is
 * needed for counts. Reading players out of the handshake alone yields
 * zeros, which is how the first version of this file showed a live server
 * reporting 0/8.
 *
 * Replaces STUB_SERVERS, which rendered a fake 0/8 count and a localhost
 * row for a server that does not exist.
 */

/** One row in the server browser. Mirrors the A2S reply fields. */
export interface TsServer {
  /** Stable key for the v-for. */
  id: string;
  name: string;
  map: string;
  mode: string;
  players: number;
  maxPlayers: number;
  /** Address the query was sent to, as seen from this host. */
  address: string;
  port: number;
  /**
   * Address a *browser* should connect to, when `address` is not reachable
   * from outside. A server queried over `127.0.0.1` reports `127.0.0.1`,
   * and joining that from a remote browser can never work — the engine
   * filters inbound datagrams against `cls.serveradr` and would discard
   * every reply as coming from the wrong peer.
   */
  publicAddress?: string;
  /**
   * Real human players on the server.
   *
   * Distinct from `players`, which A2S reports as players PLUS bots —
   * and which also includes client slots whose browsers have disconnected
   * but have not timed out yet. The registry reports the true count.
   */
  humans?: number;
  /** Bots on the server. `players` is humans PLUS bots. */
  bots?: number;
  /** Engine tickrate, as the registry measured it. */
  tickrate?: number;
  /**
   * Seconds left on the current map, as the server itself counts them.
   *
   * The registry reads the TS server's `mp_timeleft` cvar from its console
   * — the same way it reads the tickrate — and publishes it with the
   * timestamp it was measured at. The browser counts it down locally from
   * the moment it received the payload, so a twenty-second poll does not
   * make the countdown jump in twenty-second steps.
   */
  mapSecondsLeft?: number;
  /** The registry got an answer from this server recently. */
  responsive?: boolean;
  /** The server answers, but badly. */
  degrading?: boolean;
  /** The registry's own data for this server is old. */
  stale?: boolean;
}

/** Distinguishes a transport failure from a genuinely empty server list. */
export class ServerListError extends Error {}

const ENDPOINT = 'api/servers';

/** The server list, and how long it took to arrive. */
export interface ServerList {
  servers: TsServer[];
  /**
   * The user's round-trip time to the machine that runs the game server,
   * in milliseconds.
   *
   * WHY THE BROWSER MEASURES IT AND NOT THE SERVER
   * ----------------------------------------------
   * The obvious source is the A2S query, which is where a "ping" normally
   * comes from. But the registry queries the server over LOOPBACK — the
   * game server is on the same host as the registry — so an A2S round trip
   * measured there is always about a tenth of a millisecond and says
   * nothing about how far the player is from the machine.
   *
   * What the player actually wants to know is how far THEY are. And the
   * page is already talking to that machine: it fetches this very list
   * from it, over the same origin, through the same reverse proxy the
   * game traffic goes through. So the time for that fetch to come back is
   * the player's ping, measured for the player.
   *
   * It is the time to the response HEADERS, so the server's own work is
   * included — a few milliseconds on the registry, which is honest.
   */
  pingMs: number | null;
}

export async function fetchServerList(): Promise<ServerList> {
  let res: Response;
  const started = performance.now();
  try {
    res = await fetch(ENDPOINT, { cache: 'no-store' });
  } catch {
    throw new ServerListError('Could not reach the server list endpoint');
  }
  // Measured here, not after the body is parsed: `fetch` resolves when the
  // response headers arrive, so this is the round trip and nothing else.
  const pingMs = Math.round(performance.now() - started);
  if (!res.ok) {
    throw new ServerListError(`Server list failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { servers?: TsServer[] };
  return {
    servers: Array.isArray(body.servers) ? body.servers : [],
    pingMs,
  };
}

/**
 * Launch options string that joins `server`.
 *
 * NOTE: the engine's `-noip`/`-noip6` flags must never appear here. They
 * set `net.allow_ip = !Sys_CheckParm("-noip")` in the engine, and with both
 * present the engine prints `TCP/IP Disabled.` and returns before ever
 * calling socket() — `+connect` then has no socket to send on, and the
 * failure is indistinguishable from a dead transport.
 */
/**
 * Where the browser opens the WebSocket to the bridge, as `host:port`.
 *
 * In production the bridge sits behind the SAME reverse proxy as the page,
 * and it has to: a page served over HTTPS cannot open a plain `ws://`
 * WebSocket (the browser blocks it as mixed content), and a cross-origin
 * WebSocket cannot carry the page's cross-origin-isolation context, which
 * the WASM engine needs for SharedArrayBuffer. So the default is the
 * page's own host.
 *
 * Dev is the exception — the Vite dev server is on :5174 and the bridge on
 * :27017 — so the dev build sets VITE_BRIDGE_ADDRESS.
 */
export function bridgeAddress(): string {
  const configured = import.meta.env.VITE_BRIDGE_ADDRESS;
  if (configured) return configured;
  if (typeof location === 'undefined' || !location.hostname) return '';
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  return `${location.hostname}:${port}`;
}

/**
 * Pick the server a PLAY should join.
 *
 * PLAY must never fall back to a hard-coded address. The store's default
 * launch options carry a DEVELOPMENT address (127.0.0.1), and from a
 * browser that means the PLAYER'S OWN MACHINE — not the server. That is
 * not hypothetical: it is what shipped, and it failed at the very last
 * step with "Could not reach the game server", after the whole engine
 * had booted, because the bridge correctly refused an address that was
 * not the production one.
 *
 * So the target comes from the same list the Join button uses. One
 * source of truth for "where does a player go" — which is the only way
 * the two buttons can be kept from diverging again.
 *
 * Preference: servers with room first, and among those the one with the
 * FEWEST humans. TS is an FFA deathmatch — players want company, not
 * empty servers, so spreading them thin is the wrong default.
 */
export async function resolveLaunchTarget(): Promise<TsServer | null> {
  const { servers } = await fetchServerList();
  if (!servers.length) return null;
  return [...servers].sort((a, b) => {
    const humansA = a.humans ?? a.players ?? 0;
    const humansB = b.humans ?? b.players ?? 0;
    const roomA = (a.maxPlayers || 0) - humansA;
    const roomB = (b.maxPlayers || 0) - humansB;
    // A server with no room goes last, however few humans it has.
    if ((roomA > 0) !== (roomB > 0)) return roomB > 0 ? 1 : -1;
    if (humansA !== humansB) return humansA - humansB;
    return a.id.localeCompare(b.id);
  })[0];
}

export function launchOptionsFor(server: TsServer): string {
  const host = server.publicAddress ?? server.address;
  const parts = [
    '-game ts',
    `+connect ${host}:${server.port}`,
    `+maxplayers ${server.maxPlayers || 8}`,
  ];

  // Only in the production topology. In dev the loader derives the bridge
  // address from the game IP and `+bridgeport`, which is correct there;
  // naming a bridge explicitly would point the browser at the dev server's
  // own port instead of the bridge's.
  const bridge = bridgeAddress();
  const secure = typeof location !== 'undefined' && location.protocol === 'https:';
  if (bridge && (import.meta.env.VITE_BRIDGE_ADDRESS || secure)) {
    parts.push(`+bridge ${bridge}`);
  }

  return parts.join(' ');
}