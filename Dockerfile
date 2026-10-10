FROM 041292242005.dkr.ecr.us-west-2.amazonaws.com/node:22-slim

ENV NODE_ENV=production
ENV COPILOT_HOME=/tmp/copilot-home
WORKDIR /app

# The native Copilot runtime uses the system CA store (absent from node:*-slim) to reach GitHub.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY app ./app
RUN mkdir -p /tmp/copilot-home && chown -R 10001:10001 /app /tmp/copilot-home

USER 10001:10001
EXPOSE 8080
CMD ["node", "app/server.js"]
