FROM golang:1.27.2 AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/twin-agent ./cmd/twin-agent

FROM python:3.13-slim AS node
RUN pip install --no-cache-dir asyncpg==0.30.0
COPY --from=agent /out/twin-agent /usr/local/bin/twin-agent
COPY emulation/company/app.py /app/company_app.py
ENTRYPOINT ["sleep", "infinity"]

FROM postgres@sha256:5d706d5aa3ad311722f373fdc09e6a22b454bec70d34d9786383983fd83c5e46 AS database
COPY --from=agent /out/twin-agent /usr/local/bin/twin-agent
