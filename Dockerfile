FROM node:22-slim

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy app files
COPY server.js ./
COPY posts.db ./
COPY screenshots/ ./screenshots/
COPY priority-list.json ./

EXPOSE 4180

CMD ["node", "server.js"]
