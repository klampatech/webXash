// xash-bridge.ts — Xash3D transport for a single dedicated UDP server.
//
// WHY THIS EXISTS
// ---------------
// webXash's multiplayer is built around WebRTC data channels between
// TWO browsers (xash-webrtc.ts). The WASM engine has no real UDP —
// sockets are emulated in JS by `xash3d-fwgs`'s `Net` class. The
// engine calls `Net.sendto(...)` for every UDP datagram, and reads via
// `Net.recvfrom()`. WebRTC transport routes those bytes to a remote
// BROWSER peer over a WebRTC data channel.
//
// Connecting to a real dedicated UDP server requires something
// different: the data-channel hop is replaced with a WebSocket to a
// Node.js bridge (scripts/ts-udp-bridge.js) that forwards each
// WebSocket binary frame to / from UDP 27015 of an FWGS xash server.
//
// This class plugs into that wiring without going through WebRTC at
// all. The engine's own `+connect <ip:port>` is honored because the
// WASM engine holds the destination until the kernel buffers are
// flushed; we just forward raw datagrams both ways and let the engine
// handle its own handshake protocol.

import {
  type Packet,
  Xash3D,
  type Xash3DOptions,
  Net as NetImpl,
} from 'xash3d-fwgs';
import { logDebug, logTrace } from './debug-log';

export interface Xash3DBridgeOptions extends Xash3DOptions {
  /**
   * Bridge address. Format: `host:port`. The bridge MUST speak
   *     WebSocket-binary on `/ws`. See scripts/ts-udp-bridge.js.
   */
  bridgeAddress?: string;

  /**
   * Called when the connection to the game server goes away.
   *
   * The engine keeps running when the WebSocket closes — it simply stops
   * receiving packets, so the world freezes mid-game with no message and
   * no way back. Something outside the engine has to notice and say so.
   */
  onDisconnect?: (reason: string) => void;
  /**
   * The dedicated server's real `ip:port` as named in `+connect`.
   * Attributed as the source address on every inbound packet — see
   * parseIpPort()'s doc comment for why a loopback placeholder does
   * not work here. Optional only so single-player construction stays
   * type-compatible with the base class; a bridge with no server
   * address is useless.
   */
  serverAddress?: string;
}

/**
 * Source address attributed to packets coming BACK from the dedicated
 * server through the bridge.
 *
 * CRITICAL — this must be the **real game server's** address: exactly
 * what `+connect <ip>:<port>` named. It must NOT be a loopback
 * placeholder. The engine's client-side packet filter is
 *
 *   cl_main.c: CL_IsFromConnectingServer( netadr_t from )
 *     return NET_IsLocalAddress( from )          // NA_LOOPBACK only
 *         || NET_CompareAdr( cls.serveradr, from );  // exact ip:port
 *
 * and it gates every single inbound connectionless packet on that
 * (CL_HandleTestPacket, CL_ParseServerPacket, the S2C_CHALLENGE
 * handler, …). `cls.serveradr` is whatever `+connect` resolved to.
 * Tag replies `127.0.0.1:8080` and every one of them is silently
 * dropped: the engine keeps retransmitting its challenge, the server
 * keeps answering, and the browser console shows only
 * `Connecting to <ip> (retry #N)` forever with no other symptom.
 *
 * `NET_SockadrToNetadr` never maps 127.0.0.1 to NA_LOOPBACK (it keys
 * off address *family* only), so the `NET_IsLocalAddress` escape hatch
 * does not fire for a spoofed 127.0.0.1 sockaddr either. There is no
 * placeholder that works — it has to be the real peer.
 *
 * The WebRTC transport gets away with `127.0.0.1:8080` because its
 * remote peer is genuinely a loopback peer-to-peer client. A
 * dedicated server is not.
 */
function parseIpPort(addr: string): { ip: [number, number, number, number]; port: number } | null {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d+)$/);
  if (!m) return null;
  return {
    ip: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])],
    port: Number(m[5]),
  };
}

