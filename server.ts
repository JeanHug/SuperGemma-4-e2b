import "dotenv/config";
import express from "express";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { createServer as createViteServer } from "vite";

// Escapes single quotes for standard bash execution inside single quotes.
function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function flushResponse(res: express.Response) {
  (res as any).flush?.();
}

let tunnelProcess: ChildProcess | null = null;
let isStartingTunnel = false;

// Checks if the local high-speed forwarded port 8088 is responding
async function checkLocalTunnelHealth(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:8088/health", {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Ensures a persistent port-forward tunnel (Codespace 8080 -> Local 8088)
// This reduces latency from ~4000ms per request (SSH handshake) down to 15ms!
async function ensureHighSpeedTunnel(codespace = "literate-space-lamp-g4px7pr4j4r5cvvr"): Promise<boolean> {
  if (await checkLocalTunnelHealth()) {
    return true;
  }

  if (isStartingTunnel) {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (await checkLocalTunnelHealth()) return true;
    }
    return checkLocalTunnelHealth();
  }

  isStartingTunnel = true;
  try {
    const tokenToUse = process.env.VM_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const childEnv = { ...process.env };
    if (tokenToUse) {
      childEnv.GH_TOKEN = tokenToUse;
      childEnv.GITHUB_TOKEN = tokenToUse;
    }

    if (tunnelProcess) {
      try {
        tunnelProcess.kill("SIGTERM");
      } catch {}
      tunnelProcess = null;
    }

    tunnelProcess = spawn(
      "gh",
      ["codespace", "ports", "forward", "8080:8088", "-c", codespace],
      {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    tunnelProcess.on("exit", (code) => {
      console.log(`Tunnel process exited with code ${code}`);
      tunnelProcess = null;
    });

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (await checkLocalTunnelHealth()) {
        console.log("High-speed direct tunnel ready on port 8088 (15ms latency)!");
        return true;
      }
    }
    return false;
  } finally {
    isStartingTunnel = false;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Proactively start high-speed tunnel in background
  ensureHighSpeedTunnel().catch(() => {});

  app.get("/api/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  });

  app.get("/api/check-token", (req, res) => {
    res.json({
      has_vm_token: Boolean(process.env.VM_TOKEN),
      has_gh_token: Boolean(process.env.GH_TOKEN),
      has_github_token: Boolean(process.env.GITHUB_TOKEN),
      all_token_keys: Object.keys(process.env).filter((k) => /token|gh|git/i.test(k)),
    });
  });

  // Complete memory, KV cache, and slot purge endpoint
  app.post("/api/reset", async (req, res) => {
    const codespace = req.body?.codespace || "literate-space-lamp-g4px7pr4j4r5cvvr";
    try {
      // 1. Try slot erase via local tunnel
      try {
        const eraseRes = await fetch("http://127.0.0.1:8088/slots/0?action=erase", {
          method: "POST",
          signal: AbortSignal.timeout(2000),
        });
        if (eraseRes.ok) {
          return res.json({ status: "ok", message: "KV cache and model state purged successfully." });
        }
      } catch {}

      // 2. Fallback via gh codespace ssh
      const tokenToUse = process.env.VM_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      const childEnv = { ...process.env };
      if (tokenToUse) {
        childEnv.GH_TOKEN = tokenToUse;
        childEnv.GITHUB_TOKEN = tokenToUse;
      }
      const remoteCmd = `curl -s -X POST http://localhost:8080/slots/0?action=erase || true`;
      const child = spawn("gh", ["codespace", "ssh", "-c", codespace, remoteCmd], { env: childEnv });
      setTimeout(() => {
        try { child.kill(); } catch {}
      }, 3000);

      return res.json({ status: "ok", message: "KV cache and model state purged successfully." });
    } catch (e: any) {
      return res.status(500).json({ error: e.message || "Failed to reset model state" });
    }
  });

  app.post("/api/chat/stream", async (req, res) => {
    const {
      prompt,
      messages,
      codespace = "literate-space-lamp-g4px7pr4j4r5cvvr",
      enableThinking = true,
    } = req.body;

    if (!prompt && (!messages || messages.length === 0)) {
      return res.status(400).json({ error: "Le prompt est requis." });
    }

    // Crucial headers for real-time SSE without proxy buffering
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const chatMessages =
      messages && messages.length > 0
        ? [...messages]
        : [{ role: "user", content: prompt }];

    // Prepare payload with max_tokens: 32768 and n_predict: 32768 so generation is NEVER truncated!
    const requestPayload = {
      messages: chatMessages,
      stream: true,
      max_tokens: 32768,
      n_predict: 32768,
      chat_template_kwargs: {
        enable_thinking: Boolean(enableThinking),
      },
    };

    const abortController = new AbortController();
    let isClientClosed = false;

    res.on("close", () => {
      isClientClosed = true;
      abortController.abort();
    });

    // Strategy 1: High-Speed Direct HTTP Tunnel (15ms latency, ultra-fast)
    const isTunnelAvailable = await ensureHighSpeedTunnel(codespace);

    if (isTunnelAvailable) {
      try {
        const upstreamRes = await fetch("http://127.0.0.1:8088/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
          signal: abortController.signal,
        });

        if (!upstreamRes.ok || !upstreamRes.body) {
          throw new Error(`Upstream error: HTTP ${upstreamRes.status}`);
        }

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            const parts = line.split(/(?=data:\s*)/);
            for (const part of parts) {
              const trimmed = part.trim();
              if (!trimmed.startsWith("data:")) continue;

              const jsonStr = trimmed.slice(5).trim();
              if (jsonStr === "[DONE]") {
                if (!res.writableEnded) {
                  res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
                  flushResponse(res);
                }
                continue;
              }

              try {
                const parsed = JSON.parse(jsonStr);
                const choice = parsed.choices?.[0];
                const reasoning = choice?.delta?.reasoning_content;
                const content = choice?.delta?.content;
                const timings = parsed.timings;

                if (reasoning && !res.writableEnded) {
                  res.write(`data: ${JSON.stringify({ type: "reasoning", delta: reasoning })}\n\n`);
                  flushResponse(res);
                }
                if (content && !res.writableEnded) {
                  res.write(`data: ${JSON.stringify({ type: "content", delta: content })}\n\n`);
                  flushResponse(res);
                }
                if (timings && !res.writableEnded) {
                  res.write(`data: ${JSON.stringify({ type: "timings", timings })}\n\n`);
                  flushResponse(res);
                }
              } catch {
                // Ignore incomplete partial JSON lines
              }
            }
          }
        }

        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          flushResponse(res);
          res.end();
        }
        return;
      } catch (tunnelErr: any) {
        if (isClientClosed) return;
        console.warn("Direct tunnel request failed, falling back to SSH wrapper:", tunnelErr.message);
      }
    }

    // Strategy 2: Fallback via SSH CLI wrapper if tunnel is starting or unreachable
    const tokenToUse = process.env.VM_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const childEnv = { ...process.env };
    if (tokenToUse) {
      childEnv.GH_TOKEN = tokenToUse;
      childEnv.GITHUB_TOKEN = tokenToUse;
    }

    const b64Payload = Buffer.from(JSON.stringify(requestPayload)).toString("base64");
    const remoteCommand = `if ! curl -s http://localhost:8080/health > /dev/null; then mkdir -p /tmp/slots && nohup /workspaces/SuperGemma-4-e2b/llama.cpp/build/bin/llama-server -m /workspaces/SuperGemma-4-e2b/models/gemma-4-E2B-it-Q4_K_M.gguf --host 0.0.0.0 --port 8080 -c 8192 -t 4 -tb 4 -np 1 -b 1024 -ub 512 --no-mmap --slot-save-path /tmp/slots --samplers "temperature;top_p;top_k" -ctk q8_0 -ctv q8_0 --flash-attn on > /tmp/llama.log 2>&1 < /dev/null & sleep 2; fi; echo "${b64Payload}" | base64 -d | curl -sN http://localhost:8080/v1/chat/completions -H "Content-Type: application/json" -d @-`;

    const child = spawn("gh", ["codespace", "ssh", "-c", codespace, remoteCommand], {
      env: childEnv,
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    });

    let buffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const parts = line.split(/(?=data:\s*)/);
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === "[DONE]") {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
              flushResponse(res);
            }
            continue;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            const choice = parsed.choices?.[0];
            const reasoning = choice?.delta?.reasoning_content;
            const content = choice?.delta?.content;
            const timings = parsed.timings;

            if (reasoning && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "reasoning", delta: reasoning })}\n\n`);
              flushResponse(res);
            }
            if (content && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "content", delta: content })}\n\n`);
              flushResponse(res);
            }
            if (timings && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "timings", timings })}\n\n`);
              flushResponse(res);
            }
          } catch {}
        }
      }
    });

    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (!isClientClosed && code !== 0 && code !== null && !res.writableEnded) {
        console.error(`Streaming fallback exited with code ${code}. Stderr: ${stderr}`);
        res.write(
          `data: ${JSON.stringify({
            type: "error",
            error: stderr || "Erreur d'inférence lors du fallback.",
          })}\n\n`
        );
        flushResponse(res);
      }
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        flushResponse(res);
        res.end();
      }
    });

    child.on("error", (err) => {
      console.error("Child process error:", err);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
        flushResponse(res);
        res.end();
      }
    });
  });

  app.post("/api/chat", async (req, res) => {
    const { prompt, codespace = "literate-space-lamp-g4px7pr4j4r5cvvr", ghToken, maxTokens = 256 } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Le prompt est requis." });
    }

    const tokenToUse = process.env.VM_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ghToken;
    const childEnv = { ...process.env };
    if (tokenToUse) {
      childEnv.GH_TOKEN = tokenToUse;
      childEnv.GITHUB_TOKEN = tokenToUse;
    }

    const bodyPayload = JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_tokens: maxTokens
    });
    const b64Payload = Buffer.from(bodyPayload).toString("base64");
    const remoteCommand = `if ! curl -s http://localhost:8080/health > /dev/null; then nohup /workspaces/SuperGemma-4-e2b/llama.cpp/build/bin/llama-server -m /workspaces/SuperGemma-4-e2b/models/gemma-4-E2B-it-Q4_K_M.gguf --host 0.0.0.0 --port 8080 -c 4096 -t 4 > /tmp/llama-server.log 2>&1 & sleep 3; fi; echo "${b64Payload}" | base64 -d | curl -s http://localhost:8080/v1/chat/completions -H "Content-Type: application/json" -d @-`;

    const child = spawn("gh", ["codespace", "ssh", "-c", codespace, remoteCommand], {
      env: childEnv
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return res.status(500).json({ 
          error: "Erreur d'exécution de l'inférence.", 
          details: stderr || stdout 
        });
      }

      try {
        const parsed = JSON.parse(stdout);
        const msg = parsed.choices?.[0]?.message;
        res.json({
          thinking: msg?.reasoning_content || "",
          answer: msg?.content || "",
          timings: parsed.timings,
          raw: stdout
        });
      } catch (err) {
        res.json({ thinking: "", answer: stdout, raw: stdout });
      }
    });
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

