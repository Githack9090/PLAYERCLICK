FROM node:18-alpine

WORKDIR /app

# Installa dipendenze
COPY package*.json ./
RUN npm ci --only=production

# Copia codice
COPY src/ ./src/

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "src/server.js"]