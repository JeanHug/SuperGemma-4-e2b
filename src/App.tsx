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

const FALLBACK_PUBLIC_API_URL =
  'https://regards-gentle-offer-sarah.trycloudflare.com/v1/chat/completions';

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>('thinking');
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isPurgingMemory, setIsPurgingMemory] = useState(false);
  const [purgeNotice, setPurgeNotice] = useState<string | null>(null);

  // Tracks which thinking accordions are expanded
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});

  // Live metrics updated during inference
  const [metrics, setMetrics] = useState<Metrics>({
    latency: null,
    tps: null,
    duration: 0,
    tokens: 0,
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll control
  const autoScrollEnabledRef = useRef<boolean>(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState<boolean>(false);

  // Timing refs
  const rafRef = useRef<number | null>(null);
  const sendTimeRef = useRef<number>(0);
  const generationStartTimeRef = useRef<number | null>(null);
  const firstTokenTimeRef = useRef<number | null>(null);
  const lastTokenTimeRef = useRef<number | null>(null);
  const peakTpsRef = useRef<number>(0);
  const tokenCountRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track user scroll position
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
      await fetch('/api/reset', { method: 'POST', signal: AbortSignal.timeout(2000) });
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

    scrollToBottom(true);

    // Reset metrics for new generation
    sendTimeRef.current = Date.now();
    generationStartTimeRef.current = null;
    firstTokenTimeRef.current = null;
    lastTokenTimeRef.current = null;
    peakTpsRef.current = 0;
    tokenCountRef.current = 0;

    if (thinkingMode === 'thinking') {
      setExpandedThinking((prev) => ({ ...prev, [assistantMsgId]: true }));
    }

    setMetrics({
      latency: 0,
      tps: null,
      duration: 0,
      tokens: 0,
    });

    // Millisecond ticker for real-time latency and TPS
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const updateTicker = () => {
      const now = Date.now();
      const count = tokenCountRef.current;

      if (generationStartTimeRef.current === null) {
        const elapsedWait = now - sendTimeRef.current;
        setMetrics((prev) => ({
          ...prev,
          latency: elapsedWait,
          duration: 0,
          tokens: 0,
          tps: null,
        }));
      } else {
        const effectiveNow =
          lastTokenTimeRef.current && now - lastTokenTimeRef.current > 250
            ? lastTokenTimeRef.current
            : now;
        const genElapsedMs = Math.max(10, effectiveNow - generationStartTimeRef.current);

        let currentTps: number | null = null;
        if (genElapsedMs >= 150 && count >= 2) {
          currentTps = Math.round((count / (genElapsedMs / 1000)) * 10) / 10;
        }

        if (currentTps && currentTps > peakTpsRef.current) {
          peakTpsRef.current = currentTps;
        }

        setMetrics((prev) => ({
          ...prev,
          latency: firstTokenTimeRef.current,
          duration: genElapsedMs,
          tokens: count,
          tps: currentTps !== null ? currentTps : prev.tps,
        }));
      }

      rafRef.current = requestAnimationFrame(updateTicker);
    };
    rafRef.current = requestAnimationFrame(updateTicker);

    // Filter clean conversation history (non-empty turns, no corrupted raw thinking tags)
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

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: userPrompt },
      { id: assistantMsgId, role: 'assistant', content: '', thinking: '' },
    ]);

    setIsLoading(true);

    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;

    let receivedAnyToken = false;

    try {
      // Determine if running on GitHub Pages (static site) or in AI Studio (full-stack with GitHub token proxy)
      const isGitHubPages =
        typeof window !== 'undefined' && window.location.hostname.includes('github.io');

      let endpoint = '/api/chat/stream';
      let requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      let requestBody: any = {
        prompt: userPrompt,
        messages: conversationHistory,
        enableThinking: thinkingMode === 'thinking',
      };

      if (isGitHubPages) {
        // GitHub Pages connects to the public Cloudflare API endpoint
        let publicApiUrl = FALLBACK_PUBLIC_API_URL;
        try {
          const res = await fetch('./endpoint.json?t=' + Date.now(), { signal: AbortSignal.timeout(1500) });
          if (res.ok) {
            const data = await res.json();
            if (data?.url) publicApiUrl = data.url;
          }
        } catch {}

        endpoint = publicApiUrl;
        requestHeaders['ngrok-skip-browser-warning'] = 'true';
        requestBody = {
          messages: conversationHistory,
          stream: true,
          max_tokens: 8192,
          n_predict: 8192,
          chat_template_kwargs: {
            enable_thinking: thinkingMode === 'thinking',
          },
        };
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal: abortCtrl.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Erreur de connexion (${response.status}) : impossible de joindre le modèle.`);
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

          const parts = line.split(/(?=data:\s*)/);
          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') continue;

            try {
              const event = JSON.parse(jsonStr);

              // 1. Direct OpenAI format (used by llama-server via public API / Cloudflare)
              if (event.choices && Array.isArray(event.choices) && event.choices[0]?.delta) {
                const delta = event.choices[0].delta;
                const reasoningDelta = delta.reasoning_content || delta.reasoning || '';
                const contentDelta = delta.content || '';

                if (reasoningDelta) {
                  receivedAnyToken = true;
                  const now = Date.now();
                  lastTokenTimeRef.current = now;
                  if (firstTokenTimeRef.current === null) {
                    const lat = now - sendTimeRef.current;
                    firstTokenTimeRef.current = lat;
                    generationStartTimeRef.current = now;
                    setMetrics((m) => ({ ...m, latency: lat, duration: 0 }));
                  }
                  const addedTokens = Math.max(1, Math.round(reasoningDelta.length / 3.5));
                  tokenCountRef.current += addedTokens;

                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === assistantMsgId
                        ? { ...msg, thinking: (msg.thinking || '') + reasoningDelta }
                        : msg
                    )
                  );
                }

                if (contentDelta) {
                  receivedAnyToken = true;
                  const now = Date.now();
                  lastTokenTimeRef.current = now;
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
                  const addedTokens = Math.max(1, Math.round(contentDelta.length / 3.5));
                  tokenCountRef.current += addedTokens;

                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === assistantMsgId
                        ? { ...msg, content: msg.content + contentDelta }
                        : msg
                    )
                  );
                }
              }
              // 2. Custom stream server proxy format (used by AI Studio /api/chat/stream with GitHub token)
              else if (event.type === 'reasoning') {
                receivedAnyToken = true;
                const now = Date.now();
                lastTokenTimeRef.current = now;
                if (firstTokenTimeRef.current === null) {
                  const lat = now - sendTimeRef.current;
                  firstTokenTimeRef.current = lat;
                  generationStartTimeRef.current = now;
                  setMetrics((m) => ({ ...m, latency: lat, duration: 0 }));
                }
                const addedTokens = Math.max(1, Math.round((event.delta || '').length / 3.5));
                tokenCountRef.current += addedTokens;

                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, thinking: (msg.thinking || '') + event.delta }
                      : msg
                  )
                );
              } else if (event.type === 'content') {
                receivedAnyToken = true;
                const now = Date.now();
                lastTokenTimeRef.current = now;
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
                const addedTokens = Math.max(1, Math.round((event.delta || '').length / 3.5));
                tokenCountRef.current += addedTokens;

                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, content: msg.content + event.delta }
                      : msg
                  )
                );
              } else if (event.type === 'timings' || event.timings) {
                const timingsObj = event.timings || event;
                const tpsVal = timingsObj.predicted_per_second || 0;
                const promptMs = Math.round(timingsObj.prompt_ms || 0);
                const predMs = Math.round(timingsObj.predicted_ms || 0);
                const predN = timingsObj.predicted_n || tokenCountRef.current;

                tokenCountRef.current = predN;
                setMetrics((m) => ({
                  ...m,
                  tps: tpsVal > 0 ? Math.round(tpsVal * 10) / 10 : m.tps,
                  duration: predMs > 0 ? predMs : m.duration,
                  tokens: predN,
                  latency: promptMs > 0 ? promptMs : m.latency,
                }));
              }
            } catch {
              // Ignore partial JSON chunks
            }
          }
        }
      }

      setExpandedThinking((prev) => ({ ...prev, [assistantMsgId]: false }));
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || "Erreur de connexion à l'inférence.");
      }
    } finally {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      abortControllerRef.current = null;

      // Final metrics calculation
      const lastTok = lastTokenTimeRef.current || Date.now();
      const firstTok = generationStartTimeRef.current || sendTimeRef.current;
      const exactGenMs = firstTok && lastTok > firstTok ? lastTok - firstTok : 0;
      const totalTokens = tokenCountRef.current;

      const exactGenTps =
        exactGenMs > 0 && totalTokens > 0 ? totalTokens / (exactGenMs / 1000) : null;
      const finalTps = exactGenTps || peakTpsRef.current || null;

      setMetrics((prev) => ({
        ...prev,
        latency: firstTokenTimeRef.current,
        duration:
          exactGenMs > 0
            ? exactGenMs
            : generationStartTimeRef.current
            ? Date.now() - generationStartTimeRef.current
            : prev.duration,
        tokens: totalTokens,
        tps: finalTps !== null ? Math.round(finalTps * 10) / 10 : prev.tps,
      }));

      // Never keep an empty assistant message bubble on connection failure
      if (!receivedAnyToken) {
        setMessages((prev) =>
          prev.filter((m) => !(m.id === assistantMsgId && !m.content?.trim() && !m.thinking?.trim()))
        );
      }

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
      {/* Top Header: Pure, perfectly centered metrics with no unneeded badges */}
      <header className="border-b border-neutral-200 bg-white sticky top-0 z-40 px-3 sm:px-6 py-2.5 shadow-xs">
        <div className="max-w-2xl w-full mx-auto flex items-center justify-center">
          <div className="flex items-center space-x-3 sm:space-x-5 md:space-x-6">
            {/* Latence */}
            <div className="flex flex-col items-center justify-center text-center">
              <span className="text-neutral-950 font-bold text-xs tracking-tight">Latence</span>
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
              <span className="text-neutral-950 font-bold text-xs tracking-tight">TPS</span>
              <span className="text-neutral-500 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap">
                {metrics.tps !== null ? `${metrics.tps.toFixed(1)} t/s` : '— t/s'}
              </span>
            </div>

            <div className="h-6 w-px bg-neutral-200" />

            {/* Durée */}
            <div className="flex flex-col items-center justify-center text-center">
              <span className="text-neutral-950 font-bold text-xs tracking-tight">Durée</span>
              <span className="text-neutral-500 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap">
                {metrics.duration < 1000
                  ? `${metrics.duration} ms`
                  : `${(metrics.duration / 1000).toFixed(2)} s`}
              </span>
            </div>

            <div className="h-6 w-px bg-neutral-200" />

            {/* Tokens */}
            <div className="flex flex-col items-center justify-center text-center">
              <span className="text-neutral-950 font-bold text-xs tracking-tight">Tokens</span>
              <span className="text-neutral-500 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap">
                {`${metrics.tokens} tok`}
              </span>
            </div>

            <div className="h-6 w-px bg-neutral-200" />

            {/* Reset Button */}
            <button
              type="button"
              onClick={handleResetConversation}
              disabled={(messages.length === 0 && !isLoading) || isPurgingMemory}
              title="Réinitialiser la conversation et purger la mémoire / le cache KV"
              className="flex flex-col items-center justify-center text-center group cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
            >
              <div className="flex items-center space-x-1">
                <RotateCcw
                  className={`w-3 h-3 text-neutral-950 transition-transform ${
                    isPurgingMemory ? 'animate-spin' : 'group-hover:rotate-[-45deg]'
                  }`}
                />
                <span className="text-neutral-950 font-bold text-xs tracking-tight">
                  {isPurgingMemory ? 'Purge...' : 'Reset'}
                </span>
              </div>
              <span className="text-neutral-400 font-mono text-[11px] sm:text-xs mt-0.5 whitespace-nowrap group-hover:text-neutral-700 transition-colors">
                purger KV
              </span>
            </button>
          </div>
        </div>

        {/* Purge notification banner */}
        {purgeNotice && (
          <div className="bg-neutral-900 text-white text-[11px] py-1 px-3 text-center font-mono flex items-center justify-center space-x-1.5 transition-all">
            <Check className="w-3.5 h-3.5 text-emerald-400" />
            <span>{purgeNotice}</span>
          </div>
        )}
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-3xl w-full mx-auto flex flex-col p-4 sm:p-6 space-y-6 relative">
        <div className="flex-1 flex flex-col justify-between">
          {messages.length === 0 ? (
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
                Interrogez le modèle Gemma 4 E2B exécuté en direct sur votre Codespace avec le token GitHub.
              </p>
            </div>
          ) : (
            <div className="space-y-8 pb-36">
              {messages.map((message) => {
                const isExpanded = expandedThinking[message.id] ?? false;
                const isCurrentlyThinking =
                  isLoading && message.role === 'assistant' && Boolean(message.thinking) && !message.content;

                return (
                  <div key={message.id} className="space-y-3">
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

                    <div
                      className={`text-sm leading-relaxed ${
                        message.role === 'user' ? 'text-neutral-950 font-medium' : 'text-neutral-800'
                      }`}
                    >
                      {/* Collapsible Thinking Box */}
                      {message.role === 'assistant' && Boolean(message.thinking) && (
                        <div className="mb-4 bg-white border border-neutral-200 rounded-xl overflow-hidden shadow-2xs transition-all">
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
                                {isCurrentlyThinking
                                  ? '· en cours...'
                                  : isExpanded
                                  ? '· (cliquer pour replier)'
                                  : '· terminé (cliquer pour déplier)'}
                              </span>
                            </div>

                            <div className="text-neutral-500 group-hover:text-neutral-950 transition-colors pl-2">
                              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </div>
                          </button>

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
                          <svg
                            className="w-3.5 h-3.5 animate-spin text-neutral-950"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          >
                            <circle
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeDasharray="32"
                              className="opacity-25"
                            />
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
                                      <span>Copier</span>
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

              {error && (
                <div className="p-4 border border-neutral-200 bg-white text-neutral-900 rounded-xl flex items-start space-x-3 text-xs leading-relaxed shadow-sm">
                  <AlertCircle className="w-4 h-4 text-neutral-950 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-bold">Erreur</p>
                    <p className="text-neutral-500">{error}</p>
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
            {isLoading && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-0.5" />}
          </button>
        </div>
      )}

      {/* Bottom Message Bar with Integrated Thinking Mode Selector */}
      <div className="fixed bottom-0 left-0 right-0 bg-gradient-to-t from-[#fafafa] via-[#fafafa] to-transparent pt-6 pb-5 px-4 sm:px-6 z-30">
        <div className="max-w-3xl w-full mx-auto space-y-2">
          {/* Thinking Mode Selector */}
          <div className="flex items-center justify-between px-2 text-xs">
            <div className="flex items-center space-x-1.5 text-neutral-600">
              <Brain className="w-3.5 h-3.5 text-neutral-950" />
              <span className="text-[11px] font-medium text-neutral-900 tracking-tight">Raisonnement :</span>
            </div>

            <div className="flex items-center space-x-1 bg-white border border-neutral-200 rounded-lg p-0.5 shadow-2xs">
              <button
                type="button"
                onClick={() => setThinkingMode('thinking')}
                disabled={isLoading}
                title="Active le raisonnement interne approfondi (Thinking)"
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
                title="Réponse directe ultra-rapide sans chaîne de réflexion"
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
          <form
            onSubmit={handleSend}
            className="relative bg-white border border-neutral-200 rounded-xl focus-within:border-neutral-950 transition-colors shadow-sm flex items-center"
          >
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