/**
 * The `Net` class shipped in xash3d-fwgs implements `socket`, `bind`,
 * `closesocket`, `sendto`, `sendtoBatch`, `recvfrom`, `getaddrinfo`,
 * `gethostbyname`, `gethostname`, `getsockname` — but NOT `connect`,
 * and it exposes the batch send under camelCase (`sendtoBatch`).
 *
 * The generated WASM glue imports BOTH:
 *
 *   emscripten_net_connect: (fd, sa, sl) => Module.net?.connect?.(...) ?? -1
 *   emscripten_net_sendto_batch: (…) => Module.net?.sendto_batch?.(...) ?? -1
 *
 * GoldSrc's `NET_OpenIP`/`NET_Connect` calls `connect(2)` on its UDP
 * socket before the first `sendto`. Because `Module.net.connect` is
 * undefined, that returns -1 and the engine treats the socket as
 * unusable — it retries forever and never reaches the `sendto` path.
 * Same for `sendto_batch` (snake_case) which the glue asks for but
 * `Net` spells `sendtoBatch`.
 *
 * Both are patched on below. `connect` is a no-op success for UDP —
 * an unconnected UDP socket is valid, and every `sendto` carries its
 * own destination sockaddr, which the bridge already ignores (it has a
 * single fixed upstream). We only need to record the peer for logging
 * and for `getsockname`.
 */
class BridgeNet extends NetImpl {
  /**
   * Swap the package's lossy rolling buffer for our lossless queue.
   *
   * The package's `Net` constructor builds
   * `this.incoming = new RollingBuffer({ maxSize: maxPackets })` and
   * that buffer drops the OLDEST packet when it is full — which, in a
   * protocol where every packet carries a sequence number, is a
   * guaranteed "Connection Interrupted" freeze. See
   * {@link LosslessPacketQueue} for the whole story.
   */
  constructor(sender: unknown, opts: Record<string, unknown> = {}) {
    super(sender as never, opts as never);
    (this as unknown as { incoming: unknown }).incoming = new LosslessPacketQueue();
  }

  /** fd -> last peer address, for getsockname + diagnostics. */
  private peers = new Map<number, { ip: number[]; port: number }>();
  /** Count of recvfrom pulls — wrap-around so logs stay finite. */
  private recvLogged = 0;

  override socket(family: number, type: number, protocol: number): number {
    logDebug(`[bridge-net] socket(${family}, ${type}, ${protocol})`);
    return super.socket(family, type, protocol);
  }

  /**
   * POSIX `connect(2)`. For a datagram socket this is legal without a
   * peer and the kernel just filters sends to the connected address —
   * which is precisely what our single-upstream bridge already does.
   * Returning 0 (success) is therefore correct and is what unblocks
   * the engine's connect path.
   */
  connect(fd: number, sockaddrPtr: number, _socklenPtr: number): number {
    if (this.em && sockaddrPtr) {
      const [ip, port] = this.readSockaddrFast(sockaddrPtr);
      this.peers.set(fd, { ip, port });
      logDebug(
        `[bridge-net] connect(fd=${fd}) -> ${ip.join('.')}:${port} (accepted)`
      );
    } else {
      logDebug(`[bridge-net] connect(fd=${fd}) (accepted)`);
    }
    return 0;
  }

  /** snake_case alias the WASM glue actually calls. */
  sendto_batch(
    fd: number,
    bufsPtr: number,
    lensPtr: number,
    count: number,
    flags: number,
    sockaddrPtr: number,
    socklenPtr: number
  ): number {
    return this.sendtoBatch(fd, bufsPtr, lensPtr, count, flags, sockaddrPtr, socklenPtr);
  }

