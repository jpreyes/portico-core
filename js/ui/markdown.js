// markdown.js — a tiny, dependency-free Markdown → HTML renderer, just enough for the
// project's own docs (manuals + tutorials) rendered inside the Help overlay, offline.
// Supports: headings, GFM pipe tables, fenced code, blockquotes, ordered/unordered
// lists, images, links, bold/italic/inline-code, horizontal rules, a whitelist of
// inline tags (sub/sup/br…), and HTML-comment stripping (incl. `<!-- pagebreak -->`).
// Relative image/link URLs are resolved against the document's base directory so the
// figures load when served by serve.py. Internal `.md` links become `data-doc` anchors
// the viewer intercepts to load in place. Content is our own repo files (trusted), but
// text is still HTML-escaped before markup is applied.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Resolve a possibly-relative URL against a base directory (e.g. 'docs/tutorials/'),
// collapsing '.' and '..'. Absolute (scheme://, /, #, data:) URLs pass through.
function resolveUrl(base, url) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#|data:)/i.test(url)) return url;
  const out = [];
  for (const p of (base + url).split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

// Inline spans: code, escaping, whitelisted tags, images, links, bold/italic. Inline
// code is pulled out first behind a §§n§§ sentinel (survives escaping, absent from prose)
// and restored last so its content is never touched by the other passes.
function inline(s, base) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(esc(c)); return `§§${codes.length - 1}§§`; });
  s = esc(s);
  s = s.replace(/&lt;(\/?(?:sub|sup|br|b|i|em|strong|kbd))\s*\/?&gt;/gi, '<$1>');
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, alt, url) => `<img alt="${alt.replace(/"/g, '&quot;')}" src="${resolveUrl(base, url.trim())}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) => {
    url = url.trim();
    const abs = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    if (url.startsWith('#')) return `<a href="${url}">${txt}</a>`;   // same-page anchor, no new tab
    if (!abs && /\.md(#|$)/i.test(url))
      return `<a href="#" data-doc="${resolveUrl(base, url.replace(/#.*$/, ''))}">${txt}</a>`;
    const href = abs ? url : resolveUrl(base, url);
    return `<a href="${href}" target="_blank" rel="noopener">${txt}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/§§(\d+)§§/g, (_, n) => `<code>${codes[+n]}</code>`);
  return s;
}

const isSep = (l) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(l || '');
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** Render Markdown text to an HTML string. `base` is the document's directory. */
export function renderMarkdown(md, base = '') {
  md = md.replace(/<!--[\s\S]*?-->/g, '');
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const inl = (s) => inline(s, base);
  const out = [];
  let i = 0;
  const blockStart = (l) => /^(#{1,6})\s|^\s*```|^\s*>|^\s*([-*+]|\d+\.)\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^\s*```/.test(line)) {                                   // fenced code
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    const m = line.match(/^(#{1,6})\s+(.*)$/);                    // heading (GitHub-style slug id)
    if (m) {
      const l = m[1].length, raw = m[2].trim();
      const id = raw.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
      out.push(`<h${l} id="${id}">${inl(raw)}</h${l}>`);
      i++; continue;
    }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }   // hr

    if (line.includes('|') && isSep(lines[i + 1])) {             // GFM table
      const head = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      let t = '<table><thead><tr>' + head.map((c) => `<th>${inl(c)}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of rows) t += '<tr>' + r.map((c) => `<td>${inl(c)}</td>`).join('') + '</tr>';
      out.push(t + '</tbody></table>');
      continue;
    }
    if (/^\s*>\s?/.test(line)) {                                  // blockquote
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + renderMarkdown(buf.join('\n'), base) + '</blockquote>');
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {                      // list
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let it = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !blockStart(lines[i]))
          it += ' ' + lines[i++].trim();
        items.push(it);
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((it) => `<li>${inl(it)}</li>`).join('') + `</${tag}>`);
      continue;
    }
    const buf = [line]; i++;                                      // paragraph
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !blockStart(lines[i]) && !(lines[i].includes('|') && isSep(lines[i + 1])))
      buf.push(lines[i++]);
    out.push('<p>' + inl(buf.join(' ')) + '</p>');
  }
  return out.join('\n');
}

export default { renderMarkdown };
