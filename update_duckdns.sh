#!/bin/bash
DOMAIN="gemma-api"
TOKEN="d36e1120-9fc7-4bce-b49d-a538731c4cd5"

echo "Updating DuckDNS for $DOMAIN.duckdns.org..."
RESPONSE=$(curl -s "https://www.duckdns.org/update?domains=$DOMAIN&token=$TOKEN&ip=")
echo "DuckDNS Response: $RESPONSE"