  /**
   * Log whether the engine is actually draining `incoming`. `recvfrom`
   * is the ONLY way an inbound datagram reaches the game — if this
   * returns -1 with an empty buffer forever while the bridge reports
   * `packetsToClient > 0`, packets are being enqueued but the engine
   * never polls, which is a different failure than the engine
   * discarding them after a successful read (address mismatch).
   */
  override recvfrom(
    fd: number,
    bufPtr: number,
    bufLen: number,
    flags: number,
    sockaddrPtr: number,
    socklenPtr: number
  ): number {
    const n = super.recvfrom(fd, bufPtr, bufLen, flags, sockaddrPtr, socklenPtr);
    if (this.recvLogged < 60) {
      this.recvLogged++;
      if (n >= 0) {
        const head = new Uint8Array(this.em!.HEAPU8.buffer, bufPtr, Math.min(8, n));
        let hex = '';
        for (let i = 0; i < head.length; i++) hex += head[i].toString(16).padStart(2, '0');
        logTrace(`[bridge-recv] GOT ${n}B head=${hex}`);
      }
    }
    return n;
  }

  override getsockname(
    fd: number,
    sockaddrPtr: number,
    socklenPtr: number
  ): number {
    const peer = this.peers.get(fd);
    if (!peer || !this.em) return -1;
    // Same sockaddr layout `recvfrom` writes above.
    const heap8 = this.em.HEAP8;
    const heap16 = this.em.HEAP16;
    heap16[sockaddrPtr >> 1] = 2; // AF_INET
    heap8[sockaddrPtr + 2] = (peer.port >> 8) & 0xff;
    heap8[sockaddrPtr + 3] = peer.port & 0xff;
    for (let i = 0; i < 4; i++) heap8[sockaddrPtr + 4 + i] = peer.ip[i];
    this.em.HEAP32[socklenPtr >> 2] = 16;
    return 0;
  }
}

/**
 * A LOSSLESS inbound packet queue.
 *
 * WHY THIS EXISTS
 * ---------------
 * xash3d-fwgs's `Net` hands inbound datagrams to the engine through a
 * `RollingBuffer` with `maxSize: maxPackets` — 128 by default — and
 * that buffer's `push()` DROPS THE OLDEST PACKET when it is full:
 *
 *   push(item) {
 *     if (this.isFull()) this.tail = (this.tail + 1) % this.opts.maxSize;
 *     else this.count += 1;
 *     ...
 *   }
 *
 * Every GoldSrc packet carries a sequence number, so losing one leaves
 * a GAP. The client cannot carry on across a gap: it discards the
 * out-of-sequence packets that follow, asks the server to resend, and
 * if the server is still bursting, the resends overflow the queue too.
 * The visible result is the classic GoldSrc **"Connection
 * Interrupted"** state — the HUD freezes, the connection timer starts
 * counting, and the player is sitting in a dead world until they
 * refresh.
 *
 * The bursts are exactly the events that matter:
 *
 *   - a client joining      → the server sends everyone a full update
 *   - a bot leaving         → same (the entity set changed)
 *   - a map change          → the whole new map's entities
 *
 * None of those fit in 128 packets when the browser drains them at
 * frame rate and the tab is anything less than perfectly busy. This
 * was reproduced against the dedicated server: a second client joined,
 * and the first client's world froze for minutes — until the next map
 * change re-synced the channel.
 *
 * SO: GROW INSTEAD OF DROP. The queue starts at the package's 128 and
 * doubles as needed. The cap is a backstop against a runaway flood
 * (and it logs when it is hit, because at that point the client is
 * already in trouble); a GoldSrc packet is at most ~1400 bytes, so
 * 16384 of them is ~23 MB — far more than any real burst.
 */
export class LosslessPacketQueue {
  private items: unknown[] = [];
  private head = 0;
  /** The high-water mark of the queue depth, for diagnostics. */
  highWater = 0;
  /** How many packets have been enqueued in total. */
  enqueued = 0;
  /** How many have been pulled by the engine in total. */
  pulled = 0;

