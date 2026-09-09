#!/bin/bash
set -e

# Kill any existing instances
pkill -9 -f llama-server 2>/dev/null || true
pkill -9 -f cloudflared 2>/dev/null || true
pkill -9 -f ngrok 2>/dev/null || true
sleep 1

# DuckDNS update in background
/workspaces/SuperGemma-4-e2b/update_duckdns.sh >/dev/null 2>&1 &

export OMP_NUM_THREADS=2
export OMP_PROC_BIND=CLOSE

# Ensure cloudflared is present
if ! command -v cloudflared &>/dev/null; then
  sudo cp /workspaces/SuperGemma-4-e2b/bin/cloudflared /usr/local/bin/cloudflared 2>/dev/null || true
fi

# Start high-speed Gemma server with optimized CPU pinning and 8192 context window
nohup /workspaces/SuperGemma-4-e2b/llama.cpp/build/bin/llama-server \
  -m /workspaces/SuperGemma-4-e2b/models/gemma-4-E2B-it-Q4_K_M.gguf \
  --load-mode none \
  --host 0.0.0.0 \
  --port 8080 \
  -c 8192 \
  --context-shift \
  --timeout 600 \
  -t 2 \
  -tb 4 \
  -np 1 \
  -b 512 \
  -ub 512 \
  -ctk q4_0 \
  -ctv q4_0 \
  --flash-attn on \
  > /tmp/llama_turbo.log 2>&1 < /dev/null &

# Start Cloudflare Tunnel with explicit IPv4 127.0.0.1
nohup cloudflared tunnel --url http://127.0.0.1:8080 > /tmp/cloudflared.log 2>&1 < /dev/null &

# Wait for llama-server to be ready
echo "Attente du démarrage du serveur Gemma..."
for i in $(seq 1 45); do
  if curl -s http://127.0.0.1:8080/health | grep -q "ok"; then
    echo "SERVER_READY"
    break
  fi
  sleep 1
done

# Wait for Cloudflare tunnel URL
echo "Récupération du tunnel Cloudflare..."
CF_URL=""
for i in $(seq 1 30); do
  CF_URL=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" /tmp/cloudflared.log | tail -n 1)
  if [ -n "$CF_URL" ]; then
    echo "CLOUDFLARE_URL: $CF_URL"
    break
  fi
  sleep 1
done

if [ -n "$CF_URL" ]; then
  mkdir -p /workspaces/SuperGemma-4-e2b/public
  cat << JSONEOF > /workspaces/SuperGemma-4-e2b/public/endpoint.json
{
  "url": "${CF_URL}/v1/chat/completions",
  "base_url": "${CF_URL}",
  "status": "online",
  "model": "gemma-4-E2B-it-Q4_K_M",
  "context_size": 8192,
  "threads": 2,
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSONEOF

  cd /workspaces/SuperGemma-4-e2b
  git config user.name "JeanHug"
  git config user.email "jeanhug@users.noreply.github.com"
  git config commit.gpgsign false
  git add public/endpoint.json start_turbo.sh
  git commit -m "Auto-update active inference endpoint: ${CF_URL}" || true
  git push https://$VM_TOKEN@github.com/JeanHug/SuperGemma-4-e2b.git main || true
  echo "Endpoint public mis à jour et synchronisé sur GitHub !"
fi
