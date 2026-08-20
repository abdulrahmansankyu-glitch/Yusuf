# For anywhere that is not Render: a VM on the plant network, Fly, Railway, or
# `docker compose up` on a spare machine.
#
# Pinned to the same major version CI runs and the Render blueprint sets, so the
# three cannot drift into testing one runtime and shipping another.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a change to the source does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# Only used when DATABASE_URL is unset, but the directory has to exist and be
# writable by the unprivileged user before the app tries to create the file.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Never root. A container that only needs to read its own source has no reason
# to be able to write over it.
USER node

EXPOSE 4200
ENV PORT=4200

# No shell wrapper: node is PID 1 and receives the stop signal directly, so a
# restart is a clean shutdown rather than a ten-second SIGKILL wait.
CMD ["node", "src/server.js"]
