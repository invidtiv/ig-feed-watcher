FROM node:22-slim

WORKDIR /app

# The explorer only needs express (+ sharp for image retention) — install them directly instead of running
# the full `npm ci` (which pulls puppeteer/Chromium and takes 10+ minutes).
# package-lock.json is NOT used here on purpose: watcher tooling deps are
# irrelevant for this container.
RUN npm install --omit=dev --no-audit --no-fund express@^4.22.2 sharp@^0.35.5

# Copy app files (runtime data — posts.db, screenshots, groups.json,
# sources.json — is provided by bind mounts from docker-compose.yml)
COPY server.js ./
COPY sources.js ./
COPY runtime-policy.js retention.js contract-policy.js skill-policy.js ai.js ./
COPY api/openapi.json ./api/openapi.json
COPY skills/feed-api/SKILL.md ./skills/feed-api/SKILL.md
COPY COOKIES-GUIDE.md ./

EXPOSE 4180

CMD ["node", "server.js"]
