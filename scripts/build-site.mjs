// Builds the deckwerk.org website into dist-site/.
//
//   node scripts/build-site.mjs
//
// The site itself is static HTML in site/. This script copies it and renders
// the user manual (manual/*.md) into HTML pages under /manual/, wrapped in the
// same chrome as the landing page. Plain Node plus `marked`, so the Pages
// workflow does not need the Electron toolchain.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(root, 'site');
const manual = resolve(root, 'manual');
const out = resolve(root, 'dist-site');

rmSync(out, { recursive: true, force: true });
cpSync(site, out, { recursive: true });

const shell = readFileSync(resolve(site, 'manual-shell.html'), 'utf8');

const chapters = readdirSync(manual)
  .filter((f) => /^\d+-.*\.md$/.test(f))
  .sort()
  .map((file) => {
    const md = readFileSync(resolve(manual, file), 'utf8');
    const slug = file.replace(/\.md$/, '');
    const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? slug).trim();
    return { file, slug, title, md };
  });

// Chapters link to one another as `06-headless-server.md`; on the site each
// chapter lives at /manual/<slug>/.
const renderer = new marked.Renderer();
const baseLink = renderer.link.bind(renderer);
renderer.link = function (token) {
  const m = token.href.match(/^(\d+-[\w-]+)\.md(#.*)?$/);
  if (m) token.href = `../${m[1]}/${m[2] ?? ''}`;
  return baseLink(token);
};
// "> Screenshot placeholder: …" notes are authoring reminders, not content.
renderer.blockquote = function (token) {
  if (/^Screenshot placeholder:/i.test(token.text.trim())) return '';
  return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>\n`;
};
marked.use({ renderer, gfm: true });

const nav = (current) =>
  chapters
    .map((c, i) => {
      const n = String(i + 1).padStart(2, '0');
      const cls = c.slug === current ? ' class="current"' : '';
      return `<li${cls}><a href="/manual/${c.slug}/"><span class="n">${n}</span>${c.title}</a></li>`;
    })
    .join('\n');

const page = ({ title, body, current, prev, next }) => {
  const pager = [
    prev ? `<a class="prev" href="/manual/${prev.slug}/">← ${prev.title}</a>` : '<span></span>',
    next ? `<a class="next" href="/manual/${next.slug}/">${next.title} →</a>` : '<span></span>',
  ].join('');
  return shell
    .replaceAll('{{title}}', title)
    .replace('{{nav}}', nav(current))
    .replace('{{body}}', body)
    .replace('{{pager}}', pager);
};

mkdirSync(resolve(out, 'manual'), { recursive: true });
chapters.forEach((c, i) => {
  const dir = resolve(out, 'manual', c.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, 'index.html'),
    page({
      title: c.title,
      body: marked.parse(c.md),
      current: c.slug,
      prev: chapters[i - 1],
      next: chapters[i + 1],
    }),
  );
});

// /manual/ is a table of contents.
const toc = `
<h1>User manual</h1>
<p class="lede">The manual covers the workflows that make DeckWerk distinctive. Everything else works the way you would expect from a slide editor.</p>
<ol class="toc">
${chapters.map((c) => `<li><a href="/manual/${c.slug}/">${c.title}</a></li>`).join('\n')}
</ol>`;
writeFileSync(resolve(out, 'manual', 'index.html'), page({ title: 'Manual', body: toc, current: null }));

console.log(`site -> ${out} (${chapters.length} manual chapters)`);
