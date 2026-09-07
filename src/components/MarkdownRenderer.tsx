import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Copy, Check, Terminal, Sigma } from 'lucide-react';
import katex from 'katex';

interface MarkdownRendererProps {
  content: string;
  isThinking?: boolean;
}

// Pre-process math expressions to ensure all forms of LaTeX delimiters (\[ \], \( \), $$ $$, $ $) are captured
function formatMathDelimiters(text: string): string {
  if (!text) return '';
  let res = text;
  // Convert \[ ... \] to $$ ... $$
  res = res.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n$$\n${math.trim()}\n$$\n`);
  // Convert \( ... \) to $ ... $
  res = res.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`);
  return res;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, isThinking = false }) => {
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(id);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const processedContent = formatMathDelimiters(content);

  return (
    <div className={`markdown-body text-[13px] sm:text-[14px] leading-relaxed break-words ${isThinking ? 'text-neutral-700' : 'text-neutral-900'}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-base sm:text-lg font-bold text-neutral-950 mt-4 mb-2 pb-1 border-b border-neutral-200">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm sm:text-base font-bold text-neutral-950 mt-3 mb-1.5">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-xs sm:text-sm font-semibold text-neutral-900 mt-2.5 mb-1">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-2 last:mb-0 leading-relaxed text-inherit">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 mb-2.5 space-y-1 text-inherit">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 mb-2.5 space-y-1 text-inherit">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed text-inherit">
              {children}
            </li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-neutral-300 pl-3 py-0.5 my-2 text-neutral-600 italic bg-neutral-50/50 rounded-r">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-3 border border-neutral-200 rounded-lg">
              <table className="min-w-full text-xs sm:text-sm text-left divide-y divide-neutral-200">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-neutral-100 font-semibold text-neutral-900">
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-neutral-100 bg-white">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-neutral-50/60 transition-colors">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2">
              {children}
            </td>
          ),
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !String(children).includes('\n');
            const codeString = String(children).replace(/\n$/, '');
            const lang = match ? match[1] : '';

            // If it's a dedicated math / latex code block, render with KaTeX math block preview
            if (lang === 'latex' || lang === 'math' || lang === 'katex') {
              try {
                const html = katex.renderToString(codeString, {
                  displayMode: true,
                  throwOnError: false,
                });
                return (
                  <div className="my-2.5 rounded-lg border border-neutral-200 bg-neutral-50/80 p-3 overflow-x-auto relative group">
                    <div className="flex items-center justify-between text-[11px] font-mono text-neutral-500 mb-1.5 pb-1 border-b border-neutral-200/60">
                      <span className="flex items-center space-x-1 font-semibold text-neutral-700">
                        <Sigma className="w-3.5 h-3.5" />
                        <span>Formule Mathématique</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy(codeString, `math-${codeString.slice(0, 10)}`)}
                        className="hover:text-neutral-900 transition-colors flex items-center space-x-1 cursor-pointer"
                        title="Copier la formule LaTeX"
                      >
                        {copiedIndex === `math-${codeString.slice(0, 10)}` ? (
                          <Check className="w-3 h-3 text-emerald-600" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>{copiedIndex === `math-${codeString.slice(0, 10)}` ? 'Copié' : 'Copier'}</span>
                      </button>
                    </div>
                    <div
                      className="py-1 text-neutral-900 overflow-x-auto text-sm sm:text-base flex justify-center"
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  </div>
                );
              } catch {
                // Fallback to regular code block
              }
            }

            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-800 font-mono text-[12px] sm:text-[13px] border border-neutral-200/80"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            const blockId = `code-${Math.random().toString(36).slice(2, 7)}`;

            return (
              <div className="my-3 rounded-lg overflow-hidden border border-neutral-800 bg-neutral-950 text-neutral-100 text-xs sm:text-sm">
                <div className="flex items-center justify-between px-3 py-1.5 bg-neutral-900 border-b border-neutral-800 text-[11px] font-mono text-neutral-400">
                  <div className="flex items-center space-x-1.5">
                    <Terminal className="w-3.5 h-3.5 text-neutral-500" />
                    <span>{lang || 'code'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(codeString, blockId)}
                    className="flex items-center space-x-1 hover:text-white transition-colors cursor-pointer"
                    title="Copier le code"
                  >
                    {copiedIndex === blockId ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span className="text-emerald-400">Copié</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copier</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-3 overflow-x-auto font-mono text-[12px] sm:text-[13px] leading-relaxed">
                  <code>{children}</code>
                </pre>
              </div>
            );
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};
