FROM node:22-bookworm-slim

ENV DOTNET_ROOT=/usr/share/dotnet \
    PATH=/usr/share/dotnet:/root/.dotnet/tools:$PATH \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --channel 10.0 --install-dir "$DOTNET_ROOT" \
    && rm /tmp/dotnet-install.sh \
    && dotnet tool install --global roslyn-language-server --prerelease

ENV UNITY_REFERENCES_ROOT=/opt/unity/references \
    MAX_LSP_SESSIONS=2

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "lsp-worker.js"]
