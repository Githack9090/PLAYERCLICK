const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '1gb' }));

const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e9
});

// Room Manager professionale
class RoomManager {
    constructor() {
        this.rooms = new Map();              // roomId -> room
        this.clientToRoom = new Map();       // clientId -> roomId
        this.socketToClient = new Map();     // socketId -> clientId
        this.destructionTimeouts = new Map(); // roomId -> timeout
    }

    createRoom(socketId, clientId) {
        const roomId = this.generateCode();
        const room = {
            id: roomId,
            hostId: socketId,
            hostClientId: clientId,
            guests: new Map(), // socketId -> clientId
            fileInfo: null,
            transferState: {
                active: false,
                chunkIndex: 0,
                totalChunks: 0,
                fileId: null
            },
            createdAt: Date.now()
        };
        
        this.rooms.set(roomId, room);
        this.clientToRoom.set(clientId, roomId);
        this.socketToClient.set(socketId, clientId);
        console.log(`[ROOM] ✅ ${roomId} creata da host ${clientId}`);
        return room;
    }

    joinRoom(roomId, socketId, clientId) {
        const room = this.rooms.get(roomId);
        if (!room) return { error: 'NOT_FOUND' };
        if (room.guests.size >= 10) return { error: 'FULL' };
        
        room.guests.set(socketId, clientId);
        this.clientToRoom.set(clientId, roomId);
        this.socketToClient.set(socketId, clientId);
        return room;
    }

    // Host che si riconnette
    rejoinHost(clientId, socketId) {
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) return null;
        
        const room = this.rooms.get(roomId);
        if (!room) return null;
        
        // Annulla timer distruzione
        if (this.destructionTimeouts.has(roomId)) {
            clearTimeout(this.destructionTimeouts.get(roomId));
            this.destructionTimeouts.delete(roomId);
        }
        
        // Aggiorna socketId
        this.socketToClient.delete(room.hostId);
        room.hostId = socketId;
        this.socketToClient.set(socketId, clientId);
        
        return room;
    }

    // Guest che si riconnette
    rejoinGuest(clientId, socketId) {
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) return null;
        
        const room = this.rooms.get(roomId);
        if (!room) return null;
        
        // Rimuovi vecchio socket
        for (let [oldSocket, oldClient] of room.guests.entries()) {
            if (oldClient === clientId) {
                room.guests.delete(oldSocket);
                this.socketToClient.delete(oldSocket);
                break;
            }
        }
        
        // Aggiungi nuovo
        room.guests.set(socketId, clientId);
        this.socketToClient.set(socketId, clientId);
        
        return room;
    }

    // Avvia timer distruzione (host away)
    startDestructionTimer(roomId) {
        if (this.destructionTimeouts.has(roomId)) return;
        
        const timeout = setTimeout(() => {
            const room = this.rooms.get(roomId);
            if (room) {
                console.log(`[ROOM] 💥 Stanza ${roomId} distrutta (timeout host)`);
                io.to(roomId).emit('host-disconnected');
                
                // Pulizia
                this.clientToRoom.delete(room.hostClientId);
                room.guests.forEach((clientId, socketId) => {
                    this.clientToRoom.delete(clientId);
                    this.socketToClient.delete(socketId);
                });
                this.rooms.delete(roomId);
                this.destructionTimeouts.delete(roomId);
            }
        }, 60000); // 60 secondi di tolleranza
        
        this.destructionTimeouts.set(roomId, timeout);
    }

    getRoomBySocket(socketId) {
        const clientId = this.socketToClient.get(socketId);
        if (!clientId) return null;
        const roomId = this.clientToRoom.get(clientId);
        return roomId ? this.rooms.get(roomId) : null;
    }

    removeSocket(socketId) {
        const clientId = this.socketToClient.get(socketId);
        if (!clientId) return null;
        
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) return null;
        
        const room = this.rooms.get(roomId);
        if (!room) return null;
        
        // Se è l'host
        if (room.hostId === socketId) {
            this.startDestructionTimer(roomId);
            return { isHost: true, roomId, guests: Array.from(room.guests.keys()) };
        }
        
        // Se è un guest
        if (room.guests.has(socketId)) {
            room.guests.delete(socketId);
            this.clientToRoom.delete(clientId);
            this.socketToClient.delete(socketId);
            return { isHost: false, roomId, hostId: room.hostId, leaver: socketId };
        }
        
        return null;
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
}

