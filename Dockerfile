FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so this layer caches across source changes.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY lib ./lib
COPY public ./public
COPY server.js ./

USER node

EXPOSE 8080
ENV PORT=8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
