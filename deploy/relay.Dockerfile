# The agenvo relay (vendor/agenvo, pinned to our fork AkaraChen/agenvo), the
# `relay` accessory in deploy/deploy.yml. Built from scripts/build/relay.sh's
# output (apps/relay/out/server); deploy/deploy.sh tags it with the agenvo
# commit and this file's hash, so it changes only when they do. Its
# configuration is mounted at /config/relay.json, its state lives in
# /home/node (a volume).
FROM node:24-bookworm-slim
ENV NODE_ENV=production
COPY apps/relay/out/server /app
USER node
WORKDIR /home/node
EXPOSE 8080
ENTRYPOINT ["node", "/app/node_modules/@agenvo/server/dist/cli.js"]
CMD ["serve", "--config", "/config/relay.json"]
