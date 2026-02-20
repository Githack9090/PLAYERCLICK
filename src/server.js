const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '500mb' }));
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000
});
app.use('/api/', limiter);

// ============================================================
// SOCKET.IO CONFIGURAZIONE
// ============================================================
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 5e8
});

// ============================================================
// ROOM MANAGER (Aggiornato per tolleranza disconnessioni)
// ============================================================
class RoomManager {
    constructor() {
        this.rooms = new Map();
        this.userToRoom = new Map();
        this.destructionTimeouts = new Map(); // Gestione Grace Period
    }

    createRoom(socketId, clientId) {
        const roomId = this.generateCode();
        const room = {
            id: roomId,
            hostId: socketId,
            hostClientId: clientId,
            guests: new Map(), // socketId -> clientId
            fileInfo: null,
            relayActive: false,
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        
        this.rooms.set(roomId, room);
        this.userToRoom.set(socketId, roomId);
        console.log(`[ROOM] ✅ ${roomId} creata da Host (Client: ${clientId})`);
        return room;
    }

    joinRoom(roomId, socketId, clientId) {
        const room = this.rooms.get(roomId);
        if (!room) return { error: 'NOT_FOUND' };
        if (room.guests.size >= 10) return { error: 'FULL' };
        
        room.guests.set(socketId, clientId);
        this.userToRoom.set(socketId, roomId);
        room.lastActivity = Date.now();
        return room;
    }

    getRoom(id) { 
        return this.rooms.get(id); 
    }
    
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

    // Avvia il timer di distruzione (Grace Period)
    startDestructionTimer(roomId, ioServer) {
        if (this.destructionTimeouts.has(roomId)) return;

        console.log(`[ROOM] ⏳ Avvio timer distruzione per ${roomId} (Host disconnesso)`);
        const timeout = setTimeout(() => {
            const room = this.rooms.get(roomId);
            if (room) {
                console.log(`[ROOM] 💥 Stanza ${roomId} distrutta per timeout host`);
                ioServer.to(roomId).emit('host-disconnected');
                
                // Pulizia completa
                this.userToRoom.delete(room.hostId);
                for (let guestSocketId of room.guests.keys()) {
                    this.userToRoom.delete(guestSocketId);
                }
                this.rooms.delete(roomId);
                this.destructionTimeouts.delete(roomId);
            }
        }, 45000); // 45 secondi di tolleranza per tornare (File picker Android)

        this.destructionTimeouts.set(roomId, timeout);
    }

    // Annulla il timer di distruzione se l'host torna
    cancelDestructionTimer(roomId) {
        if (this.destructionTimeouts.has(roomId)) {
            clearTimeout(this.destructionTimeouts.get(roomId));
            this.destructionTimeouts.delete(roomId);
            console.log(`[ROOM] 🛑 Timer distruzione annullato per ${roomId} (Host tornato)`);
        }
    }
}

const rooms = new RoomManager();

// (RelayManager rimane invariato)
class RelayManager {
    constructor() { this.relaySessions = new Map(); }
    createSession(roomId, senderId, metadata) {
        const session = { roomId, senderId, metadata, chunks: [], recipients: new Set(), startTime: Date.now(), lastActivity: Date.now(), completed: false };
        this.relaySessions.set(roomId, session);
        return session;
    }
    addChunk(roomId, index, chunk) {
        const session = this.relaySessions.get(roomId);
        if (session) { session.chunks[index] = chunk; session.lastActivity = Date.now(); return session; }
        return null;
    }
    getSession(roomId) { return this.relaySessions.get(roomId); }
    addRecipient(roomId, recipientId) { const session = this.relaySessions.get(roomId); if (session) { session.recipients.add(recipientId); session.lastActivity = Date.now(); } }
    completeSession(roomId) {
        const session = this.relaySessions.get(roomId);
        if (session) { session.completed = true; setTimeout(() => { this.relaySessions.delete(roomId); }, 5 * 60 * 1000); }
    }
    abortSession(roomId, reason) { this.relaySessions.delete(roomId); }
}
const relayManager = new RelayManager();

// ============================================================
// API REST (Invariate)
// ============================================================
app.get('/', (req, res) => res.json({ status: 'ok', rooms: rooms.rooms.size, uptime: process.uptime() }));
app.get('/turn-credentials', (req, res) => {
    res.json({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' } ] });
});

// ============================================================
// SOCKET.IO EVENTS (Aggiornati)
// ============================================================
io.on('connection', (socket) => {
    const clientId = socket.handshake.query.clientId;
    console.log(`[CONNECT] 🔌 Socket: ${socket.id} | ClientID: ${clientId}`);

    // --- STANZE ---
    socket.on('create-room', (cb) => {
        const room = rooms.createRoom(socket.id, clientId);
        socket.join(room.id);
        cb({ success: true, roomId: room.id, isHost: true });
    });

    socket.on('join-room', (roomId, cb) => {
        const result = rooms.joinRoom(roomId, socket.id, clientId);
        if (result.error) return cb({ success: false, error: result.error });
        
        socket.join(roomId);
        socket.to(result.hostId).emit('guest-joined', { guestId: socket.id, count: result.guests.size });

        cb({ success: true, roomId, hostId: result.hostId, fileInfo: result.fileInfo, isHost: false });
    });

    // --- RIPRISTINO SESSIONE ---
    socket.on('restore-session', ({ roomId, isHost }, cb) => {
        const room = rooms.getRoom(roomId);
        if (!room) {
            return cb?.({ success: false, error: 'Stanza distrutta' });
        }

        if (isHost && room.hostClientId === clientId) {
            // L'host è tornato!
            rooms.cancelDestructionTimer(roomId);
            
            // Aggiorniamo il socketId dell'host
            rooms.userToRoom.delete(room.hostId);
            room.hostId = socket.id;
            rooms.userToRoom.set(socket.id, roomId);
            
            socket.join(roomId);
            socket.to(roomId).emit('host-back');
            console.log(`[RECOVERY] ♻️ Host ripristinato nella stanza ${roomId}`);
            cb?.({ success: true });
        } else if (!isHost) {
            // Ripristino Guest
            socket.join(roomId);
            rooms.userToRoom.set(socket.id, roomId);
            room.guests.set(socket.id, clientId);
            socket.to(room.hostId).emit('guest-joined', { guestId: socket.id, count: room.guests.size });
            cb?.({ success: true });
        }
    });

    // --- STATO HOST MANUALE (Visibility API) ---
    socket.on('host-going-away', ({ roomId }) => {
        socket.to(roomId).emit('host-away');
    });

    socket.on('host-returned', ({ roomId }) => {
        socket.to(roomId).emit('host-back');
    });

    socket.on('file-info', (info, cb) => {
        const room = rooms.getRoomByUser(socket.id);
        if (!room || room.hostId !== socket.id) return cb?.({ error: 'NOT_HOST' });
        room.fileInfo = info;
        socket.to(room.id).emit('file-available', info);
        cb?.({ success: true });
    });

    socket.on('guest-ready', (target) => {
        const room = rooms.getRoomByUser(socket.id);
        if (!room) return;
        socket.to(target || room.hostId).emit('guest-ready', { guestId: socket.id });
    });

    // --- SIGNALING & RELAY (Invariati) ---
    socket.on('signal', ({ to, type, data }) => socket.to(to).emit('signal', { from: socket.id, type, data }));
    
    socket.on('relay-start', ({ roomId, metadata }, cb) => {
        const room = rooms.getRoom(roomId);
        if (!room || room.hostId !== socket.id) return cb?.({ error: 'NOT_HOST' });
        relayManager.createSession(roomId, socket.id, metadata);
        room.relayActive = true;
        socket.to(roomId).emit('relay-ready', metadata);
        cb?.({ success: true, totalChunks: metadata.totalChunks });
    });

    socket.on('relay-chunk', ({ roomId, chunk, index, total, isLast }) => {
        const session = relayManager.getSession(roomId);
        if (!session || session.senderId !== socket.id) return;
        relayManager.addChunk(roomId, index, chunk);
        socket.to(roomId).emit('relay-chunk', { from: socket.id, chunk, index, total, isLast });
        if (isLast) { relayManager.completeSession(roomId); const room = rooms.getRoom(roomId); if (room) room.relayActive = false; }
    });

    socket.on('relay-ack', ({ roomId, index }) => {
        const session = relayManager.getSession(roomId);
        if (session) io.to(session.senderId).emit('relay-ack', { from: socket.id, index });
    });

    // --- DISCONNECT (Aggiornato) ---
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] ❌ ${socket.id} (Client: ${clientId})`);
        const room = rooms.getRoomByUser(socket.id);
        if (!room) return;

        if (room.hostId === socket.id) {
            // È l'host. Non distruggiamo, ma avviamo il timer
            socket.to(room.id).emit('host-away');
            rooms.startDestructionTimer(room.id, io);
        } else {
            // È un guest. Lo rimuoviamo
            room.guests.delete(socket.id);
            rooms.userToRoom.delete(socket.id);
            io.to(room.hostId).emit('guest-left', { guestId: socket.id, remaining: room.guests.size });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] 🎬 P2P CINEMA - Server in ascolto sulla porta ${PORT}`);
});
