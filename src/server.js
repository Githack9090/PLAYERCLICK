const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '50mb' }));

// ============================================================
// SOCKET.IO
// ============================================================

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8
});

// ============================================================
// ROOM MANAGER
// ============================================================

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.userToRoom = new Map();
  }

  createRoom(hostId) {
    const roomId = this.generateCode();
    const room = {
      id: roomId,
      hostId,
      guests: new Set(),
      fileInfo: null,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    
    this.rooms.set(roomId, room);
    this.userToRoom.set(hostId, roomId);
    console.log(`[ROOM] ${roomId} creata da ${hostId}`);
    return room;
  }

  joinRoom(roomId, guestId) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'NOT_FOUND' };
    if (room.guests.size >= 10) return { error: 'FULL' };
    
    room.guests.add(guestId);
    this.userToRoom.set(guestId, roomId);
    room.lastActivity = Date.now();
    return room;
  }

  leaveRoom(socketId) {
    const roomId = this.userToRoom.get(socketId);
    if (!roomId) return null;
    
    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (room.hostId === socketId) {
      const guests = Array.from(room.guests);
      this.rooms.delete(roomId);
      guests.forEach(g => this.userToRoom.delete(g));
      this.userToRoom.delete(socketId);
      return { closed: true, roomId, guests };
    } else {
      room.guests.delete(socketId);
      this.userToRoom.delete(socketId);
      return { closed: false, roomId, hostId: room.hostId, socketId };
    }
  }

  getRoom(id) { return this.rooms.get(id); }
  getRoomByUser(socketId) { 
    const id = this.userToRoom.get(socketId);
    return id ? this.rooms.get(id) : null;
  }

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  cleanup() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (now - room.lastActivity > 30 * 60 * 1000) {
        console.log(`[CLEANUP] ${id} rimossa`);
        this.rooms.delete(id);
        this.userToRoom.delete(room.hostId);
        room.guests.forEach(g => this.userToRoom.delete(g));
      }
    }
  }
}

const rooms = new RoomManager();
setInterval(() => rooms.cleanup(), 10 * 60 * 1000);

// ============================================================
// API REST (DESSO DOPO MIDDLEWARE, PRIMA DI LISTEN)
// ============================================================

// Health check - FIX: questa route mancava!
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'p2p-cinema-server',
    rooms: rooms.rooms.size,
    uptime: process.uptime()
  });
});

// TURN credentials - Open Relay (gratis, nessuna registrazione)
app.get('/turn-credentials', (req, res) => {
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  });
});

// ============================================================
// SOCKET.IO EVENTS
// ============================================================

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // --- STANZE ---

  socket.on('create-room', (cb) => {
    const room = rooms.createRoom(socket.id);
    socket.join(room.id);
    cb({ success: true, roomId: room.id, isHost: true });
  });

  socket.on('join-room', (roomId, cb) => {
    const result = rooms.joinRoom(roomId, socket.id);
    if (result.error) {
      return cb({ success: false, error: result.error });
    }
    
    socket.join(roomId);
    socket.to(result.hostId).emit('guest-joined', {
      guestId: socket.id,
      count: result.guests.size
    });

    cb({
      success: true,
      roomId,
      hostId: result.hostId,
      fileInfo: result.fileInfo,
      isHost: false
    });
  });

  socket.on('file-info', (info, cb) => {
    const room = rooms.getRoomByUser(socket.id);
    if (!room || room.hostId !== socket.id) {
      return cb?.({ error: 'NOT_HOST' });
    }
    
    room.fileInfo = info;
    socket.to(room.id).emit('file-available', info);
    cb?.({ success: true });
  });

  socket.on('guest-ready', (target) => {
    const room = rooms.getRoomByUser(socket.id);
    if (!room) return;
    socket.to(target || room.hostId).emit('guest-ready', { guestId: socket.id });
  });

  // --- SIGNALING ---

  socket.on('signal', ({ to, type, data }) => {
    socket.to(to).emit('signal', { from: socket.id, type, data });
  });

  // --- FILE RELAY FALLBACK ---

  socket.on('file-chunk', ({ to, chunk, index, total, isLast }) => {
    socket.to(to).emit('file-chunk', {
      from: socket.id, chunk, index, total, isLast
    });
  });

  socket.on('chunk-ack', ({ to, index }) => {
    socket.to(to).emit('chunk-ack', { from: socket.id, index });
  });

  // --- DISCONNECT ---

  socket.on('disconnect', () => {
    const result = rooms.leaveRoom(socket.id);
    if (!result) return;

    if (result.closed) {
      result.guests.forEach(g => {
        io.to(g).emit('host-disconnected');
      });
    } else {
      io.to(result.hostId).emit('guest-left', {
        guestId: result.socketId,
        remaining: rooms.getRoom(result.roomId)?.guests.size || 0
      });
    }
  });
});

// ============================================================
// START - FIX: usa PORT dinamico Railway, bind 0.0.0.0
// ============================================================

const PORT = process.env.PORT;

if (!PORT) {
  console.error('ERROR: PORT environment variable not set');
  process.exit(1);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════╗
║     P2P CINEMA SERVER - Open Relay       ║
╠══════════════════════════════════════════╣
║  Port:        ${PORT}                      ║
║  Host:        0.0.0.0                    ║
║  TURN:        Open Relay (gratis)        ║
║  Status:      Running                    ║
╚══════════════════════════════════════════╝
  `);
});