const rooms = new RoomManager();

// API
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        rooms: rooms.rooms.size,
        uptime: process.uptime() 
    });
});

app.get('/turn-credentials', (req, res) => {
    res.json({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ]
    });
});

// Socket.io
io.on('connection', (socket) => {
    const clientId = socket.handshake.query.clientId;
    console.log(`[CONNECT] 🔌 ${socket.id} | client:${clientId}`);

    // --- CREAZIONE STANZA ---
    socket.on('create-room', (cb) => {
        const room = rooms.createRoom(socket.id, clientId);
        socket.join(room.id);
        cb({ success: true, roomId: room.id });
    });

    // --- JOIN STANZA ---
    socket.on('join-room', (roomId, cb) => {
        const result = rooms.joinRoom(roomId, socket.id, clientId);
        if (result.error) {
            return cb({ success: false, error: result.error });
        }
        socket.join(roomId);
        
        // Notifica host
        socket.to(result.hostId).emit('guest-joined', {
            guestId: socket.id,
            count: result.guests.size
        });
        
        cb({
            success: true,
            roomId,
            hostId: result.hostId,
            fileInfo: result.fileInfo
        });
    });

    // --- HOST REJOIN (dopo file picker) ---
    socket.on('host-rejoin', ({ roomId }, cb) => {
        const room = rooms.rejoinHost(clientId, socket.id);
        if (!room) {
            return cb({ success: false, error: 'Stanza non trovata' });
        }
        
        socket.join(roomId);
        
        // Invia lista guest attuali all'host
        const guestList = Array.from(room.guests.keys());
        socket.emit('host-restored', { guests: guestList });
        
        // Notifica ai guest che l'host è tornato
        socket.to(roomId).emit('host-back');
        
        cb({ success: true, fileInfo: room.fileInfo });
    });

    // --- GUEST REJOIN (opzionale, se anche guest si riconnette) ---
    socket.on('guest-rejoin', ({ roomId }, cb) => {
        const room = rooms.rejoinGuest(clientId, socket.id);
        if (!room) {
            return cb({ success: false, error: 'Stanza non trovata' });
        }
        
        socket.join(roomId);
        socket.to(room.hostId).emit('guest-joined', {
            guestId: socket.id,
            count: room.guests.size
        });
        
        cb({ success: true, hostId: room.hostId, fileInfo: room.fileInfo });
    });

    // --- FILE INFO ---
    socket.on('file-info', (info, cb) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room || room.hostId !== socket.id) {
            return cb?.({ error: 'NOT_HOST' });
        }
        
        room.fileInfo = info;
        socket.to(room.id).emit('file-available', info);
        cb?.({ success: true });
    });

    // --- TRASFERIMENTO STATO (per riprendere da chunk interrotto) ---
    socket.on('transfer-state', (state, cb) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room || room.hostId !== socket.id) return;
        
        room.transferState = state;
        cb?.({ success: true });
    });

    // --- GUEST READY ---
    socket.on('guest-ready', () => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        socket.to(room.hostId).emit('guest-ready', { guestId: socket.id });
    });

    // --- SIGNALING ---
    socket.on('signal', ({ to, type, data }) => {
        socket.to(to).emit('signal', { from: socket.id, type, data });
    });

    // --- RELAY CHUNK ---
    socket.on('relay-chunk', ({ roomId, chunk, index, total, isLast }) => {
        socket.to(roomId).emit('relay-chunk', {
            from: socket.id,
            chunk,
            index,
            total,
            isLast
        });
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] ❌ ${socket.id}`);
        
        const result = rooms.removeSocket(socket.id);
        if (!result) return;
        
        if (result.isHost) {
            // Host disconnesso: avvisa guest
            io.to(result.roomId).emit('host-away');
            console.log(`[ROOM] ⏳ Host away stanza ${result.roomId}`);
        } else {
            // Guest disconnesso
            io.to(result.hostId).emit('guest-left', {
                guestId: result.leaver,
                remaining: rooms.rooms.get(result.roomId)?.guests.size || 0
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] 🚀 P2P Cinema - Porta ${PORT}`);
});
