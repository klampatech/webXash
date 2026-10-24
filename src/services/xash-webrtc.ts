import { type Packet, Xash3D, type Xash3DOptions, Net } from 'xash3d-fwgs';

export interface Xash3DOptionsMP extends Xash3DOptions {
  multiplayerIP?: string;
  onError?: () => void;
}

// WebRTC data-channel labels for game packets.
const CHANNELS = ['read', 'write'];

// Public STUN servers (Google's free ones; fine for dev/peer-to-peer).
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Base WebRTC multiplayer engine. Subclasses override
 * `connect()` to send a join message before the WebSocket
 * begins listening for signaling events.
 */
export class Xash3DWebRTC extends Xash3D {
  protected channel?: RTCDataChannel;
  protected resolve?: (value?: unknown) => void;
  protected ws?: WebSocket;
  protected peer?: RTCPeerConnection;
  protected multiplayerIP?: string;
  protected onError?: () => void;
  // `net` is inherited from xash3d-fwgs's Xash3D base class. We
  // use it directly in `setupPeer()` to enqueue incoming packets
  // from the remote peer.
  declare public net: Net;

  constructor(opts?: Xash3DOptionsMP) {
    super(opts);
    this.multiplayerIP = opts?.multiplayerIP;
    this.onError = opts?.onError;
    // xash3d-fwgs exposes `net: Net` on the base class; we use it
    // directly via the protected redeclaration above.
  }

  async init() {
    await Promise.all([super.init(), this.connect()]);
  }

  protected setupPeer(stream: MediaStream) {
    this.peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peer.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.ws?.send(
        JSON.stringify({
          event: 'candidate',
          data: e.candidate.toJSON(),
        }),
      );
    };
    // Game packets flow over data channels (lower latency than
    // media tracks). Add empty tracks only to satisfy signaling.
    stream?.getTracks()?.forEach((t) => {
      this.peer!.addTrack(t, stream);
    });

    let channelsOpen = 0;
    this.peer.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'write') {
        ch.onmessage = (ee) => {
          const packet: Packet = {
            ip: [127, 0, 0, 1],
            port: 8080,
            data: ee.data,
          };
          if (ee.data instanceof ArrayBuffer) {
            packet.data = new Int8Array(ee.data);
            this.net.incoming.enqueue(packet);
          } else if ((ee.data as ArrayBufferView).buffer) {
            const view = ee.data as ArrayBufferView;
            const copy = new ArrayBuffer(view.byteLength);
            new Uint8Array(copy).set(
              new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
            );
            packet.data = new Int8Array(copy);
            this.net.incoming.enqueue(packet);
          } else {
            this.net.incoming.enqueue(packet);
          }
        };
      }
      ch.onopen = () => {
        channelsOpen += 1;
        if (ch.label === 'read') this.channel = ch;
        if (channelsOpen === CHANNELS.length) {
          if (this.resolve) {
            const r = this.resolve;
            this.resolve = undefined;
            r();
          }
        }
      };
    };
  }

  protected async startOffer() {
    if (!this.peer) return;
    for (const label of CHANNELS) {
      this.peer.createDataChannel(label);
    }
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    this.ws?.send(
      JSON.stringify({
        event: 'offer',
        data: offer,
      }),
    );
  }

  protected onConnectionError(error: Event, ip: string) {
    const ws = error.target as WebSocket;
    if (ws && ws.readyState && ws.readyState === 3) {
      const keepLoading = confirm(`Failed to connect to ${ip}, continue?`);
      if (!keepLoading) {
        this.onError?.();
        window.location.reload();
      }
    }
  }

  async connect(): Promise<void> {
    // Subclasses override this. The default implementation is a
    // no-op that lets Xash3D run without multiplayer signaling.
  }

  sendto(packet: Packet) {
    if (!this.channel) return;
    this.channel.send(packet.data);
  }
}