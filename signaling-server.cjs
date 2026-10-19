// Signaling server for webXash multiplayer.
// Each connected WebSocket client is paired with one other client.
// Messages received from one side are forwarded to the other.
// The "host" is the first client to connect to a given room; the
// "guest" is the second. Host creates the SDP offer.
//
// Usage:
//   node signaling-server.js [port]
// Default port: 27016

const http = require('http');
const { WebSocketServer } = require('ws');

const port = parseInt(process.argv[2] || '27016', 10);

// rooms: roomId -> [ws1, ws2]
const rooms = new Map();

const server = http.createServer((req, res) => {
  // Health check.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`ok\nrooms: ${rooms.size}\nclients: ${[...rooms.values()].reduce((s, p) => s + p.length, 0)}\n`);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // First message from the client must be a "join" event with a roomId.
  // Default roomId is "default".
  let joined = false;
  let myRoom = null;

  const cleanup = () => {
    if (!myRoom) return;
    const peers = rooms.get(myRoom);
    if (!peers) return;
    const idx = peers.indexOf(ws);
    if (idx !== -1) peers.splice(idx, 1);
    // Notify the other peer.
    peers.forEach((p) => {
      if (p.readyState === 1) {
        p.send(JSON.stringify({ event: 'peer-disconnected' }));
      }
    });
    if (peers.length === 0) rooms.delete(myRoom);
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!joined) {
      if (msg.event === 'join') {
        const roomId = msg.room || 'default';
        myRoom = roomId;
        joined = true;

        if (!rooms.has(roomId)) rooms.set(roomId, []);
        const peers = rooms.get(roomId);
        const isHost = peers.length === 0;

        peers.push(ws);

        // Tell the client whether they are host or guest.
        ws.send(
          JSON.stringify({
            event: 'joined',
            role: isHost ? 'host' : 'guest',
            room: roomId,
            peerCount: peers.length,
          }),
        );

        // Notify the other peer.
        peers.forEach((p) => {
          if (p !== ws && p.readyState === 1) {
            p.send(JSON.stringify({ event: 'peer-joined' }));
          }
        });

        // If both peers are present, signal host to start the offer.
        if (peers.length === 2) {
          const host = peers[0];
          if (host.readyState === 1) {
            host.send(JSON.stringify({ event: 'start-offer' }));
          }
        }
      } else {
        // Need to join a room first.
        ws.send(JSON.stringify({ event: 'error', message: 'must join first' }));
      }
      return;
    }

    // Forward any other event to the other peer in the room.
    const peers = rooms.get(myRoom) || [];
    peers.forEach((p) => {
      if (p !== ws && p.readyState === 1) {
        p.send(raw.toString());
      }
    });
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Signaling server listening on ws://0.0.0.0:${port}/websocket`);
  console.log(`Health: http://0.0.0.0:${port}/health`);
});