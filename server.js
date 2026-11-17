// ASHEN VEIL — servidor cooperativo para Render/Node.js
// Mantém o protocolo esperado por ASHEN_VEIL_0_47_MP.html.
// Uso local: npm start | Porta: process.env.PORT ou 8080
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';
const GAME = process.env.GAME || 'ASHEN_VEIL_0_47_MP.html';
const MAX_PLAYERS = 4;
const MAX_FRAME = 1024 * 1024;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }
  if (req.method !== 'GET' || (req.url !== '/' && !req.url.startsWith('/?'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(__dirname, GAME), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo do jogo ausente: ' + GAME);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

function send(client, value) {
  if (client.socket.destroyed || !client.socket.writable) return;
  const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  client.socket.write(Buffer.concat([header, payload]));
}

function readFrame(client) {
  const buffer = client.buffer;
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2); offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const bigLength = buffer.readBigUInt64BE(2);
    if (bigLength > BigInt(MAX_FRAME)) throw new Error('Frame too large');
    length = Number(bigLength); offset = 10;
  }
  if (length > MAX_FRAME) throw new Error('Frame too large');
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  let payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length));
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  client.buffer = buffer.subarray(offset + maskBytes + length);
  return { opcode, payload };
}

const cleanName = value => String(value || 'Viajante')
  .replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 14) || 'Viajante';
function playerList(room) {
  return room.slots.map((client, id) => client ? { id, name: client.name } : null).filter(Boolean);
}
function leave(client) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  if (client.id === 0) {
    for (const other of room.slots) {
      if (other && other !== client) {
        send(other, { t: 'closed' });
        other.room = null;
        other.socket.end();
      }
    }
    rooms.delete(room.code);
  } else {
    room.slots[client.id] = null;
    for (const other of room.slots) if (other) send(other, { t: 'pl', id: client.id });
  }
}
function handleMessage(client, message) {
  if (!message || typeof message !== 'object') return;
  if (message.t === 'create' && !client.room) {
    let code;
    do {
      code = Array.from({ length: 5 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
    } while (rooms.has(code));
    const room = { code, slots: [client, null, null, null] };
    rooms.set(code, room);
    client.room = room; client.id = 0; client.name = cleanName(message.name);
    send(client, { t: 'room', code, id: 0 });
    return;
  }
  if (message.t === 'join' && !client.room) {
    const room = rooms.get(String(message.code || '').toUpperCase().trim());
    if (!room) { send(client, { t: 'err', m: 'Sala não encontrada' }); return; }
    const id = room.slots.findIndex(slot => !slot);
    if (id < 0 || room.slots.filter(Boolean).length >= MAX_PLAYERS) {
      send(client, { t: 'err', m: 'Sala cheia (máx. 4)' }); return;
    }
    room.slots[id] = client; client.room = room; client.id = id; client.name = cleanName(message.name);
    send(client, { t: 'joined', code: room.code, id, players: playerList(room) });
    for (const other of room.slots) if (other && other !== client) send(other, { t: 'pj', id, name: client.name });
    return;
  }
  if (message.t === 'm' && client.room) {
    const outgoing = JSON.stringify({ t: 'm', f: client.id, d: message.d });
    if (message.to === 'all') {
      for (const other of client.room.slots) if (other && other !== client) send(other, outgoing);
    } else {
      const target = client.room.slots[Number(message.to)];
      if (target && target !== client) send(target, outgoing);
    }
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const client = { socket, buffer: Buffer.alloc(0), room: null, id: -1, name: '' };
  socket.setNoDelay(true);
  socket.on('data', chunk => {
    try {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      if (client.buffer.length > MAX_FRAME + 14) { socket.destroy(); return; }
      let frame;
      while ((frame = readFrame(client))) {
        if (frame.opcode === 8) { socket.end(); return; }
        if (frame.opcode === 9) {
          const pongHeader = Buffer.from([0x8a, frame.payload.length]);
          socket.write(Buffer.concat([pongHeader, frame.payload]));
          continue;
        }
        if (frame.opcode !== 1) continue;
        let message;
        try { message = JSON.parse(frame.payload.toString('utf8')); } catch (_) { continue; }
        handleMessage(client, message);
      }
    } catch (_) { socket.destroy(); }
  });
  socket.on('close', () => leave(client));
  socket.on('error', () => { socket.destroy(); });
});

const heartbeat = setInterval(() => {
  for (const room of rooms.values()) for (const client of room.slots) {
    if (client && !client.socket.destroyed && client.socket.writable) client.socket.write(Buffer.from([0x89, 0x00]));
  }
}, 25000);
server.on('close', () => clearInterval(heartbeat));
server.listen(PORT, HOST, () => {
  console.log(`ASHEN VEIL coop ouvindo em ${HOST}:${PORT} (jogo: ${GAME})`);
});
