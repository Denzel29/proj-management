const { WebSocketServer } = require('ws');
const auth = require('./sessions');

const clients = new Set(); // { ws, userId, name }

/** Attach a WebSocket endpoint at /ws. Clients must carry a valid session cookie. */
function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    try {
      const user = await auth.userFromCookieHeader(req.headers.cookie);
      if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, userId: user.id, name: user.name };
        clients.add(client);
        ws.on('close', () => { clients.delete(client); broadcastPresence(); });
        ws.on('error', () => clients.delete(client));
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.send(JSON.stringify({ type: 'hello', userId: user.id }));
        broadcastPresence();
      });
    } catch {
      socket.destroy();
    }
  });

  // Drop dead connections.
  setInterval(() => {
    for (const c of clients) {
      if (!c.ws.isAlive) { c.ws.terminate(); clients.delete(c); continue; }
      c.ws.isAlive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, 30000).unref();
}

function send(client, payload) {
  if (client.ws.readyState === 1) client.ws.send(payload);
}

/** Send an event to every connected user. */
function broadcast(type, data = {}, exceptUserId = null) {
  const payload = JSON.stringify({ type, ...data });
  for (const c of clients) if (c.userId !== exceptUserId) send(c, payload);
}

/** Send an event to one user (all of their open tabs). */
function toUser(userId, type, data = {}) {
  const payload = JSON.stringify({ type, ...data });
  for (const c of clients) if (c.userId === userId) send(c, payload);
}

function broadcastPresence() {
  const online = [...new Set([...clients].map((c) => c.userId))];
  broadcast('presence', { online });
}

module.exports = { attach, broadcast, toUser };
