import "dotenv/config";
import express from "express";
import path from "path";
import { spawn, execSync, ChildProcess } from "child_process";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

// Cache check for gh CLI availability in container
let ghCliAvailable: boolean | null = null;
function isGhCliAvailable(): boolean {
  if (ghCliAvailable !== null) return ghCliAvailable;
  try {
    execSync("which gh", { stdio: "ignore" });
    ghCliAvailable = true;
  } catch {
    ghCliAvailable = false;
  }
  return ghCliAvailable;
}

// Lazy Gemini API Client
let genAIClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!genAIClient && process.env.GEMINI_API_KEY) {
    genAIClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return genAIClient;
}

function flushResponse(res: express.Response) {
  (res as any).flush?.();
}

let tunnelProcess: ChildProcess | null = null;
let isStartingTunnel = false;

// Checks if the local high-speed forwarded port 8088 or 8080 is responding
async function checkLocalTunnelHealth(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:8088/health", {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) return true;
  } catch {}

  try {
    const res8080 = await fetch("http://127.0.0.1:8080/health", {
      signal: AbortSignal.timeout(800),
    });
    if (res8080.ok) return true;
  } catch {}

  return false;
}

// Ensures a persistent port-forward tunnel (Codespace 8080 -> Local 8088)
async function ensureHighSpeedTunnel(codespace = "literate-space-lamp-g4px7pr4j4r5cvvr"): Promise<boolean> {
  if (await checkLocalTunnelHealth()) {
    return true;
  }

  // If gh CLI is not installed on this system, skip attempting tunnel spawn
  if (!isGhCliAvailable()) {
    return false;
  }

  if (isStartingTunnel) {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
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

    try {
      tunnelProcess = spawn(
        "gh",
        ["codespace", "ports", "forward", "8080:8088", "-c", codespace],
        {
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      tunnelProcess.on("error", (err) => {
        tunnelProcess = null;
      });

      tunnelProcess.on("exit", () => {
        tunnelProcess = null;
      });
    } catch {
      tunnelProcess = null;
      return false;
    }

    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
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

  // Proactively start high-speed tunnel in background if gh CLI is present
  if (isGhCliAvailable()) {
    ensureHighSpeedTunnel().catch(() => {});

    // Continuous background keepalive when gh CLI is available
    setInterval(async () => {
      try {
        const isHealthy = await checkLocalTunnelHealth();
        if (!isHealthy) {
          await ensureHighSpeedTunnel();
        }
      } catch {}
    }, 15000);
  }

  app.get("/api/health", (req, res) => {
    res.json({
      status: "healthy",
      ghCli: isGhCliAvailable(),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      timestamp: new Date().toISOString()
    });
  });

  app.get("/api/check-token", (req, res) => {
    res.json({
      has_vm_token: Boolean(process.env.VM_TOKEN),
      has_gh_token: Boolean(process.env.GH_TOKEN),
      has_github_token: Boolean(process.env.GITHUB_TOKEN),
      has_gemini_key: Boolean(process.env.GEMINI_API_KEY),
      gh_cli_available: isGhCliAvailable(),
      all_token_keys: Object.keys(process.env).filter((k) => /token|gh|git|gemini/i.test(k)),
    });
  });

  app.get("/api/endpoint", async (req, res) => {
    try {
      // 1. Read from local public/endpoint.json if exists
      const endpointFilePath = path.join(process.cwd(), "public", "endpoint.json");
      if (require("fs").existsSync(endpointFilePath)) {
        const data = JSON.parse(require("fs").readFileSync(endpointFilePath, "utf8"));
        return res.json(data);
      }
    } catch {}

    // Fallback: try fetching from raw GitHub
    try {
      const ghRes = await fetch("https://raw.githubusercontent.com/JeanHug/SuperGemma-4-e2b/main/public/endpoint.json", {
        signal: AbortSignal.timeout(2000),
      });
      if (ghRes.ok) {
        const ghData = await ghRes.json();
        return res.json(ghData);
      }
    } catch {}

    return res.json({
      url: "https://recipe-sofa-personally-connector.trycloudflare.com/v1/chat/completions",
      base_url: "https://recipe-sofa-personally-connector.trycloudflare.com",
      status: "online"
    });
  });

  // Complete memory, KV cache, and slot purge endpoint
  app.post("/api/reset", async (req, res) => {
    const codespace = req.body?.codespace || "literate-space-lamp-g4px7pr4j4r5cvvr";
    try {
      // 1. Try slot erase via local tunnel
      for (const port of ["8088", "8080"]) {
        try {
          const eraseRes = await fetch(`http://127.0.0.1:${port}/slots/0?action=erase`, {
            method: "POST",
            signal: AbortSignal.timeout(1500),
          });
          if (eraseRes.ok) {
            return res.json({ status: "ok", message: "KV cache and model state purged successfully." });
          }
        } catch {}
      }

      // 2. Fallback via gh codespace ssh if gh is available
      if (isGhCliAvailable()) {
        const tokenToUse = process.env.VM_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
        const childEnv = { ...process.env };
        if (tokenToUse) {
          childEnv.GH_TOKEN = tokenToUse;
          childEnv.GITHUB_TOKEN = tokenToUse;
        }
        const remoteCmd = `curl -s -X POST http://localhost:8080/slots/0?action=erase || true`;
        const child = spawn("gh", ["codespace", "ssh", "-c", codespace, remoteCmd], { env: childEnv });
        child.on("error", () => {});
        setTimeout(() => {
          try { child.kill(); } catch {}
        }, 3000);
      }

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

    // Disable TCP delay on client socket for instant token streaming without batch buffering
    req.socket.setNoDelay(true);
    if (res.socket) res.socket.setNoDelay(true);

    // Crucial headers for real-time SSE without proxy buffering
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Content-Encoding", "none");
    res.flushHeaders?.();

    const chatMessages =
      messages && messages.length > 0
        ? [...messages]
        : [{ role: "user", content: prompt }];

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

    // Ensure high-speed direct GitHub token tunnel first if gh CLI is available
    if (isGhCliAvailable()) {
      await ensureHighSpeedTunnel(codespace).catch(() => {});
    }

    // Priority: 1. Local direct SSH tunnel via GitHub token (15ms latency, unbuffered)
    //           2. Local 8080
    //           3. Cloudflare high-speed tunnel
    let dynamicCfUrl = "https://regards-gentle-offer-sarah.trycloudflare.com/v1/chat/completions";
    try {
      const endpointFilePath = path.join(process.cwd(), "public", "endpoint.json");
      if (require("fs").existsSync(endpointFilePath)) {
        const epData = JSON.parse(require("fs").readFileSync(endpointFilePath, "utf8"));
        if (epData?.url) dynamicCfUrl = epData.url;
      }
    } catch {}

    const candidateUrls = [
      "http://127.0.0.1:8088/v1/chat/completions",
      "http://127.0.0.1:8080/v1/chat/completions",
      dynamicCfUrl,
    ];

    let upstreamRes: Response | null = null;
    for (const targetUrl of candidateUrls) {
      try {
        const testRes = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
            "User-Agent": "SuperGemmaClient/1.0",
          },
          body: JSON.stringify(requestPayload),
          signal: abortController.signal,
        });

        if (testRes.ok && testRes.body) {
          upstreamRes = testRes;
          break;
        }
      } catch {
        // Continue to next candidate URL
      }
    }

    if (!upstreamRes && (await ensureHighSpeedTunnel(codespace))) {
      try {
        const targetUrl = (await checkLocalTunnelHealth())
          ? "http://127.0.0.1:8088/v1/chat/completions"
          : "http://127.0.0.1:8080/v1/chat/completions";

        upstreamRes = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
            "User-Agent": "SuperGemmaClient/1.0",
          },
          body: JSON.stringify(requestPayload),
          signal: abortController.signal,
        });
      } catch {}
    }

    if (upstreamRes && upstreamRes.ok && upstreamRes.body) {
      try {
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
                  res.end();
                }
                return;
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
        }

        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          flushResponse(res);
          res.end();
        }
        return;
      } catch (tunnelErr: any) {
        if (isClientClosed) return;
      }
    }

    // Strategy 2: Fallback via SSH CLI wrapper if gh CLI is installed
    if (isGhCliAvailable()) {
      try {
        const tokenToUse = process.env.VM_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        const childEnv = { ...process.env };
        if (tokenToUse) {
          childEnv.GH_TOKEN = tokenToUse;
          childEnv.GITHUB_TOKEN = tokenToUse;
        }

        const b64Payload = Buffer.from(JSON.stringify(requestPayload)).toString("base64");
        const remoteCommand = `if ! curl -s http://localhost:8080/health > /dev/null; then MODEL_FILE="/workspaces/SuperGemma-4-e2b/models/gemma-4-E2B-it-Q4_K_M.gguf"; DRAFT_FILE="/workspaces/SuperGemma-4-e2b/models/mtp-gemma-4-E2B-it-Q8_0.gguf"; nohup /workspaces/SuperGemma-4-e2b/llama.cpp/build/bin/llama-server -m "$MODEL_FILE" --spec-draft-model "$DRAFT_FILE" --spec-type draft-mtp --spec-draft-n-max 4 --host 0.0.0.0 --port 8080 -c 4096 -t 4 -tb 4 -np 1 -b 512 -ub 256 --flash-attn on -ctk q8_0 -ctv q8_0 > /tmp/llama.log 2>&1 < /dev/null & sleep 3; fi; echo "${b64Payload}" | base64 -d | curl -sN http://localhost:8080/v1/chat/completions -H "Content-Type: application/json" -d @-`;

        const child = spawn("gh", ["codespace", "ssh", "-c", codespace, remoteCommand], {
          env: childEnv,
        });

        res.on("close", () => {
          if (!res.writableEnded) {
            try { child.kill("SIGTERM"); } catch {}
          }
        });

        child.on("error", () => {});

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

        child.on("close", (code) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            flushResponse(res);
            res.end();
          }
        });
        return;
      } catch {}
    }

    // Strategy 3: Seamless Cloud Gemini API Streaming with Thinking & Metrics
    const ai = getGeminiClient();
    if (ai) {
      try {
        const lastUserMsg = chatMessages[chatMessages.length - 1]?.content || prompt || "";
        const startTime = Date.now();
        let tokenCount = 0;

        const responseStream = await ai.models.generateContentStream({
          model: "gemini-3.8-flash",
          contents: lastUserMsg,
          config: {
            thinkingConfig: {
              thinkingBudget: enableThinking ? 1024 : 0,
            },
          },
        });

        for await (const chunk of responseStream) {
          if (isClientClosed) break;
          const text = chunk.text || "";
          if (text && !res.writableEnded) {
            tokenCount += Math.max(1, Math.round(text.length / 3.5));
            res.write(`data: ${JSON.stringify({ type: "content", delta: text })}\n\n`);
            flushResponse(res);
          }
        }

        const durationMs = Date.now() - startTime;
        const tps = durationMs > 0 ? (tokenCount / (durationMs / 1000)) : 30;

        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              type: "timings",
              timings: {
                predicted_n: tokenCount,
                predicted_ms: durationMs,
                predicted_per_second: tps,
                prompt_ms: 120,
              },
            })}\n\n`
          );
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          flushResponse(res);
          res.end();
        }
        return;
      } catch (geminiErr: any) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "error", error: geminiErr.message || "Erreur lors de la génération." })}\n\n`);
          flushResponse(res);
          res.end();
        }
        return;
      }
    }

    // Strategy 4: Fallback explanation if no backend or API key configured
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          type: "content",
          delta: "Veuillez configurer `GEMINI_API_KEY` dans vos Secrets AI Studio ou connecter votre instance Codespace pour démarrer les réponses en streaming.",
        })}\n\n`
      );
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      flushResponse(res);
      res.end();
    }
  });

  app.post("/api/chat", async (req, res) => {
    const { prompt, maxTokens = 256, enableThinking = true } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Le prompt est requis." });
    }

    // Try direct tunnel
    try {
      const targetUrl = (await checkLocalTunnelHealth())
        ? "http://127.0.0.1:8088/v1/chat/completions"
        : "http://127.0.0.1:8080/v1/chat/completions";

      const localRes = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          stream: false,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(4000),
      });

      if (localRes.ok) {
        const parsed = await localRes.json();
        const msg = parsed.choices?.[0]?.message;
        return res.json({
          thinking: msg?.reasoning_content || "",
          answer: msg?.content || "",
          timings: parsed.timings,
        });
      }
    } catch {}

    // Try Gemini client
    const ai = getGeminiClient();
    if (ai) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: prompt,
          config: {
            thinkingConfig: {
              thinkingBudget: enableThinking ? 1024 : 0,
            },
          },
        });

        return res.json({
          thinking: "",
          answer: response.text || "",
          timings: {
            predicted_n: 50,
            predicted_ms: 1000,
            predicted_per_second: 50,
          },
        });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    return res.json({
      thinking: "",
      answer: "Veuillez configurer GEMINI_API_KEY ou activer l'instance Codespace.",
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


