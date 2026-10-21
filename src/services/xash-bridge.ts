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

import { type Net, type Packet, Xash3D, type Xash3DOptions } from 'xash3d-fwgs';

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

export class Xash3DBridge extends Xash3D {
  private ws?: WebSocket;
  private readonly bridgeAddress: string;
  // `net` is inherited from xash3d-fwgs's Xash3D base class but the
  // visible type is `EmNet` (the interface, no `incoming` field). We
  // re-declare with the concrete `Net` shape just like xash-webrtc.ts
  // does so we can call `this.net.incoming.enqueue(...)` later.
  declare public net: Net;

  constructor(opts: Xash3DBridgeOptions) {
    super(opts);
    this.bridgeAddress = opts.bridgeAddress ?? '';
  }

  async init() {
    // Resolve both the engine WASM init and our WebSocket bind in
    // parallel — both are needed before the engine can fire its first
    // UDP datagram.
    await Promise.all([super.init(), this._connect()]);
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
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
  }
}
