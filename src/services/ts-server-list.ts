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
}

/** Distinguishes a transport failure from a genuinely empty server list. */
export class ServerListError extends Error {}

const ENDPOINT = 'api/servers';

export async function fetchServerList(): Promise<TsServer[]> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, { cache: 'no-store' });
  } catch {
    throw new ServerListError('Could not reach the server list endpoint');
  }
  if (!res.ok) {
    throw new ServerListError(`Server list failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { servers?: TsServer[] };
  return Array.isArray(body.servers) ? body.servers : [];
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
export function launchOptionsFor(server: TsServer): string {
  const host = server.publicAddress ?? server.address;
  return `-game ts +connect ${host}:${server.port} +maxplayers ${server.maxPlayers || 8}`;
}