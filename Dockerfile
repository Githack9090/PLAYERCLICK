FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "src/server.js"]
