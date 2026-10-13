# The agenvo relay, the `relay` accessory in deploy/deploy.yml, built from
# apps/agenvo/out (the relay scripts/build/agenvo.sh builds from the pinned
# commit). deploy/deploy.sh tags it with that version and a hash of this file
# and the relay's resolved dependencies, so it changes only when they do.
# Its configuration is mounted at /config/relay.json, its state lives in
# /home/node (a volume).
FROM node:24-bookworm-slim
ENV NODE_ENV=production
COPY relay/ /opt/agenvo/
USER node
WORKDIR /home/node
EXPOSE 8080
ENTRYPOINT ["node", "/opt/agenvo/node_modules/@agenvo/server/dist/cli.js"]
CMD ["serve", "--config", "/config/relay.json"]
