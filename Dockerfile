# Oracle VM 등 어디서나: docker run -e openlaw_API_KEY=… -e LAWMCP_TOKENS=name:token -p 3457:3457 airealty-lawmcp
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
ENV LAWMCP_HOST=0.0.0.0 LAWMCP_PORT=3457 LAWMCP_CACHE_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3457
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3457/healthz || exit 1
CMD ["node", "src/http-server.js"]
