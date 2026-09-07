import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  AlertCircle,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Brain,
  Zap,
  Sparkles,
  Copy,
  Check,
  Bot,
  User,
  Lightbulb,
  ArrowDown,
  Settings,
  X,
  Globe,
  ExternalLink,
} from 'lucide-react';
import { MarkdownRenderer } from './components/MarkdownRenderer';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
}

interface Metrics {
  latency: number | null; // in ms
  tps: number | null; // tokens per second
  duration: number; // in ms
  tokens: number; // token count
}

type ThinkingMode = 'thinking' | 'no-thinking';

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>('thinking');
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isPurgingMemory, setIsPurgingMemory] = useState(false);
  const [purgeNotice, setPurgeNotice] = useState<string | null>(null);

  // Endpoint configuration for GitHub Pages / remote hosting
  const [customApiUrl, setCustomApiUrl] = useState<string>(() => {
    return localStorage.getItem('gemma_custom_api_url') || '';
  });
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    return localStorage.getItem('gemma_custom_api_key') || '';
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const saveSettings = (url: string, key: string) => {
    setCustomApiUrl(url);
    setCustomApiKey(key);
    localStorage.setItem('gemma_custom_api_url', url.trim());
    localStorage.setItem('gemma_custom_api_key', key.trim());
    setIsSettingsOpen(false);
    setPurgeNotice('Paramètres de connexion sauvegardés');
    setTimeout(() => setPurgeNotice(null), 2500);
  };

  // Tracks which thinking accordions are expanded (defaults to collapsed once completed)
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});

  // Live metrics updated every millisecond during inference
  const [metrics, setMetrics] = useState<Metrics>({
    latency: null,
    tps: null,
    duration: 0,
    tokens: 0,
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // References for smart auto-scroll control (allows user to scroll up without fighting the AI stream)
  const autoScrollEnabledRef = useRef<boolean>(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState<boolean>(false);

  // References for live millisecond animation frame ticker
  const rafRef = useRef<number | null>(null);
  const sendTimeRef = useRef<number>(0);
  const generationStartTimeRef = useRef<number | null>(null);
  const firstTokenTimeRef = useRef<number | null>(null);
  const tokenCountRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track user scroll position: if scrolled up, disable auto-scroll to allow uninterrupted reading
  useEffect(() => {
    const handleWindowScroll = () => {
      const scrollThreshold = 180;
      const isAtBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - scrollThreshold;

      autoScrollEnabledRef.current = isAtBottom;
      setShowScrollToBottom(!isAtBottom && messages.length > 0);
    };

    window.addEventListener('scroll', handleWindowScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleWindowScroll);
  }, [messages.length]);

  // Auto-scroll on new content only when user is at the bottom
  useEffect(() => {
    if (autoScrollEnabledRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, isLoading, expandedThinking]);

  // Clean up timer & abort controller on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  const scrollToBottom = (smooth = true) => {
    autoScrollEnabledRef.current = true;
    setShowScrollToBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  };

  const handleResetConversation = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    setIsPurgingMemory(true);
    setMessages([]);
    setExpandedThinking({});
    setInput('');
    setError(null);
    setIsLoading(false);
    setMetrics({
      latency: null,
      tps: null,
      duration: 0,
      tokens: 0,
    });

    try {
      await fetch('/api/reset', { method: 'POST' });
      setPurgeNotice('Mémoire & Cache KV réinitialisés');
      setTimeout(() => setPurgeNotice(null), 2500);
    } catch {
      setPurgeNotice('Mémoire locale réinitialisée');
      setTimeout(() => setPurgeNotice(null), 2500);
    } finally {
      setIsPurgingMemory(false);
    }
  };

  const toggleThinking = (messageId: string) => {
    setExpandedThinking((prev) => ({
      ...prev,
      [messageId]: !prev[messageId],
    }));
  };

  const handleCopyMessage = (content: string, id: string) => {
    navigator.clipboard.writeText(content);
    setCopiedMessageId(id);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userPrompt = input.trim();
    setInput('');
    setError(null);

    const userMsgId = Date.now().toString();
    const assistantMsgId = (Date.now() + 1).toString();

    // Trigger smooth scroll down upon sending new message
    scrollToBottom(true);

    // Reset metrics for new generation
    sendTimeRef.current = Date.now();
    generationStartTimeRef.current = null;
    firstTokenTimeRef.current = null;
    tokenCountRef.current = 0;

    // By default, during active thinking, start expanded
    if (thinkingMode === 'thinking') {
      setExpandedThinking((prev) => ({ ...prev, [assistantMsgId]: true }));
    }

    setMetrics({
      latency: 0,
      tps: null,
      duration: 0,
      tokens: 0,
    });

    // Start millisecond ticker: duration triggers only when generation actually begins
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const updateTicker = () => {
      const now = Date.now();
      const count = tokenCountRef.current;

      if (generationStartTimeRef.current === null) {
        // Still waiting for model response: duration is 0, latency tracks wait time
        const elapsedWait = now - sendTimeRef.current;
        setMetrics((prev) => ({
          ...prev,
          latency: elapsedWait,
          duration: 0,
          tokens: 0,
          tps: null,
        }));
      } else {
        // Generation has started: duration starts at beginning of generation
        const genElapsedMs = now - generationStartTimeRef.current;
        const currentTps = genElapsedMs > 0 && count > 0 ? count / (genElapsedMs / 1000) : null;

        setMetrics((prev) => ({
          ...prev,
          latency: firstTokenTimeRef.current,
          duration: genElapsedMs,
          tokens: count,
          tps: currentTps,
        }));
      }

      rafRef.current = requestAnimationFrame(updateTicker);
    };
    rafRef.current = requestAnimationFrame(updateTicker);

    // Prepare multi-turn history to preserve conversation memory (keep recent turns to keep context optimal)
    const conversationHistory = [
      ...messages
        .filter((m) => Boolean(m.content && m.content.trim()))
        .slice(-8)
        .map((m) => ({
          role: m.role,
          content: m.content.trim(),
        })),
      { role: 'user', content: userPrompt },
    ];

    // Append user message and placeholder assistant message
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: userPrompt },
      { id: assistantMsgId, role: 'assistant', content: '', thinking: '' },
    ]);

    setIsLoading(true);

    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;

    try {
      const isCustomEndpoint = Boolean(customApiUrl && customApiUrl.trim());
      const endpoint = isCustomEndpoint
        ? customApiUrl.trim()
        : '/api/chat/stream';

      const isDirectOpenAIEndpoint = isCustomEndpoint && (
        endpoint.includes('/v1/chat/completions') ||
        endpoint.includes(':8080') ||
        endpoint.includes('.app.github.dev')
      );

      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (customApiKey && customApiKey.trim()) {
        requestHeaders['Authorization'] = `Bearer ${customApiKey.trim()}`;
      }

      let requestBody: any;
      if (isDirectOpenAIEndpoint) {
        requestBody = {
          messages: conversationHistory,
          stream: true,
          chat_template_kwargs: {
            enable_thinking: thinkingMode === 'thinking',
          },
        };
      } else {
        requestBody = {
          prompt: userPrompt,
          messages: conversationHistory,
          enableThinking: thinkingMode === 'thinking',
        };
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal: abortCtrl.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Erreur de connexion (${response.status}): impossible de joindre l'inférence.`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasReceivedFirstContent = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          // Robust handling of concatenated SSE lines
          const parts = line.split(/(?=data:\s*)/);
          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') continue;

            try {
              const event = JSON.parse(jsonStr);

              // 1. Direct OpenAI / llama-server standard format
              if (event.choices && Array.isArray(event.choices) && event.choices[0]?.delta) {
                const delta = event.choices[0].delta;
                const reasoningDelta = delta.reasoning_content || delta.reasoning || '';
                const contentDelta = delta.content || '';

                if (reasoningDelta) {
                  const now = Date.now();
                  if (firstTokenTimeRef.current === null) {
                    const lat = now - sendTimeRef.current;
                    firstTokenTimeRef.current = lat;
                    generationStartTimeRef.current = now;
                    setMetrics((m) => ({ ...m, latency: lat, duration: 0 }));
                  }
                  tokenCountRef.current += 1;

                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === assistantMsgId
                        ? { ...msg, thinking: (msg.thinking || '') + reasoningDelta }
                        : msg
                    )
                  );
                }

                if (contentDelta) {
                  const now = Date.now();
                  if (!hasReceivedFirstContent) {
                    hasReceivedFirstContent = true;
                    setExpandedThinking((prev) => ({ ...prev, [assistantMsgId]: false }));
                  }
                  if (firstTokenTimeRef.current === null) {
                    const lat = now - sendTimeRef.current;
                    firstTokenTimeRef.current = lat;
                    generationStartTimeRef.current = now;
                    setMetrics((m) => ({ ...m, latency: lat, duration: 0 }));
                  }
                  tokenCountRef.current += 1;

                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === assistantMsgId
                        ? { ...msg, content: msg.content + contentDelta }
                        : msg
                    )
                  );
                }
              }
              // 2. Custom stream server proxy format
              else if (event.type === 'reasoning') {
                const now = Date.now();
                if (firstTokenTimeRef.current === null) {
                  const lat = now - sendTimeRef.current;
                  firstTokenTimeRef.current = lat;
                  generationStartTimeRef.current = now;
                  setMetrics((m) => ({ ...m, latency: lat, duration: 0 }));
                }
                tokenCountRef.current += 1;

                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, thinking: (msg.thinking || '') + event.delta }
                      : msg
                  )
                );
              } else if (event.type === 'content') {
                const now = Date.now();
                if (!hasReceivedFirstContent) {
                  hasReceivedFirstContent = true;
                  setExpandedThinking((prev) => ({ ...prev, [assistantMsgId]: false }));
                }

                if (firstTokenTimeRef.current === null) {
                  const lat = now - sendTimeRef.current;
                  firstTokenTimeRef.current = lat;
                  generationStartTimeRef.current = now;
                  setMetrics((m) => ({ ...m, latency: lat, duration: 0 }));
                }
                tokenCountRef.current += 1;

                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, content: msg.content + event.delta }
                      : msg
                  )
                );
              } else if (event.type === 'timings') {
                if (event.timings?.predicted_per_second) {
                  setMetrics((m) => ({
                    ...m,
                    tps: event.timings.predicted_per_second,
                    latency: m.latency || Math.round(event.timings.prompt_ms || 0),
                  }));
                }
              } else if (event.type === 'error') {
                throw new Error(event.error || "Erreur durant l'inférence.");
              }
            } catch {
              // Ignore partial or non-json lines
            }
          }
        }
      }

      // Auto-collapse if still expanded when stream completes
      setExpandedThinking((prev) => ({ ...prev, [assistantMsgId]: false }));
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || "Erreur de connexion à l'inférence Codespace.");
      }
    } finally {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      abortControllerRef.current = null;

      // Final metrics lock-in: duration strictly from start of generation
      const finalGenMs = generationStartTimeRef.current
        ? Date.now() - generationStartTimeRef.current
        : 0;
      const totalTokens = tokenCountRef.current;
      const finalTps = finalGenMs > 0 && totalTokens > 0
        ? totalTokens / (finalGenMs / 1000)
        : null;

      setMetrics((prev) => ({
        ...prev,
        latency: firstTokenTimeRef.current,
        duration: finalGenMs,
        tokens: totalTokens,
        tps: prev.tps !== null ? prev.tps : finalTps,
      }));
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="min-h-screen bg-[#fafafa] text-neutral-900 flex flex-col font-sans selection:bg-neutral-200">
      {/* Top Header: Real-time metrics with value & unit on the SAME LINE, tight spacing, perfectly centered */}
      <header className="border-b border-neutral-200 bg-white sticky top-0 z-40 px-3 sm:px-6 py-2.5 shadow-xs">
        <div className="max-w-2xl w-full mx-auto flex items-center justify-center">
          <div className="flex items-center space-x-3 sm:space-x-5 md:space-x-6">
            {/* Latence */}
            <div className="flex flex-col items-center justify-center text-center">
              <span className="text-neutral-950 font-bold text-xs tracking-tight">
                Latence
              </span>
              <span className="text-neutral-500 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap">
                {metrics.latency !== null
                  ? metrics.latency < 1000
                    ? `${metrics.latency} ms`
                    : `${(metrics.latency / 1000).toFixed(2)} s`
                  : '— ms'}
              </span>
            </div>

            <div className="h-6 w-px bg-neutral-200" />

            {/* TPS */}
            <div className="flex flex-col items-center justify-center text-center">
              <span className="text-neutral-950 font-bold text-xs tracking-tight">
                TPS
              </span>
              <span className="text-neutral-500 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap">
                {metrics.tps !== null ? `${metrics.tps.toFixed(1)} t/s` : '— t/s'}
              </span>
            </div>

            <div className="h-6 w-px bg-neutral-200" />

            {/* Durée */}
            <div className="flex flex-col items-center justify-center text-center">
              <span className="text-neutral-950 font-bold text-xs tracking-tight">
                Durée
              </span>
              <span className="text-neutral-500 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap">
                {metrics.duration < 1000
                  ? `${metrics.duration} ms`
                  : `${(metrics.duration / 1000).toFixed(2)} s`}
              </span>
            </div>

            <div className="h-6 w-px bg-neutral-200" />

            {/* Tokens */}
            <div className="flex flex-col items-center justify-center text-center">
              <span className="text-neutral-950 font-bold text-xs tracking-tight">
                Tokens
              </span>
              <span className="text-neutral-500 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap">
                {`${metrics.tokens} tok`}
              </span>
            </div>

            <div className="h-6 w-px bg-neutral-200" />

            {/* Reset Button integrated as a clean metric column */}
            <button
              type="button"
              onClick={handleResetConversation}
              disabled={(messages.length === 0 && !isLoading) || isPurgingMemory}
              title="Réinitialiser la conversation et purger la mémoire / le cache KV"
              className="flex flex-col items-center justify-center text-center group cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
            >
              <div className="flex items-center space-x-1">
                <RotateCcw className={`w-3 h-3 text-neutral-950 transition-transform ${isPurgingMemory ? 'animate-spin' : 'group-hover:rotate-[-45deg]'}`} />
                <span className="text-neutral-950 font-bold text-xs tracking-tight">
                  {isPurgingMemory ? 'Purge...' : 'Reset'}
                </span>
              </div>
              <span className="text-neutral-400 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap group-hover:text-neutral-700 transition-colors">
                purger KV
              </span>
            </button>

            <div className="h-6 w-px bg-neutral-200" />

            {/* Settings & Remote Connection Button */}
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              title="Configurer l'endpoint d'inférence (Codespace / GitHub Pages / Serveur distant)"
              className="flex flex-col items-center justify-center text-center group cursor-pointer transition-opacity"
            >
              <div className="flex items-center space-x-1">
                <Settings className="w-3 h-3 text-neutral-950 group-hover:rotate-45 transition-transform" />
                <span className="text-neutral-950 font-bold text-xs tracking-tight">
                  API
                </span>
              </div>
              <span className="text-neutral-400 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap group-hover:text-neutral-700 transition-colors flex items-center space-x-1">
                {customApiUrl ? (
                  <span className="text-emerald-600 font-semibold">Distant</span>
                ) : (
                  <span>Auto</span>
                )}
              </span>
            </button>
          </div>
        </div>

        {/* Purge / Reset notification banner */}
        {purgeNotice && (
          <div className="bg-neutral-900 text-white text-[11px] py-1 px-3 text-center font-mono flex items-center justify-center space-x-1.5 transition-all">
            <Check className="w-3.5 h-3.5 text-emerald-400" />
            <span>{purgeNotice}</span>
          </div>
        )}
      </header>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-neutral-200 shadow-xl max-w-lg w-full p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
              <div className="flex items-center space-x-2">
                <Settings className="w-4 h-4 text-neutral-950" />
                <h3 className="text-sm font-bold text-neutral-950">Configuration de l'Inférence</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="p-1 rounded-lg hover:bg-neutral-100 text-neutral-400 hover:text-neutral-900 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.target as HTMLFormElement;
                const url = (form.elements.namedItem('apiUrl') as HTMLInputElement).value;
                const key = (form.elements.namedItem('apiKey') as HTMLInputElement).value;
                saveSettings(url, key);
              }}
              className="space-y-4"
            >
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-900 flex items-center justify-between">
                  <span>URL du serveur d'inférence (Endpoint)</span>
                  <span className="text-[10px] font-mono text-neutral-400 font-normal">Optionnel</span>
                </label>
                <input
                  type="text"
                  name="apiUrl"
                  defaultValue={customApiUrl}
                  placeholder="Laisser vide pour mode Auto (/api/chat/stream)"
                  className="w-full px-3 py-2 text-xs border border-neutral-200 rounded-xl focus:outline-none focus:border-neutral-950 font-mono"
                />
                <p className="text-[11px] text-neutral-500 leading-relaxed">
                  Sur <strong>GitHub Pages</strong>, indiquez l'URL publique de votre Codespace (ex: <code className="bg-neutral-100 px-1 py-0.5 rounded text-[10px]">https://&lt;codespace&gt;-8080.app.github.dev/v1/chat/completions</code>) ou l'adresse de votre backend distant.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-900 flex items-center justify-between">
                  <span>Token d'authentification / Clé API</span>
                  <span className="text-[10px] font-mono text-neutral-400 font-normal">Optionnel</span>
                </label>
                <input
                  type="password"
                  name="apiKey"
                  defaultValue={customApiKey}
                  placeholder="Bearer token (si votre endpoint est protégé)"
                  className="w-full px-3 py-2 text-xs border border-neutral-200 rounded-xl focus:outline-none focus:border-neutral-950 font-mono"
                />
              </div>

              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3 space-y-2 text-xs text-neutral-600">
                <div className="font-semibold text-neutral-900 flex items-center space-x-1.5">
                  <Globe className="w-3.5 h-3.5 text-neutral-700" />
                  <span>Déploiement GitHub Pages</span>
                </div>
                <ol className="list-decimal list-inside space-y-1 text-[11px] text-neutral-500">
                  <li>Poussez le code sur votre dépôt GitHub vide (la branche <code className="font-mono">main</code>).</li>
                  <li>Le workflow GitHub Actions inclus déploie le site automatiquement.</li>
                  <li>Dans les paramètres du dépôt GitHub, activez <em>Settings &gt; Pages &gt; GitHub Actions</em>.</li>
                  <li>Rendez le port 8080 public dans votre Codespace (<code className="font-mono">gh codespace ports visibility 8080:public</code>) pour que GitHub Pages s'y connecte directement.</li>
                </ol>
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => saveSettings('', '')}
                  className="px-3 py-1.5 text-xs text-neutral-600 hover:text-neutral-900 font-medium cursor-pointer"
                >
                  Réinitialiser (Auto)
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-neutral-950 text-white rounded-xl text-xs font-semibold hover:bg-neutral-800 transition-colors cursor-pointer"
                >
                  Enregistrer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Main Container */}
      <main className="flex-1 max-w-3xl w-full mx-auto flex flex-col p-4 sm:p-6 space-y-6 relative">
        <div className="flex-1 flex flex-col justify-between">
          {messages.length === 0 ? (
            /* Welcome screen: only title and subtitle */
            <div className="my-auto text-center space-y-4 max-w-md mx-auto py-16">
              <div className="flex justify-center">
                <div className="p-3 bg-white border border-neutral-200 rounded-2xl shadow-2xs">
                  <Sparkles className="w-7 h-7 text-neutral-950" />
                </div>
              </div>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-neutral-950 font-serif">
                Pensez avec Gemma 4.
              </h2>
              <p className="text-sm text-neutral-500 leading-relaxed max-w-sm mx-auto">
                Interrogez le modèle Gemma 4 E2B exécuté en direct sur votre Codespace. Observez son processus de raisonnement ou ajustez votre budget de pensée ci-dessous.
              </p>
            </div>
          ) : (
            /* Chat message stream */
            <div className="space-y-8 pb-36">
              {messages.map((message) => {
                const isExpanded = expandedThinking[message.id] ?? false;
                const isCurrentlyThinking = isLoading && message.role === 'assistant' && Boolean(message.thinking) && !message.content;

                return (
                  <div key={message.id} className="space-y-3">
                    {/* Sender title */}
                    <div className="flex items-center justify-between text-[10px] font-mono tracking-widest uppercase text-neutral-400">
                      {message.role === 'user' ? (
                        <div className="flex items-center space-x-1.5 text-neutral-500">
                          <User className="w-3 h-3" />
                          <span>Vous</span>
                        </div>
                      ) : (
                        <div className="flex items-center space-x-1.5 text-neutral-800 font-semibold">
                          <Bot className="w-3 h-3 text-neutral-950" />
                          <span>Gemma 4 Edge</span>
                        </div>
                      )}
                    </div>

                    {/* Message bubble */}
                    <div className={`text-sm leading-relaxed ${message.role === 'user' ? 'text-neutral-950 font-medium' : 'text-neutral-800'}`}>
                      
                      {/* Collapsible Thinking Box */}
                      {message.role === 'assistant' && Boolean(message.thinking) && (
                        <div className="mb-4 bg-white border border-neutral-200 rounded-xl overflow-hidden shadow-2xs transition-all">
                          {/* Clickable toggle header */}
                          <button
                            type="button"
                            onClick={() => toggleThinking(message.id)}
                            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-neutral-50/75 hover:bg-neutral-100 transition-colors text-left cursor-pointer group"
                          >
                            <div className="flex items-center space-x-2 text-neutral-900">
                              <Lightbulb className="w-4 h-4 text-neutral-950 shrink-0" />
                              <span className="text-[11px] font-mono uppercase tracking-wider text-neutral-950 font-bold">
                                Pensée
                              </span>
                              <span className="text-[11px] text-neutral-500 font-mono">
                                {isCurrentlyThinking ? '· en cours...' : isExpanded ? '· (cliquer pour replier)' : '· terminé (cliquer pour déplier)'}
                              </span>
                            </div>

                            <div className="text-neutral-500 group-hover:text-neutral-950 transition-colors pl-2">
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4" />
                              ) : (
                                <ChevronDown className="w-4 h-4" />
                              )}
                            </div>
                          </button>

                          {/* Expanded content with rich Markdown and KaTeX math formatting */}
                          {isExpanded && (
                            <div className="p-3.5 border-t border-neutral-200 bg-neutral-50/60 border-l-2 border-l-neutral-400 pl-3.5 m-2 rounded-r-md">
                              <MarkdownRenderer content={message.thinking} isThinking={true} />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Loading state before first token */}
                      {message.role === 'assistant' && !message.content && !message.thinking && isLoading ? (
                        <div className="flex items-center space-x-2 text-neutral-400 font-mono text-xs py-1">
                          <svg className="w-3.5 h-3.5 animate-spin text-neutral-950" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="32" className="opacity-25" />
                            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" />
                          </svg>
                          <span>Connexion au modèle...</span>
                        </div>
                      ) : (
                        Boolean(message.content) && (
                          <div className="space-y-3">
                            <div className="prose prose-neutral max-w-none text-sm leading-relaxed">
                              <MarkdownRenderer content={message.content} />
                            </div>

                            {/* Copy button at the bottom of AI response */}
                            {message.role === 'assistant' && (
                              <div className="pt-2 border-t border-neutral-100 flex items-center justify-between text-xs">
                                <div className="flex items-center space-x-1.5 text-neutral-400 text-[11px] font-mono">
                                  <Sparkles className="w-3 h-3 text-neutral-400" />
                                  <span>Gemma 4 Edge</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleCopyMessage(message.content, message.id)}
                                  className="flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-white hover:bg-neutral-100 text-neutral-700 hover:text-neutral-950 transition-colors border border-neutral-200/80 cursor-pointer text-[11px] font-sans shadow-2xs"
                                  title="Copier la réponse"
                                >
                                  {copiedMessageId === message.id ? (
                                    <>
                                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                                      <span className="text-emerald-700 font-medium">Copié</span>
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3.5 h-3.5 text-neutral-500" />
                                      <span>Copier la réponse</span>
                                    </>
                                  )}
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Error Box */}
              {error && (
                <div className="p-4 border border-neutral-200 bg-white text-neutral-900 rounded-xl flex items-start space-x-3 text-xs leading-relaxed shadow-sm">
                  <AlertCircle className="w-4 h-4 text-neutral-950 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-bold">Erreur de communication</p>
                    <p className="text-neutral-500">{error}</p>
                    <p className="text-[10px] text-neutral-400 mt-2 font-mono">
                      Vérifiez que le Codespace est en ligne et que la clé secrète VM_TOKEN est valide.
                    </p>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </main>

      {/* Floating Scroll to Bottom Button */}
      {showScrollToBottom && (
        <div className="fixed bottom-28 right-6 sm:right-10 z-40 transition-all">
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-neutral-950 text-white rounded-full text-xs font-medium shadow-md hover:bg-neutral-800 transition-all cursor-pointer group"
          >
            <ArrowDown className="w-3.5 h-3.5 group-hover:translate-y-0.5 transition-transform" />
            <span>Dernier message</span>
            {isLoading && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-0.5" />
            )}
          </button>
        </div>
      )}

      {/* Elegant Bottom Message Bar with Integrated Thinking Mode Selector */}
      <div className="fixed bottom-0 left-0 right-0 bg-gradient-to-t from-[#fafafa] via-[#fafafa] to-transparent pt-6 pb-5 px-4 sm:px-6 z-30">
        <div className="max-w-3xl w-full mx-auto space-y-2">
          {/* Thinking Mode Settings Bar */}
          <div className="flex items-center justify-between px-2 text-xs">
            <div className="flex items-center space-x-1.5 text-neutral-600">
              <Brain className="w-3.5 h-3.5 text-neutral-950" />
              <span className="text-[11px] font-medium text-neutral-900 tracking-tight">Raisonnement :</span>
            </div>

            {/* Mode Selector: Thinking vs No Thinking */}
            <div className="flex items-center space-x-1 bg-white border border-neutral-200 rounded-lg p-0.5 shadow-2xs">
              <button
                type="button"
                onClick={() => setThinkingMode('thinking')}
                disabled={isLoading}
                title="Active le raisonnement interne et le processus de réflexion dépliable"
                className={`px-2.5 py-1 rounded-md text-[11px] font-sans font-medium transition-all cursor-pointer flex items-center space-x-1.5 ${
                  thinkingMode === 'thinking'
                    ? 'bg-neutral-950 text-white font-semibold shadow-xs'
                    : 'text-neutral-500 hover:text-neutral-950 hover:bg-neutral-100'
                }`}
              >
                <Brain className="w-3.5 h-3.5" />
                <span>Thinking</span>
              </button>
              <button
                type="button"
                onClick={() => setThinkingMode('no-thinking')}
                disabled={isLoading}
                title="Désactive le raisonnement pour une réponse instantanée directe à vitesse maximale"
                className={`px-2.5 py-1 rounded-md text-[11px] font-sans font-medium transition-all cursor-pointer flex items-center space-x-1.5 ${
                  thinkingMode === 'no-thinking'
                    ? 'bg-neutral-950 text-white font-semibold shadow-xs'
                    : 'text-neutral-500 hover:text-neutral-950 hover:bg-neutral-100'
                }`}
              >
                <Zap className="w-3.5 h-3.5" />
                <span>No thinking</span>
              </button>
            </div>
          </div>

          {/* Prompt Form */}
          <form onSubmit={handleSend} className="relative bg-white border border-neutral-200 rounded-xl focus-within:border-neutral-950 transition-colors shadow-sm flex items-center">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                thinkingMode === 'no-thinking'
                  ? 'Posez une question (réponse directe ultra-rapide sans pensée)...'
                  : 'Posez une question à Gemma 4 (avec pensée)...'
              }
              disabled={isLoading}
              className="flex-1 px-4 py-3 bg-transparent text-neutral-900 focus:outline-none text-xs resize-none h-[42px] min-h-[42px] max-h-[120px] font-sans placeholder-neutral-400 leading-relaxed align-middle"
              rows={1}
            />
            
            <div className="pr-2 flex items-center">
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="p-1.5 rounded-lg bg-neutral-950 text-white hover:bg-neutral-800 disabled:bg-neutral-100 disabled:text-neutral-300 transition-colors cursor-pointer disabled:cursor-not-allowed"
                id="btn-send"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

