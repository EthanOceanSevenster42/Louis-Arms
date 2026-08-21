# ARMS backend.
#
# The app itself is pure JavaScript with no native modules, so this image is
# small and builds anywhere. It does NOT contain a database: point it at one
# with the environment variables in .env.example.
#
#   docker build -f deploy/Dockerfile -t arms-backend .
#   docker run --env-file .env -p 3000:3000 \
#     -v "/srv/arms/system:/app/system:ro" \
#     -v "/srv/arms/build:/app/build:ro" \
#     arms-backend
#
# THE TWO APPLICATIONS ARE NOT IN THIS IMAGE. `NAHDIS Explorer.html` and
# `Schedule 8 Mobile.html` live in folder 1 of the handover and the template in
# folder 2; mount them and set SYSTEM_DIR / BUILD_DIR (or the four explicit
# path variables). Keeping them outside means the pages can be corrected
# without rebuilding and redeploying the server.

FROM node:22-alpine

# dumb-init so SIGTERM reaches node and the pool closes cleanly on a redeploy.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a code change does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Never run as root. The app writes nothing to disk - all state is in SQL - so
# it needs no writable volume of its own.
USER node

ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000

# HOST=0.0.0.0 is correct INSIDE a container: the isolation is the container
# boundary and the reverse proxy in front of it, not the bind address. Do not
# publish this port straight to the internet - see deploy/arms.nginx.conf.

# /api/health is the only route that answers without a session, which is
# exactly what a container probe needs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
