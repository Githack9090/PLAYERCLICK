const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '500mb' })); // Aumentato per file grandi
app.use(compression());
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minuti
    max: 1000 // limite aumentato per file
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
    maxHttpBufferSize: 5e8 // 500MB per file grandi
});

// ============================================================
// ROOM MANAGER (MIGLIORATO)
// ============================================================
class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomId -> room data
        this.userToRoom = new Map(); // socketId -> roomId
    }

    createRoom(hostId) {
        const roomId = this.generateCode();
        const room = {
            id: roomId,
            hostId,
            guests: new Set(),
            fileInfo: null,
            relayActive: false,
            relayBuffer: null,
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        
        this.rooms.set(roomId, room);
        this.userToRoom.set(hostId, roomId);
        console.log(`[ROOM] ✅ ${roomId} creata da ${hostId}`);
        return room;
    }

    joinRoom(roomId, guestId) {
        const room = this.rooms.get(roomId);
        if (!room) return { error: 'NOT_FOUND' };
        if (room.guests.size >= 10) return { error: 'FULL' };
        
        room.guests.add(guestId);
        this.userToRoom.set(guestId, roomId);
        room.lastActivity = Date.now();
        console.log(`[ROOM] 👋 ${guestId} entra in ${roomId}`);
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
            console.log(`[ROOM] 🚪 Stanza ${roomId} chiusa (host uscito)`);
            return { closed: true, roomId, guests };
        } else {
            room.guests.delete(socketId);
            this.userToRoom.delete(socketId);
            console.log(`[ROOM] 👋 ${socketId} lascia ${roomId}`);
            return { closed: false, roomId, hostId: room.hostId, socketId };
        }
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

    cleanup() {
        const now = Date.now();
        for (const [id, room] of this.rooms) {
            if (now - room.lastActivity > 30 * 60 * 1000) { // 30 minuti
                console.log(`[CLEANUP] 🧹 Stanza ${id} rimossa per inattività`);
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
// RELAY BUFFER MANAGER (NUOVO)
// ============================================================
class RelayManager {
    constructor() {
        this.relaySessions = new Map(); // roomId -> relay session
    }

    createSession(roomId, senderId, metadata) {
        const session = {
            roomId,
            senderId,
            metadata,
            chunks: [],
            recipients: new Set(),
            startTime: Date.now(),
            lastActivity: Date.now(),
            completed: false
        };
        this.relaySessions.set(roomId, session);
        console.log(`[RELAY] 📡 Nuova sessione per stanza ${roomId}`);
        return session;
    }

    addChunk(roomId, index, chunk) {
        const session = this.relaySessions.get(roomId);
        if (session) {
            session.chunks[index] = chunk;
            session.lastActivity = Date.now();
            
            // Log ogni 10 chunk
            if (index % 10 === 0) {
                const received = session.chunks.filter(c => c !== undefined).length;
                console.log(`[RELAY] 📦 Stanza ${roomId}: chunk ${received}/${session.chunks.length}`);
            }
            
            return session;
        }
        return null;
    }

    getSession(roomId) {
        return this.relaySessions.get(roomId);
    }

    addRecipient(roomId, recipientId) {
        const session = this.relaySessions.get(roomId);
        if (session) {
            session.recipients.add(recipientId);
            session.lastActivity = Date.now();
        }
    }

    completeSession(roomId) {
        const session = this.relaySessions.get(roomId);
        if (session) {
            session.completed = true;
            // Pulisci dopo 5 minuti
            setTimeout(() => {
                this.relaySessions.delete(roomId);
                console.log(`[RELAY] 🧹 Sessione ${roomId} rimossa`);
            }, 5 * 60 * 1000);
        }
    }

    abortSession(roomId, reason) {
        const session = this.relaySessions.get(roomId);
        if (session) {
            console.log(`[RELAY] ⚠️ Sessione ${roomId} interrotta: ${reason}`);
            this.relaySessions.delete(roomId);
        }
    }
}

const relayManager = new RelayManager();

// ============================================================
// API REST
// ============================================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'p2p-cinema-server',
        rooms: rooms.rooms.size,
        relaySessions: relayManager.relaySessions.size,
        uptime: process.uptime()
    });
});

// TURN credentials
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

// Stato relay per stanza
app.get('/relay-status/:roomId', (req, res) => {
    const session = relayManager.getSession(req.params.roomId);
    if (session) {
        const chunksReceived = session.chunks.filter(c => c !== undefined).length;
        res.json({
            active: true,
            metadata: session.metadata,
            chunksReceived,
            totalChunks: session.chunks.length,
            startTime: session.startTime,
            completed: session.completed
        });
    } else {
        res.json({ active: false });
    }
});

