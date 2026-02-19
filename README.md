# P2P Cinema Server

Server Socket.io per sistema di stanze P2P con trasferimento file.

## Deploy su Northflank

1. Crea repository su GitHub
2. Connetti a Northflank (Build from Git)
3. Configura Environment Variables se necessario
4. Deploy automatico su ogni push

## API

- `GET /` - Health check
- `GET /turn-credentials` - Credenziali TURN Twilio

## Socket Events

- `create-room` - Crea nuova stanza (host)
- `join-room` - Entra in stanza esistente (guest)
- `file-info` - Annuncia file disponibile
- `guest-ready` - Guest pronto a ricevere
- `signal` - WebRTC signaling (offer/answer/ice)
- `file-chunk` - Trasferimento file fallback