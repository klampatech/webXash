import { type Packet } from 'xash3d-fwgs';
import { Xash3DWebRTC } from './xash-webrtc.ts';

export interface MultiplayerConfig {
  /** WebSocket signaling server host:port (e.g. "100.95.111.112:27016"). */
  server: string;
  /** Whether this peer initiates the SDP offer. */
  role: 'host' | 'guest';
  /** Room identifier; both peers must use the same value. */
  room: string;
}

/**
 * Concrete WebRTC engine that joins a signaling server room.
 * Used when XashSettings.vue's multiplayer config is populated.
 *
 * The signaling protocol (in `signaling-server.js`):
 *   1. Client opens WebSocket, sends `{ event: 'join', room }`.
 *   2. Server responds with `{ event: 'joined', role, peerCount }`.
 *   3. When both peers have joined, server sends `{ event: 'start-offer' }`
 *      to the host.
 *   4. Host creates SDP offer; both peers exchange candidates via the
 *      server until the data channels are open.
 */
export class Xash3DMultiplayer extends Xash3DWebRTC {
  constructor(
    opts: { multiplayerIP: string; onError?: () => void },
    cfg: MultiplayerConfig,
  ) {
    super(opts);
    // Re-stash cfg for use in connect() — the parent's multiplayerIP
    // field is used to build the WebSocket URL.
    this.multiplayerIP = cfg.server;
  }

  async connect(): Promise<void> {
    const cfg = (window as any).__multiplayerConfig as MultiplayerConfig;
    if (!cfg) throw new Error('Multiplayer config missing');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return new Promise<void>((resolve) => {
      this.resolve = resolve as (value?: unknown) => void;
      const ip = `ws://${cfg.server}/websocket`;
      const ws = new WebSocket(ip);
      this.ws = ws;

      ws.onerror = (error: Event) => this.onConnectionError(error, ip);

      ws.onopen = () => {
        ws.send(JSON.stringify({ event: 'join', room: cfg.room }));
      };

      ws.onmessage = async (e: MessageEvent) => {
        let parsed: any;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          return;
        }

        switch (parsed.event) {
          case 'joined':
            console.log(`[mp] joined as ${parsed.role}`);
            this.setupPeer(stream);
            break;
          case 'peer-joined':
            console.log('[mp] peer joined');
            break;
          case 'peer-disconnected':
            console.log('[mp] peer disconnected');
            alert('Peer disconnected.');
            break;
          case 'start-offer':
            await this.startOffer();
            break;
          case 'offer':
          case 'answer':
          case 'candidate': {
            const sdp =
              typeof parsed.data === 'string'
                ? JSON.parse(parsed.data)
                : parsed.data;
            const peer = this.peer;
            if (!peer) return;
            if (parsed.event === 'offer') {
              await peer.setRemoteDescription(sdp);
              const answer = await peer.createAnswer();
              await peer.setLocalDescription(answer);
              ws.send(JSON.stringify({ event: 'answer', data: answer }));
            } else if (parsed.event === 'answer') {
              await peer.setRemoteDescription(sdp);
            } else if (parsed.event === 'candidate') {
              await peer.addIceCandidate(sdp);
            }
            break;
          }
        }
      };
    });
  }
}

// Re-export for callers.
export type { Packet };