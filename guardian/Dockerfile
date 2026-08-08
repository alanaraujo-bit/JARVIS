# O guardião precisa da CLI `claude` (headless) para mandar os "oi".
# A CLI é um pacote Node; instalada globalmente no container.
FROM node:20-slim

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
