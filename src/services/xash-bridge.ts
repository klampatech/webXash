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

export interface Xash3DBridgeOptions extends Xash3DOptions {
  /**
   * Bridge address. Format: `host:port`. The bridge MUST speak
   *     WebSocket-binary on `/ws`. See scripts/ts-udp-bridge.js.
   */
  bridgeAddress?: string;
}

/**
 * GoldSrc engine's source address the bridge makes packets appear to come
 * from. We mirror the WebRTC transport's convention so the WASM engine
 * treats both transports identically.
 */
const FAKE_SOURCE_IP: [number, number, number, number] = [127, 0, 0, 1];
const FAKE_SOURCE_PORT = 8080;

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
  /** fd -> last peer address, for getsockname + diagnostics. */
  private peers = new Map<number, { ip: number[]; port: number }>();

  override socket(family: number, type: number, protocol: number): number {
    console.log(`[bridge-net] socket(${family}, ${type}, ${protocol})`);
    return super.socket(family, type, protocol);
  }

  /**
   * POSIX `connect(2)`. For a datagram socket this is legal without a
   * peer and the kernel just filters sends to the connected address —
   * which is precisely what our single-upstream bridge already does.
   * Returning 0 (success) is therefore correct and is what unblocks
   * the engine's connect path.
   */
  connect(fd: number, sockaddrPtr: number, socklenPtr: number): number {
    if (this.em && sockaddrPtr) {
      const [ip, port] = this.readSockaddrFast(sockaddrPtr);
      this.peers.set(fd, { ip, port });
      console.log(
        `[bridge-net] connect(fd=${fd}) -> ${ip.join('.')}:${port} (accepted)`
      );
    } else {
      console.log(`[bridge-net] connect(fd=${fd}) (accepted)`);
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

export class Xash3DBridge extends Xash3D {
  private ws?: WebSocket;
  private readonly bridgeAddress: string;
  // Concrete `Net` instance. CRITICAL: this must be ASSIGNED, not merely
  // declared. xash3d-fwgs's generated WASM glue calls
  // `Module.net.sendto(...)` / `Module.net.recvfrom(...)` with a `?? -1`
  // fallback, so when `this.net` is undefined every socket call the
  // engine makes silently returns -1 and NOTHING is ever sent. The base
  // Xash3D class passes `this.net` into the Emscripten module as `net:`
  // (see xash3d.js runEm), so we must build the Net in our constructor,
  // keyed to ourselves as the SendtoSender.
  declare public net: BridgeNet;

  constructor(opts: Xash3DBridgeOptions) {
    super(opts);
    this.bridgeAddress = opts.bridgeAddress ?? '';
    // `NetImpl` needs a SendtoSender — this class provides `sendto()`.
    // hostname/hostID feed `gethostname()`, which the engine uses for
    // the server browser list; the bridge conventions mirror WebRTC.
    this.net = new BridgeNet(this, { hostname: 'tsbridge', hostID: 1 });
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

  private _connect(): Promise<void> {
    if (!this.bridgeAddress) {
      throw new Error('Xash3DBridge: bridgeAddress required (host:port)');
    }
    return new Promise((resolve, reject) => {
      const url = `ws://${this.bridgeAddress}/ws`;
      const ws = new WebSocket(url);
      // The `ws` (the WebSocket we open) MUST be a binary stream,
      // because we hand the raw engine datagrams straight in.
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => {
        console.error('[bridge] WebSocket error', e);
        reject(new Error(`WebSocket failed: ${url}`));
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
          ip: FAKE_SOURCE_IP,
          port: FAKE_SOURCE_PORT,
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
    // Cheap enough to keep on permanently during M5 bring-up — the send
    // rate on a dedicated-server connection is a few packets/sec.
    console.log(
      `[bridge-send] ${data.byteLength}B →`,
      `${packet.ip.join('.')}:${packet.port}`,
      `head=${data.subarray(0, 6).reduce((a, b) => (a << 8) | (b & 0xff), 0) >>> 0}`
    );
  }
}
