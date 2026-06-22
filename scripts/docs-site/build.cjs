#!/usr/bin/env node
/*
 * Builds the documentation website from docs/ into _site/.
 *
 * A lightweight, dependency-light static build: each docs/*.md is rendered to
 * HTML (via the `marked` CLI through npx) and wrapped in the site theme
 * (scripts/docs-site/theme.cjs), which owns all layout and styling. Diagrams
 * (docs/assets/diagrams) and screenshots (docs/images) are copied verbatim.
 *
 * All links and asset references are relative, so the output works under any
 * base path (e.g. a project GitHub Pages site at /<repo>/).
 *
 * Usage: node scripts/docs-site/build.cjs [outDir]   (default outDir: _site)
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '..', '..')
const DOCS = path.join(REPO, 'docs')
const OUT = path.resolve(REPO, process.argv[2] || '_site')
const theme = require('./theme.cjs')

const GROUPS = { '': 'Guide', trackers: 'Trackers', agents: 'Agents', workers: 'Workers', features: 'Features', extensions: 'Extensions', reference: 'Reference', roadmap: 'Roadmap' }
const GROUP_ORDER = ['', 'trackers', 'agents', 'workers', 'features', 'extensions', 'reference', 'roadmap']
const TOP_ORDER = ['README.md', 'getting-started.md', 'how-it-works.md', 'architecture.md', 'source-map.md', 'cli.md', 'workflows.md', 'dispatch.md', 'workspace.md', 'agent-orchestrator.md', 'observability.md', 'security.md', 'troubleshooting.md']

function walk(d) {
  const o = []
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) o.push(...walk(p))
    else if (e.name.endsWith('.md')) o.push(p)
  }
  return o
}
function titleOf(rel, md) {
  const m = md.match(/^#\s+(.+)$/m)
  if (m) return m[1].trim()
  const b = path.basename(rel, '.md')
  if (b === 'README') return 'Overview'
  return b.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
function renderMarkdown(absPath) {
  // marked writes to stdout; --gfm for tables/strikethrough etc.
  return execFileSync('npx', ['-y', 'marked@12', '--gfm', '-i', absPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const pages = walk(DOCS).map((abs) => {
  const rel = path.relative(DOCS, abs)
  const md = fs.readFileSync(abs, 'utf8')
  return { abs, rel, out: rel.replace(/\.md$/, '.html'), group: rel.includes('/') ? rel.split('/')[0] : '', title: titleOf(rel, md), depth: rel.split('/').length - 1 }
})
pages.sort((a, b) => {
  const ga = GROUP_ORDER.indexOf(a.group), gb = GROUP_ORDER.indexOf(b.group)
  if (ga !== gb) return ga - gb
  if (a.group === '') return ((TOP_ORDER.indexOf(a.rel) + 1) || 99) - ((TOP_ORDER.indexOf(b.rel) + 1) || 99)
  return a.rel.localeCompare(b.rel)
})
for (const p of pages) {
  let body = renderMarkdown(p.abs)
  body = body.replace(/href="([^"]+?)\.md(#[^"]*)?"/g, (m, t, a) => t.startsWith('http') ? m : `href="${t}.html${a || ''}"`)
  body = body.replace(/href="\.\.\/README\.html"/g, 'href="https://github.com/ryanlyn/lorenz"')
  p.body = body
}

const nav = GROUP_ORDER.filter((g) => pages.some((p) => p.group === g)).map((g) => ({
  group: GROUPS[g],
  items: pages.filter((p) => p.group === g).map((p) => ({ title: p.title === 'Overview' && g ? GROUPS[g] + ' overview' : p.title, path: p.out })),
}))

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
for (const p of pages) {
  const relRoot = '../'.repeat(p.depth)
  const html = theme.render({ siteTitle: 'Lorenz', pageTitle: p.title, bodyHtml: p.body, nav, relRoot, currentPath: p.out, isHome: p.rel === 'README.md' })
  const dest = path.join(OUT, p.out)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, html)
}
fs.cpSync(path.join(DOCS, 'assets'), path.join(OUT, 'assets'), { recursive: true })
if (fs.existsSync(path.join(DOCS, 'images'))) fs.cpSync(path.join(DOCS, 'images'), path.join(OUT, 'images'), { recursive: true })
fs.writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><meta http-equiv="refresh" content="0; url=README.html"><link rel="canonical" href="README.html">')
fs.writeFileSync(path.join(OUT, '.nojekyll'), '')

console.log(`Built ${pages.length} pages to ${path.relative(REPO, OUT)}/`)
