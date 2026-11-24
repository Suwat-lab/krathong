FROM node:22-alpine
WORKDIR /app
COPY package.json server.js workshop-server.cjs index.html workshop.html ./
COPY assets ./assets
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/e-kratong.db
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
