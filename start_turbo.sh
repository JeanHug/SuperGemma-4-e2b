#!/bin/bash
pkill -9 -f llama-server 2>/dev/null || true
pkill -9 -f cloudflared 2>/dev/null || true
pkill -9 -f ngrok 2>/dev/null || true
sleep 1

# Automatically update DuckDNS domain gemma-api.duckdns.org
/workspaces/SuperGemma-4-e2b/update_duckdns.sh >/dev/null 2>&1 &

export OMP_NUM_THREADS=4
export OMP_PROC_BIND=SPREAD

# Start high-speed Gemma server (24+ TPS)
nohup /workspaces/SuperGemma-4-e2b/llama.cpp/build/bin/llama-server   -m /workspaces/SuperGemma-4-e2b/models/gemma-4-E2B-it-Q4_K_M.gguf   --host 0.0.0.0   --port 8080   -c 2048   -t 4   -tb 4   -np 1   -b 512   -ub 512   -ctk q4_0   -ctv q4_0   --flash-attn on   > /tmp/llama_turbo.log 2>&1 < /dev/null &

# Start Cloudflare Tunnel (Unlimited Bandwidth, Unlimited Requests/min, No Warning Page)
nohup /tmp/cloudflared tunnel --url http://localhost:8080 > /tmp/cloudflared.log 2>&1 < /dev/null &

for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8080/health | grep -q "ok"; then
    echo "SERVER_READY"
    break
  fi
  sleep 1
done

sleep 3
echo "DuckDNS domain updated: gemma-api.duckdns.org"
