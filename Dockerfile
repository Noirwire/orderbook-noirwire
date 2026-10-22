# syntax=docker/dockerfile:1

# The operator processes, the crank and the keeper, in one image; the command
# picks one: `docker run ... <image> crank`. It runs on any container host.
# docs/LAUNCH.md has what to mount and every setting.
#
# Nothing secret or specific to a deployment is in the image. The key, the
# deployment description, the program build and the private RPC address are
# mounted read-only when it runs, and .dockerignore keeps every other file out
# of the build.

# The same Node major as CI (NODE_VERSION in .github/workflows/ci.yml), pinned by
# the digest of the image index, which covers both architectures, so a build
# that holds mainnet keys at run time never picks up a base image nobody
# looked at. To take a newer base, `make image-digest` prints the current
# digest; put it here after reading what changed.
ARG NODE_VERSION=26
ARG NODE_DIGEST=sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe
FROM node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST}

WORKDIR /app

# No install scripts: nothing the processes need is built at install time, and
# a dependency's script is code that would run with the build's access. Only the
# client's packages are installed; the MCP server is not part of this image.
COPY package.json package-lock.json ./
COPY sdk/package.json ./sdk/
COPY mcp/package.json ./mcp/
RUN npm ci --ignore-scripts --workspace sdk --include-workspace-root \
  && npm cache clean --force

COPY tsconfig.json ./
COPY sdk ./sdk
COPY ops ./ops
RUN npm run build --workspace sdk

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/noirwire-operator

# Where things are mounted, and what is the same on every mainnet deployment.
# KEYS_DIR holds the process's key as <NETWORK>-<process>.json; the keeper also
# writes its state there, so for the keeper it is a writable folder with the
# key file mounted into it read-only. Every one of these can be set again.
ENV NETWORK=mainnet \
  PROFILE=mainnet \
  GENESIS=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d \
  PUBLIC_SOLANA_URL=https://api.mainnet-beta.solana.com \
  CUSTODY=public \
  EXCHANGE_FLOAT_LAMPORTS=200000000 \
  KEYS_DIR=/keys \
  DEPLOYMENT=/config/mainnet-deployment.json \
  SOLANA_URL_FILE=/config/mainnet-rpc-url \
  BUILT_PROGRAM=/program/noirwire_orderbook.so \
  TS_NODE_CACHE=false

RUN mkdir /keys /config /program && chown node:node /keys

USER node
ENTRYPOINT ["/usr/local/bin/noirwire-operator"]
