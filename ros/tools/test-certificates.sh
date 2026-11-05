#!/usr/bin/env bash
set -euo pipefail
cd /test-certs
if [[ -f .complete ]]; then exit 0; fi
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 1 -subj /CN=Local-Test-CA
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=mqtt-tls
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 1
mkdir -p devices/bridge-tls
openssl req -newkey rsa:2048 -nodes -keyout devices/bridge-tls/private.pem.key -out client.csr -subj /CN=bridge-tls
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out devices/bridge-tls/device.pem.crt -days 1
chmod 600 ca.key server.key devices/bridge-tls/private.pem.key
chmod 644 ca.crt server.crt devices/bridge-tls/device.pem.crt
chown 1883:1883 server.key
chown 10001:10001 devices/bridge-tls/private.pem.key
touch .complete
