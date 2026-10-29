FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
ARG MINIO_GIT_TAG=RELEASE.2024-11-07T00-52-20Z
RUN git clone --depth 1 --branch "${MINIO_GIT_TAG}" https://github.com/minio/minio.git /src \
  && cd /src \
  && go build -trimpath -ldflags="-s -w" -o /minio .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates curl
COPY --from=build /minio /usr/local/bin/minio
VOLUME ["/data"]
EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--address", "0.0.0.0:9000"]
