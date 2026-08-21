FROM node:22-slim

WORKDIR /app

# The explorer only needs express — install it directly instead of running
# the full `npm ci` (which pulls puppeteer/Chromium and takes 10+ minutes).
# package-lock.json is NOT used here on purpose: watcher tooling deps are
# irrelevant for this container.
RUN npm install --omit=dev --no-audit --no-fund express@^4.22.2

# Copy app files (runtime data — posts.db, screenshots, groups.json —
# is provided by bind mounts from docker-compose.yml)
COPY server.js ./

EXPOSE 4180

CMD ["node", "server.js"]