// Statistiche server
app.get('/stats', (req, res) => {
    res.json({
        rooms: rooms.rooms.size,
        relaySessions: relayManager.relaySessions.size,
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

// ============================================================
// SOCKET.IO EVENTS
// ============================================================

io.on('connection', (socket) => {
    console.log(`[CONNECT] 🔌 ${socket.id} connesso`);

    // --- STANZE ---
    
    socket.on('create-room', (cb) => {
        const room = rooms.createRoom(socket.id);
        socket.join(room.id);
        console.log(`[ROOM] 🏠 ${socket.id} ha creato stanza ${room.id}`);
        cb({ success: true, roomId: room.id, isHost: true });
    });

    socket.on('join-room', (roomId, cb) => {
        const result = rooms.joinRoom(roomId, socket.id);
        if (result.error) {
            console.log(`[ROOM] ❌ Join fallito per ${socket.id}: ${result.error}`);
            return cb({ success: false, error: result.error });
        }
        
        socket.join(roomId);
        socket.to(result.hostId).emit('guest-joined', {
            guestId: socket.id,
            count: result.guests.size
        });

        console.log(`[ROOM] 🎉 ${socket.id} entra in stanza ${roomId}`);

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
        console.log(`[FILE] 📁 File disponibile in stanza ${room.id}: ${info.name}`);
        cb?.({ success: true });
    });

    socket.on('guest-ready', (target) => {
        const room = rooms.getRoomByUser(socket.id);
        if (!room) return;
        socket.to(target || room.hostId).emit('guest-ready', { guestId: socket.id });
        console.log(`[PEER] ✅ ${socket.id} pronto in stanza ${room.id}`);
    });

    // --- SIGNALING (WebRTC) ---

    socket.on('signal', ({ to, type, data }) => {
        socket.to(to).emit('signal', { from: socket.id, type, data });
        console.log(`[SIGNAL] 📡 ${type} da ${socket.id} a ${to}`);
    });

    // --- RELAY (NUOVO - COMPLETO) ---

    socket.on('relay-start', ({ roomId, metadata }, cb) => {
        console.log(`[RELAY] 🚀 Inizio relay in stanza ${roomId} da ${socket.id}`);
        
        const room = rooms.getRoom(roomId);
        if (!room || room.hostId !== socket.id) {
            return cb?.({ error: 'NOT_HOST' });
        }

        // Crea sessione relay
        const session = relayManager.createSession(roomId, socket.id, metadata);
        room.relayActive = true;
        
        // Notifica tutti i guest
        socket.to(roomId).emit('relay-ready', metadata);
        
        cb?.({ success: true, totalChunks: metadata.totalChunks });
    });

    socket.on('relay-chunk', ({ roomId, chunk, index, total, isLast }) => {
        const session = relayManager.getSession(roomId);
        if (!session || session.senderId !== socket.id) return;

        // Salva chunk nel buffer
        relayManager.addChunk(roomId, index, chunk);

        // Inoltra a tutti i guest nella stanza
        socket.to(roomId).emit('relay-chunk', {
            from: socket.id,
            chunk: chunk,
            index: index,
            total: total,
            isLast: isLast
        });

        // Se è l'ultimo chunk
        if (isLast) {
            relayManager.completeSession(roomId);
            const room = rooms.getRoom(roomId);
            if (room) room.relayActive = false;
            console.log(`[RELAY] ✅ Trasferimento completato stanza ${roomId}`);
        }
    });

    socket.on('relay-ack', ({ roomId, index }) => {
        // Inoltra ACK all'host
        const session = relayManager.getSession(roomId);
        if (session) {
            io.to(session.senderId).emit('relay-ack', {
                from: socket.id,
                index: index
            });
        }
    });

    socket.on('relay-retry', ({ roomId, missingIndexes }) => {
        const session = relayManager.getSession(roomId);
        if (!session) return;

        console.log(`[RELAY] 🔁 Ritentativo per ${socket.id} - chunk mancanti:`, missingIndexes);
        
        missingIndexes.forEach(index => {
            if (session.chunks[index]) {
                socket.emit('relay-chunk', {
                    from: session.senderId,
                    chunk: session.chunks[index],
                    index: index,
                    total: session.chunks.length,
                    isLast: index === session.chunks.length - 1
                });
            }
        });
    });

    socket.on('relay-abort', ({ roomId, reason }) => {
        relayManager.abortSession(roomId, reason);
        socket.to(roomId).emit('relay-aborted', { reason });
        const room = rooms.getRoom(roomId);
        if (room) room.relayActive = false;
    });

    // --- DISCONNECT ---

    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] 🔌 ${socket.id} disconnesso`);
        
        const result = rooms.leaveRoom(socket.id);
        if (!result) return;

        if (result.closed) {
            // Host disconnesso - chiudi stanza e abortisci relay
            relayManager.abortSession(result.roomId, 'Host disconnesso');
            result.guests.forEach(g => {
                io.to(g).emit('host-disconnected');
            });
            console.log(`[ROOM] 🚪 Stanza ${result.roomId} chiusa`);
        } else {
            // Guest disconnesso
            io.to(result.hostId).emit('guest-left', {
                guestId: result.socketId,
                remaining: rooms.getRoom(result.roomId)?.guests.size || 0
            });
        }
    });
});

// ============================================================
// AVVIO SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║     🎬 P2P CINEMA SERVER - MODALITÀ RELAY ATTIVA            ║
╠══════════════════════════════════════════════════════════════╣
║  Porta:           ${PORT}                                          
║  Relay buffer:    500MB max                                  
║  Stanze attive:   0                                          
║  TURN:            Open Relay (gratuito)                      
║  WebRTC + Relay:  Entrambi supportati                        
╚══════════════════════════════════════════════════════════════╝
    `);
});
