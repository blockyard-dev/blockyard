import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import discordGuide from './discord.md?raw';

/**
 * Public-facing documentation lives in Markdown; this component is only its shell.
 * Keeping prose out of JSX makes each future extension guide a reviewable document
 * instead of another screen implementation.
 */
export function DocsPage() {
  useEffect(() => {
    const previousTitle = document.title;
    const previousLanguage = document.documentElement.lang;
    document.title = 'Set up a Discord bot token | Blockyard Docs';
    document.documentElement.lang = 'en';
    return () => {
      document.title = previousTitle;
      document.documentElement.lang = previousLanguage;
    };
  }, []);

  return (
    <div className="docs-shell">
      <header className="docs-header">
        <a className="docs-brand" href="/">Blockyard</a>
        <span>Docs</span>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar" aria-label="Documentation navigation">
          <p>Extensions</p>
          <a aria-current="page" href="/docs/discord/">Discord</a>
        </aside>
        <main className="docs-content">
          <ReactMarkdown
            components={{
              a: ({ href, children, ...props }) => {
                const external = href?.startsWith('http');
                return (
                  <a
                    {...props}
                    href={href}
                    {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
                  >
                    {children}
                  </a>
                );
              },
            }}
          >
            {discordGuide}
          </ReactMarkdown>
        </main>
      </div>
    </div>
  );
}