  constructor(
    initial = 128,
    private readonly cap = 16384
  ) {
    // Pre-size so the first burst does not reallocate a dozen times.
    this.items = new Array(initial);
    this.items.length = 0;
  }

  get length(): number {
    return this.items.length - this.head;
  }

  /** The package's API: `push` and `enqueue` are the same thing. */
  push(item: unknown): void {
    this.enqueue(item);
  }

  enqueue(item: unknown): void {
    this.items.push(item);
    this.enqueued += 1;
    const depth = this.length;
    if (depth > this.highWater) this.highWater = depth;
    if (depth > this.cap) {
      // The backstop. Dropping the OLDEST is what the package does and
      // it is what causes the freeze, so drop the NEWEST instead: the
      // client then misses the tail of the stream rather than the
      // middle of it, and a missing tail still leaves the sequence
      // numbers before it intact.
      this.items.splice(this.head, 1);
      this.items.push(item);
      console.warn(
        `[bridge] inbound queue hit the ${this.cap}-packet cap — the client is falling behind the server`
      );
    }
  }

  pull(): unknown {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head++];
    this.pulled += 1;
    // Keep the backing array from growing without bound.
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  peek(): unknown {
    return this.head < this.items.length ? this.items[this.head] : undefined;
  }

  isEmpty(): boolean {
    return this.head >= this.items.length;
  }

  isFull(): boolean {
    return this.length >= this.cap;
  }
}

export class Xash3DBridge extends Xash3D {
  private ws?: WebSocket;
  private readonly bridgeAddress: string;
  // Throttle the [bridge-send] per-packet log once we've confirmed
  // bidirectional traffic. Keep emitting forever — but only when the
  // stream *changes*: first 20 packets, then anything that's a new
  // size, then collapse to one log per ~500 ms. With netchan traffic
  // this is what was drowning Kyle's console during M5 bring-up.
  private static readonly PER_PACKET_LOG_LIMIT = 20;
  private static readonly PER_PACKET_LOG_INTERVAL_MS = 500;
  private sentLogged = 0;
  private lastSentLogAt = 0;
  private lastSentSize = -1;
  // Concrete `Net` instance. CRITICAL: this must be ASSIGNED, not merely
  // declared. xash3d-fwgs's generated WASM glue calls
  // `Module.net.sendto(...)` / `Module.net.recvfrom(...)` with a `?? -1`
  // fallback, so when `this.net` is undefined every socket call the
  // engine makes silently returns -1 and NOTHING is ever sent. The base
  // Xash3D class passes `this.net` into the Emscripten module as `net:`
  // (see xash3d.js runEm), so we must build the Net in our constructor,
  // keyed to ourselves as the SendtoSender.
  declare public net: BridgeNet;

  /**
   * The inbound queue's statistics, for diagnostics.
   *
   * `highWater` is the number to watch: it is how deep the queue got.
   * With the package's 128-packet rolling buffer, anything above 128
   * means packets were being dropped, which is the freeze. It is
   * exposed on the instance so a browser session can read it without a
   * debugger attached.
   */
  get queueStats(): {
    depth: number;
    highWater: number;
    enqueued: number;
    pulled: number;
    cap: number;
  } {
    const q = (this.net as unknown as { incoming: LosslessPacketQueue }).incoming;
    return {
      depth: q.length,
      highWater: q.highWater,
      enqueued: q.enqueued,
      pulled: q.pulled,
      cap: 16384,
    };
  }

  /**
   * Real server address (from `+connect <ip>:<port>`) attributed to
   * inbound packets. Resolved in the constructor from `serverAddress`;
   * falls back to the bridge host if not supplied, which is a best
   * guess (when the bridge IS on the server host, the bridge IP and
   * game IP are usually the same). See parseIpPort()'s doc comment
   * for why this needs to be the real peer, not a loopback stub.
   */
  private readonly serverAddress: { ip: [number, number, number, number]; port: number };
  private readonly onDisconnect?: (reason: string) => void;
  /** Once a disconnect is reported, do not report it again. */
  private disconnectReported = false;

