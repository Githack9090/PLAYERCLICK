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

// ... resto del codice invariato ...

// ============================================================
// START - CORRETTO PER RAILWAY
// ============================================================

const PORT = process.env.PORT || 3000;

// IMPORTANTE: '0.0.0.0' per accettare connessioni esterne
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
