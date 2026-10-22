/**
 * Server list for the landing page's server browser.
 *
 * WIRE ME — this is the seam. The UI (TSServerList.vue) is built and
 * rendering; only the data source is stubbed. Return hardcoded entries
 * from `fetchServerList()` until A2S querying lands.
 *
 * The real implementation needs an A2S query (A2S_INFO / 0x54 'T' for
 * GoldSrc) over UDP. Browsers cannot emit UDP, so it cannot go in the
 * browser at all — the query has to happen server-side and be exposed as
 * HTTP, most naturally by extending ts-udp-bridge.js with a
 * GET /servers endpoint that returns A2S replies as JSON.
 *
 * The bridge already answers GET /health with counters, so /servers is a
 * natural addition and the frontend fetch shape below is what that
 * endpoint should return.
 */

/** One row in the server browser. Mirrors the A2S_INFO reply fields. */
export interface TsServer {
  /** Stable key for the v-for. Use `${address}:${port}`. */
  id: string;
  /** A2S_INFO name. */
  name: string;
  /** A2S_INFO map, human-readable ("de_ts_casa" -> "ts_casa"). */
  map: string;
  /** A2S_INFO game rules, human-readable ("deathmatch" -> "DeathMatch"). */
  mode: string;
  /** A2S_PLAYERCOUNT players / A2S_MAXPLAYERS max_players. */
  players: number;
  maxPlayers: number;
  /** Where the browser's WebSocket bridge should point for this server. */
  address: string;
  port: number;
}

/**
 * Placeholder data so the browser tab is demonstrable before the A2S
 * path exists. `players`/`maxPlayers` are what the UI renders in the
 * counter — they are marked 0/8 so it is obvious they are not real.
 */
const STUB_SERVERS: TsServer[] = [
  {
    id: '100.95.111.112:27015',
    name: 'TS Mod Test Server (rust-port)',
    map: 'ts_casa',
    mode: 'DeathMatch',
    players: 0,
    maxPlayers: 8,
    address: '100.95.111.112',
    port: 27015,
  },
  {
    id: 'example:27015',
    name: 'Local Dev Server',
    map: 'ts_lobby',
    mode: 'DeathMatch',
    players: 0,
    maxPlayers: 8,
    address: '127.0.0.1',
    port: 27015,
  },
];

export async function fetchServerList(): Promise<TsServer[]> {
  // TODO: GET /servers from the bridge once it answers A2S.
  return STUB_SERVERS;
}

/**
 * Launch options string that joins `server`.
 *
 * NOTE: the engine's `-noip`/`-noip6` flags must never appear here.
 * They set `net.allow_ip = !Sys_CheckParm("-noip")` in the engine, and
 * with both present the engine prints `TCP/IP Disabled.` and returns
 * before ever calling socket() — `+connect` then has no socket to send
 * on, and the failure is indistinguishable from a dead transport.
 */
export function launchOptionsFor(server: TsServer): string {
  return `-game ts +connect ${server.address}:${server.port} +maxplayers ${server.maxPlayers}`;
}