  constructor(opts: Xash3DBridgeOptions) {
    super(opts);
    this.bridgeAddress = opts.bridgeAddress ?? '';
    this.onDisconnect = opts.onDisconnect;
    const serverAddr =
      opts.serverAddress ?? this.bridgeAddress.split('/')[0];
    const parsed = parseIpPort(serverAddr);
    if (!parsed) {
      throw new Error(
        `Xash3DBridge: serverAddress required (got "${serverAddr}"); ` +
          'pass the same `+connect <ip>:<port>` value, e.g. ' +
          '"100.95.111.112:27015".'
      );
    }
    this.serverAddress = parsed;
    // `NetImpl` needs a SendtoSender — this class provides `sendto()`.
    // hostname/hostID feed `gethostname()`, which the engine uses for
    // the server browser list; the bridge conventions mirror WebRTC.
    this.net = new BridgeNet(this, { hostname: 'tsbridge', hostID: 1 });
    console.log(
      `[bridge] server=${serverAddr} bridge=${this.bridgeAddress} ` +
        `— inbound packets attributed to ${this.serverAddress.ip.join('.')}:${this.serverAddress.port}`
    );
  }

  async init() {
    // The engine's `runEm()` reads `this.net` synchronously and hands
    // it to Emscripten's `Module.net` — so we MUST already have `net`
    // constructed (the constructor did that) before `super.init()`.
    //
    // The WebSocket layer however can be opening in parallel — the
    // engine tolerates that (it queues outgoing packets and the bridge
    // is up before the first connect-challenge fires). Don't block init
    // on it; fire-and-forget with explicit rejection handling.
    this._connect().catch((err) => {
      console.error('[bridge] connect rejected:', err.message);
    });
    await super.init();
  }

  /**
   * Report the disconnect once.
   *
   * Guarded because a failed connection fires both `onerror` and
   * `onclose`, and the player only needs to be told once.
   */
  private reportDisconnect(reason: string): void {
    if (this.disconnectReported) return;
    this.disconnectReported = true;
    logDebug(`[bridge] disconnect: ${reason}`);
    try {
      this.onDisconnect?.(reason);
    } catch (err) {
      console.error('[bridge] onDisconnect handler threw:', err);
    }
  }

