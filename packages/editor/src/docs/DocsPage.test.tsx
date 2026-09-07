import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocsPage } from './DocsPage';

describe('Discord documentation', () => {
  it('renders the Markdown guide as an English documentation page', () => {
    const html = renderToStaticMarkup(<DocsPage />);
    expect(html).toContain('<h1>Set up a Discord bot token</h1>');
    expect(html).toContain('Message Content Intent');
    expect(html).toContain('https://discord.com/developers/applications');
    expect(html).not.toContain('# Set up a Discord bot token');
  });
});
