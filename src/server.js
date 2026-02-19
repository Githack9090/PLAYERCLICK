// src/server.js - FIX PER RAILWAY

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '50mb' }));

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8
});

// ... (tutto il codice RoomManager, API, Socket.io invariato) ...

// ============================================================
// START - FIX: usa solo process.env.PORT, bind 0.0.0.0
// ============================================================

// Railway assegna PORT automaticamente, deve essere usata esattamente
const PORT = process.env.PORT;

if (!PORT) {
  console.error('ERROR: PORT environment variable not set');
  process.exit(1);
}

// '0.0.0.0' = accetta connessioni da qualsiasi IP (necessario per container)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════╗
║     P2P CINEMA SERVER - Open Relay       ║
╠══════════════════════════════════════════╣
║  Port:        ${PORT}                      ║
║  Host:        0.0.0.0                    ║
║  TURN:        Open Relay (gratis)        ║
╚══════════════════════════════════════════╝
  `);
});