  private _connect(): Promise<void> {
    if (!this.bridgeAddress) {
      throw new Error('Xash3DBridge: bridgeAddress required (host:port)');
    }
    return new Promise((resolve, reject) => {
      // The scheme has to match the page's own. An https:// page cannot
      // open a ws:// WebSocket — the browser blocks it as mixed content —
      // and in production the bridge is behind Caddy on the same domain,
      // so the certificate only matches if we use wss://.
      const secure =
        typeof location !== 'undefined' && location.protocol === 'https:';
      const scheme = secure ? 'wss' : 'ws';
      // Name the game peer so the bridge can pick the right instance. The
      // bridge matches it against its allowlist and refuses anything it
      // does not recognise, so the browser cannot use it to reach an
      // arbitrary UDP endpoint.
      const peer = this.serverAddress
        ? `${this.serverAddress.ip.join('.')}:${this.serverAddress.port}`
        : '';
      const query = peer ? `?address=${encodeURIComponent(peer)}` : '';
      const url = `${scheme}://${this.bridgeAddress}/bridge${query}`;
      const ws = new WebSocket(url);
      // The `ws` (the WebSocket we open) MUST be a binary stream,
      // because we hand the raw engine datagrams straight in.
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => {
        console.error('[bridge] WebSocket error', e);
        this.reportDisconnect('Could not reach the game server.');
        reject(new Error(`WebSocket failed: ${url}`));
      };
      ws.onclose = (ev) => {
        // A close AFTER a successful open means the server went away —
        // the orchestrator restarting it, or the box dropping the
        // connection. Either way the game is over and the player needs to
        // be told, because the engine will otherwise just freeze.
        //
        // Code 1006 is the "abnormal closure" the browser reports when
        // the socket died without a close frame, which is what a server
        // restart looks like from here.
        // 4001 is the bridge's application code: the bridge is fine, the
        // game server behind it is not (it is restarting). That is a
        // completely different situation from the network dropping, and
        // the player deserves to know which one it is.
        const reason =
          ev?.code === 4001
            ? 'The game server is restarting. It will be back in about a minute.'
            : ev?.code === 1006 || ev?.code === 1001
              ? 'The connection to the game server was lost.'
              : `The game server closed the connection (code ${ev?.code ?? 'unknown'}).`;
        console.warn('[bridge] WebSocket closed:', ev?.code, ev?.reason);
        this.reportDisconnect(reason);
      };
      ws.onmessage = (e) => {
        // Mirror the WebRTC transport's incoming-packet shim: mark the
        // packet as from 127.0.0.1:8080 and drop it on `net.incoming`.
        // The WASM engine then reads it via Net.recvfrom with no
        // surprises.
        let arr: Int8Array;
        const data = e.data;
        if (data instanceof ArrayBuffer) {
          arr = new Int8Array(data);
        } else if (ArrayBuffer.isView(data)) {
          const view = data as ArrayBufferView;
          const copy = new ArrayBuffer(view.byteLength);
          new Uint8Array(copy).set(
            new Uint8Array(
              view.buffer,
              view.byteOffset,
              view.byteLength,
            ),
          );
          arr = new Int8Array(copy);
        } else {
          // Some browsers deliver Blob for binaryType='blob'; ignore —
          // ts-udp-bridge.js only ever sends Buffer.
          return;
        }
        const packet: Packet = {
          ip: this.serverAddress.ip,
          port: this.serverAddress.port,
          data: arr,
        };
        this.net.incoming.enqueue(packet);
      };
    });
  }

  sendto(packet: Packet) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(
        '[bridge-send] DROPPED (ws not open):',
        `state=${ws?.readyState ?? 'no-ws'}`,
        `${packet.data.byteLength}B`,
        `${packet.ip.join('.')}:${packet.port}`
      );
      return;
    }
    // Forward the raw bytes. The engine embeds the destination address
    // in its own protocol header (GoldSrc connectionless challenge
    // includes the addr); the bridge just shoots bytes at 127.0.0.1:27015.
    //
    // `packet.data` is typed `Int8Array<ArrayBufferLike>` but the DOM
    // `WebSocket.send` overload wants a view over an actual
    // `ArrayBuffer` (TS 5.7+ narrowed BufferSource). Always copy into a
    // fresh ArrayBuffer-backed view so the WS send type-checks for
    // every browser lib the SDK ships with.
    const data = packet.data;
    const copy = new ArrayBuffer(data.byteLength);
    new Int8Array(copy).set(data);
    ws.send(new Int8Array(copy));
    // Throttled: log the first N packets in full, then collapse to one
    // line per interval once the stream is steady. 8-byte hex mirrors
    // the bridge's `--debug` log so the two ends read the same.
    const now = performance.now();
    const size = data.byteLength;
    const worthLogging =
      this.sentLogged < Xash3DBridge.PER_PACKET_LOG_LIMIT ||
      size !== this.lastSentSize ||
      now - this.lastSentLogAt > Xash3DBridge.PER_PACKET_LOG_INTERVAL_MS;
    if (!worthLogging) return;
    this.sentLogged++;
    this.lastSentLogAt = now;
    this.lastSentSize = size;
    const first8 = new Uint8Array(copy, 0, Math.min(8, data.byteLength));
    let hex = '';
    for (let i = 0; i < first8.length; i++) {
      hex += first8[i].toString(16).padStart(2, '0');
    }
    logTrace(
      `[bridge-send] ${size}B →`,
      `${packet.ip.join('.')}:${packet.port}`,
      `head=${hex}`
    );
  }
}
