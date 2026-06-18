'use strict'

/**
 * Grotesk Display docs theme for Lorenz.
 *
 * Art direction: modern product docs, deep-dark by default, with a deep
 * terminal palette. Big, tight-tracked Space Grotesk headings carry editorial
 * confidence; Inter for body; JetBrains Mono strictly for code and small
 * metadata labels. Three-column shell - grouped left sidebar, comfortable
 * content measure, right "On this page" TOC with scroll-spy. Slim top bar
 * with a wordmark, theme toggle, and a real-looking search field; the
 * section groups live only in the left sidebar, never repeated up top.
 */

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const escapeAttr = (s) => escapeHtml(s).replace(/'/g, '&#39;')

// Order groups deterministically; unknown groups fall to the end.
const GROUP_ORDER = [
  'Guide',
  'Trackers',
  'Agents',
  'Workers',
  'Features',
  'Extensions',
  'Reference',
  'Roadmap',
]

function orderedNav(nav) {
  const list = Array.isArray(nav) ? nav.slice() : []
  list.sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.group)
    const bi = GROUP_ORDER.indexOf(b.group)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })
  return list
}

function flatten(nav) {
  const out = []
  for (const grp of nav) for (const it of grp.items || []) out.push(it)
  return out
}

function renderSidebar(nav, relRoot, currentPath) {
  return nav
    .map((grp) => {
      const items = (grp.items || [])
        .map((it) => {
          const active = it.path === currentPath
          return `<li><a class="side-link${active ? ' is-active' : ''}"${
            active ? ' aria-current="page"' : ''
          } href="${relRoot}${escapeAttr(it.path)}">${escapeHtml(
            it.title
          )}</a></li>`
        })
        .join('')
      return `<section class="side-group">
  <h2 class="side-group__title">${escapeHtml(grp.group)}</h2>
  <ul class="side-list">${items}</ul>
</section>`
    })
    .join('\n')
}

function currentGroupLabel(nav, currentPath) {
  for (const grp of nav) {
    if ((grp.items || []).some((it) => it.path === currentPath))
      return grp.group
  }
  return null
}

function renderBreadcrumbs(nav, relRoot, currentPath, pageTitle, isHome) {
  if (isHome) return ''
  const group = currentGroupLabel(nav, currentPath)
  const home = `<a href="${relRoot}README.html">Docs</a>`
  const crumbGroup = group
    ? `<span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-group">${escapeHtml(
        group
      )}</span>`
    : ''
  const crumbPage = `<span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-current">${escapeHtml(
    pageTitle
  )}</span>`
  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${home}${crumbGroup}${crumbPage}</nav>`
}

function renderPrevNext(nav, relRoot, currentPath, isHome) {
  if (isHome) return ''
  const flat = flatten(nav)
  const idx = flat.findIndex((it) => it.path === currentPath)
  if (idx === -1) return ''
  const prev = idx > 0 ? flat[idx - 1] : null
  const next = idx < flat.length - 1 ? flat[idx + 1] : null
  const prevHtml = prev
    ? `<a class="pager pager--prev" href="${relRoot}${escapeAttr(prev.path)}">
  <span class="pager__dir">Previous</span>
  <span class="pager__title">${escapeHtml(prev.title)}</span>
</a>`
    : '<span class="pager pager--empty"></span>'
  const nextHtml = next
    ? `<a class="pager pager--next" href="${relRoot}${escapeAttr(next.path)}">
  <span class="pager__dir">Next</span>
  <span class="pager__title">${escapeHtml(next.title)}</span>
</a>`
    : '<span class="pager pager--empty"></span>'
  return `<nav class="pager-row" aria-label="Page navigation">${prevHtml}${nextHtml}</nav>`
}

const STYLE = `
:root{
  --font-display:"Space Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;

  --topbar-h:60px;
  --side-w:284px;
  --toc-w:236px;
  --maxw:1500px;
  --radius:12px;
  --radius-sm:8px;
}

/* ---------- DARK (default): deep terminal palette ---------- */
html[data-theme="dark"]{
  --bg:#1B181C;
  --bg-soft:#221F22;
  --panel:#2D2A2E;
  --panel-2:#353136;
  --text:#FCFCFA;
  --text-soft:#C1C0C0;
  --text-mute:#939293;
  --text-faint:#727072;
  --border:rgba(252,252,250,.09);
  --border-strong:rgba(252,252,250,.16);

  --pink:#FF6188;
  --orange:#FC9867;
  --yellow:#FFD866;
  --green:#A9DC76;
  --cyan:#78DCE8;
  --purple:#AB9DF2;

  --accent:#78DCE8;       /* cyan: links */
  --accent-2:#A9DC76;     /* green: active nav / marks */
  --accent-3:#AB9DF2;     /* purple: secondary */
  --accent-soft:rgba(120,220,232,.12);
  --accent-2-soft:rgba(169,220,118,.16);

  --code-bg:#221F22;
  --code-text:#FCFCFA;
  --code-border:rgba(252,252,250,.07);
  --code-inline-bg:rgba(171,157,242,.13);
  --code-inline-text:#C9BEFA;
  --selection:rgba(120,220,232,.22);
  --shadow:0 18px 48px -28px rgba(0,0,0,.85);
  --shadow-bar:0 1px 0 rgba(0,0,0,.5),0 10px 30px -24px rgba(0,0,0,.9);

  --tok-key:#78DCE8;
  --tok-fn:#A9DC76;
  --tok-str:#FFD866;
  --tok-num:#AB9DF2;
  --tok-com:#727072;
}

/* ---------- LIGHT: clean modern (cool off-white) ---------- */
html[data-theme="light"]{
  --bg:#F7F8FA;
  --bg-soft:#EEF0F4;
  --panel:#FFFFFF;
  --panel-2:#F2F4F7;
  --text:#1C2230;
  --text-soft:#434B5C;
  --text-mute:#6B7383;
  --text-faint:#8A92A2;
  --border:rgba(28,34,48,.10);
  --border-strong:rgba(28,34,48,.18);

  --pink:#D7245E;
  --orange:#C25A1E;
  --yellow:#9A7400;
  --green:#3E8E2E;
  --cyan:#0E8FA3;
  --purple:#6C4FD8;

  --accent:#0E8FA3;
  --accent-2:#3E8E2E;
  --accent-3:#6C4FD8;
  --accent-soft:rgba(14,143,163,.10);
  --accent-2-soft:rgba(62,142,46,.12);

  --code-bg:#1B181C;
  --code-text:#FCFCFA;
  --code-border:rgba(0,0,0,.18);
  --code-inline-bg:rgba(108,79,216,.10);
  --code-inline-text:#5836C2;
  --selection:rgba(14,143,163,.18);
  --shadow:0 18px 44px -28px rgba(20,28,46,.32);
  --shadow-bar:0 1px 0 rgba(20,28,46,.05),0 8px 24px -20px rgba(20,28,46,.4);

  --tok-key:#0E8FA3;
  --tok-fn:#3E8E2E;
  --tok-str:#9A7400;
  --tok-num:#6C4FD8;
  --tok-com:#8A92A2;
}

*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
html,body{margin:0;padding:0}
body{
  font-family:var(--font-sans);
  background:var(--bg);
  color:var(--text);
  line-height:1.68;
  font-size:16px;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
::selection{background:var(--selection)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

.skip-link{
  position:absolute;left:-9999px;top:0;z-index:200;
  background:var(--accent);color:var(--bg);font-weight:600;
  padding:.6rem 1rem;border-radius:0 0 8px 0;
}
.skip-link:focus{left:0}

/* ---------- top app bar ---------- */
.topbar{
  position:sticky;top:0;z-index:60;
  height:var(--topbar-h);
  display:flex;align-items:center;gap:16px;
  padding:0 20px;
  background:color-mix(in srgb,var(--bg) 86%,transparent);
  backdrop-filter:saturate(150%) blur(12px);
  border-bottom:1px solid var(--border);
  box-shadow:var(--shadow-bar);
}
.brand{
  display:flex;align-items:center;gap:10px;flex:0 0 auto;
  font-family:var(--font-display);font-weight:600;color:var(--text);
  letter-spacing:-.02em;
}
.brand:hover{text-decoration:none}
.brand__mark{
  width:30px;height:30px;border-radius:9px;flex:0 0 auto;position:relative;
  background:
    radial-gradient(circle at 32% 30%,var(--bg) 0 2px,transparent 2.5px),
    conic-gradient(from 210deg,var(--accent-2),var(--accent),var(--accent-2));
  box-shadow:inset 0 0 0 1px var(--border-strong);
}
.brand__mark::after{
  content:"";position:absolute;inset:8px;border-radius:50%;
  border:2px solid var(--bg);border-right-color:transparent;border-bottom-color:transparent;
  transform:rotate(8deg);
}
.brand__name{font-size:1.12rem}
.brand__tag{
  font-family:var(--font-mono);
  font-size:.62rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--accent);background:var(--accent-soft);
  padding:2px 7px;border-radius:6px;margin-left:2px;
}

.searchbox{
  flex:1 1 auto;min-width:0;max-width:420px;margin:0 auto 0 8px;
  display:flex;align-items:center;gap:9px;
  height:38px;padding:0 12px;
  background:var(--panel);
  border:1px solid var(--border);
  border-radius:10px;
  color:var(--text-mute);font-size:.9rem;cursor:text;
  transition:border-color .15s,background .15s,box-shadow .15s;
}
.searchbox:hover{border-color:var(--border-strong)}
.searchbox:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.searchbox svg{width:16px;height:16px;flex:0 0 auto;opacity:.85}
.searchbox input{
  flex:1 1 auto;border:0;outline:0;background:none;
  font-family:var(--font-sans);font-size:.9rem;color:var(--text);
  min-width:0;
}
.searchbox input::placeholder{color:var(--text-mute)}
.searchbox .kbd{
  margin-left:auto;font-family:var(--font-mono);font-size:.7rem;
  border:1px solid var(--border-strong);border-radius:5px;padding:1px 6px;
  color:var(--text-mute);background:var(--bg-soft);
}

.icon-btn{
  flex:0 0 auto;width:38px;height:38px;display:inline-flex;align-items:center;justify-content:center;
  border:1px solid var(--border);border-radius:9px;background:var(--panel);
  color:var(--text-soft);cursor:pointer;transition:background .15s,color .15s,border-color .15s;
}
.icon-btn:hover{color:var(--text);border-color:var(--border-strong);background:var(--panel-2)}
.icon-btn svg{width:18px;height:18px}
.theme-toggle .moon{display:none}
html[data-theme="dark"] .theme-toggle .sun{display:none}
html[data-theme="dark"] .theme-toggle .moon{display:inline}
.menu-btn{display:none}

/* ---------- layout shell ---------- */
.shell{
  max-width:var(--maxw);margin:0 auto;
  display:grid;
  grid-template-columns:var(--side-w) minmax(0,1fr) var(--toc-w);
  align-items:start;
}

/* ---------- sidebar ---------- */
.sidebar{
  position:sticky;top:var(--topbar-h);
  height:calc(100vh - var(--topbar-h));
  overflow-y:auto;overscroll-behavior:contain;
  padding:26px 14px 56px 22px;
  border-right:1px solid var(--border);
  scrollbar-width:thin;scrollbar-color:var(--border-strong) transparent;
}
.sidebar::-webkit-scrollbar{width:9px}
.sidebar::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
.side-group{margin-bottom:22px}
.side-group__title{
  font-family:var(--font-mono);
  font-size:.68rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
  color:var(--text-faint);margin:0 0 9px 8px;
}
.side-list{list-style:none;margin:0;padding:0;border-left:1px solid var(--border)}
.side-link{
  display:block;position:relative;
  padding:5px 10px 5px 14px;margin-left:-1px;
  font-size:.875rem;line-height:1.4;color:var(--text-soft);
  border-left:2px solid transparent;border-radius:0 7px 7px 0;
  transition:color .12s,background .12s,border-color .12s;
}
.side-link:hover{color:var(--text);background:var(--panel);text-decoration:none}
.side-link.is-active{
  color:var(--accent-2);font-weight:600;
  border-left-color:var(--accent-2);
  background:var(--accent-2-soft);
}

/* ---------- content column ---------- */
.content{min-width:0;padding:36px 52px 80px}
.content-inner{max-width:760px;margin:0 auto}

.breadcrumbs{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  font-family:var(--font-mono);font-size:.76rem;color:var(--text-mute);margin-bottom:20px;
}
.breadcrumbs a{color:var(--text-mute)}
.breadcrumbs a:hover{color:var(--accent)}
.crumb-sep{color:var(--border-strong)}
.crumb-current{color:var(--text-soft)}

/* typographic rhythm */
.prose{font-size:1rem}
.prose h1,.prose h2,.prose h3,.prose h4{font-family:var(--font-display);color:var(--text)}
.prose h1{
  font-size:clamp(2.1rem,4.4vw,2.65rem);line-height:1.08;font-weight:600;letter-spacing:-.035em;
  margin:0 0 .5em;
}
.prose h2{
  font-size:1.55rem;line-height:1.2;font-weight:600;letter-spacing:-.022em;
  margin:2.6em 0 .7em;padding-top:1.5rem;border-top:1px solid var(--border);
  scroll-margin-top:calc(var(--topbar-h) + 16px);
}
.prose h2::before{
  content:"#";color:var(--accent-2);font-weight:500;margin-right:.4em;
  opacity:.55;font-size:.85em;
}
.prose h3{
  font-size:1.2rem;font-weight:600;letter-spacing:-.015em;margin:2em 0 .5em;
  scroll-margin-top:calc(var(--topbar-h) + 16px);
}
.prose h4{
  font-size:1rem;font-weight:600;margin:1.6em 0 .4em;color:var(--text-soft);
  scroll-margin-top:calc(var(--topbar-h) + 16px);
}
.prose p{margin:0 0 1.15em}
.prose ul,.prose ol{margin:0 0 1.2em;padding-left:1.4em}
.prose li{margin:.34em 0}
.prose li::marker{color:var(--text-faint)}
.prose ul li::marker{color:var(--accent)}
.prose strong{font-weight:650;color:var(--text)}
.prose hr{border:0;border-top:1px solid var(--border);margin:2.4em 0}

.prose a{
  color:var(--accent);
  text-decoration-line:underline;
  text-decoration-color:color-mix(in srgb,var(--accent) 38%,transparent);
  text-underline-offset:2px;
}
.prose a:hover{text-decoration-color:var(--accent)}

/* inline code */
.prose :not(pre)>code{
  font-family:var(--font-mono);font-size:.82em;
  background:var(--code-inline-bg);color:var(--code-inline-text);
  padding:.13em .4em;border-radius:5px;
  border:1px solid color-mix(in srgb,var(--code-inline-text) 18%,transparent);
  word-break:break-word;
}

/* code blocks - editor feel */
.prose pre{
  position:relative;
  background:var(--code-bg);color:var(--code-text);
  border-radius:var(--radius);
  padding:42px 18px 18px;margin:0 0 1.5em;
  overflow-x:auto;line-height:1.62;font-size:.855rem;
  border:1px solid var(--code-border);
  box-shadow:var(--shadow);
  scrollbar-width:thin;scrollbar-color:rgba(252,252,250,.2) transparent;
}
.prose pre::before{
  content:"";position:absolute;top:14px;left:16px;
  width:11px;height:11px;border-radius:50%;
  background:#78DCE8;
  box-shadow:18px 0 0 #FFD866,36px 0 0 #A9DC76;
  opacity:.9;
}
.prose pre::-webkit-scrollbar{height:10px}
.prose pre::-webkit-scrollbar-thumb{background:rgba(252,252,250,.18);border-radius:6px}
.prose pre code{
  font-family:var(--font-mono);background:none;border:0;padding:0;color:inherit;font-size:inherit;
}

/* tables -> horizontally scrollable inside the column */
.table-scroll{
  overflow-x:auto;margin:0 0 1.5em;
  border:1px solid var(--border);border-radius:var(--radius);
  scrollbar-width:thin;scrollbar-color:var(--border-strong) transparent;
}
.table-scroll::-webkit-scrollbar{height:9px}
.table-scroll::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:6px}
.prose table{
  width:100%;border-collapse:collapse;font-size:.86rem;margin:0;min-width:100%;
}
/* tables not wrapped by the builder still scroll their own block */
.prose>table{display:block;overflow-x:auto;margin:0 0 1.5em}
.prose thead th{
  font-family:var(--font-mono);
  text-align:left;font-weight:600;font-size:.7rem;letter-spacing:.04em;text-transform:uppercase;
  color:var(--text-soft);background:var(--panel-2);
  padding:10px 14px;border-bottom:1px solid var(--border-strong);white-space:nowrap;
}
.prose tbody td{
  padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:top;color:var(--text-soft);
}
.prose tbody tr:last-child td{border-bottom:0}
.prose tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--panel) 50%,transparent)}
.prose td code,.prose th code{white-space:nowrap}

/* blockquotes */
.prose blockquote{
  margin:0 0 1.4em;padding:14px 18px;
  background:var(--accent-soft);
  border-left:3px solid var(--accent);
  border-radius:0 var(--radius-sm) var(--radius-sm) 0;
  color:var(--text-soft);
}
.prose blockquote p:last-child{margin-bottom:0}

/* figures / images */
.prose figure{margin:1.9em 0;text-align:center}
.prose img{max-width:100%;height:auto;display:inline-block;border-radius:var(--radius)}
.prose figure img{border:1px solid var(--border)}
.prose img[src*="diagrams/"]{border:0}
.prose figcaption{
  font-family:var(--font-mono);font-size:.74rem;color:var(--text-mute);margin-top:.7em;
}

/* pager */
.pager-row{
  display:grid;grid-template-columns:1fr 1fr;gap:14px;
  margin-top:3rem;padding-top:1.6rem;border-top:1px solid var(--border);
}
.pager{
  display:flex;flex-direction:column;gap:3px;
  padding:14px 16px;border:1px solid var(--border);border-radius:var(--radius);
  background:var(--panel);transition:border-color .15s,background .15s,transform .12s;
}
.pager:hover{border-color:var(--accent);text-decoration:none;background:var(--panel-2);transform:translateY(-1px)}
.pager--next{text-align:right}
.pager--empty{border:0;background:none;pointer-events:none}
.pager__dir{font-family:var(--font-mono);font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;color:var(--text-mute);font-weight:600}
.pager__title{font-family:var(--font-display);font-weight:500;letter-spacing:-.01em;color:var(--accent)}

/* footer */
.doc-footer{
  margin-top:2.4rem;padding-top:1.4rem;border-top:1px solid var(--border);
  font-family:var(--font-mono);font-size:.76rem;color:var(--text-mute);
  display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
}

/* ---------- right TOC ---------- */
.toc{
  position:sticky;top:var(--topbar-h);
  height:calc(100vh - var(--topbar-h));
  overflow-y:auto;padding:36px 22px 56px 10px;
  scrollbar-width:thin;scrollbar-color:var(--border-strong) transparent;
}
.toc__title{
  font-family:var(--font-mono);
  font-size:.68rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
  color:var(--text-faint);margin:0 0 10px;
}
.toc__list{list-style:none;margin:0;padding:0;border-left:1px solid var(--border)}
.toc__list a{
  display:block;padding:4px 12px;margin-left:-1px;
  font-size:.82rem;line-height:1.4;color:var(--text-mute);
  border-left:2px solid transparent;
  transition:color .12s,border-color .12s;
}
.toc__list a:hover{color:var(--text);text-decoration:none}
.toc__list a.lvl-3{padding-left:24px;font-size:.8rem}
.toc__list a.is-active{color:var(--accent);border-left-color:var(--accent);font-weight:600}
.toc__empty{font-size:.8rem;color:var(--text-mute)}

/* ---------- home ---------- */
.hero{margin:6px 0 18px;padding:18px 0 30px;border-bottom:1px solid var(--border)}
.hero__eyebrow{
  display:inline-flex;align-items:center;gap:8px;
  font-family:var(--font-mono);
  font-size:.7rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--accent);background:var(--accent-soft);
  padding:5px 12px;border-radius:7px;margin-bottom:20px;
}
.hero__eyebrow .dot{
  width:7px;height:7px;border-radius:50%;background:var(--accent-2);
  box-shadow:0 0 0 3px var(--accent-2-soft);
}
.hero h1{
  font-family:var(--font-display);
  font-size:clamp(2.4rem,6vw,3.4rem);line-height:1.04;letter-spacing:-.04em;font-weight:600;
  margin:0 0 .45em;color:var(--text);
}
.hero h1 .accent{
  background:linear-gradient(100deg,var(--accent-2),var(--accent));
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
.hero__lede{font-size:1.16rem;color:var(--text-soft);max-width:58ch;margin:0 0 26px}
.hero__cta{display:flex;gap:12px;flex-wrap:wrap}
.btn{
  display:inline-flex;align-items:center;gap:8px;
  padding:11px 20px;border-radius:10px;font-weight:600;font-size:.95rem;
  font-family:var(--font-sans);
  transition:transform .12s,box-shadow .15s,background .15s,border-color .15s;
}
.btn--primary{background:var(--accent);color:var(--bg);box-shadow:0 12px 26px -14px var(--accent)}
.btn--primary:hover{text-decoration:none;transform:translateY(-1px);box-shadow:0 16px 30px -14px var(--accent)}
.btn--ghost{background:var(--panel);color:var(--text);border:1px solid var(--border-strong)}
.btn--ghost:hover{text-decoration:none;border-color:var(--accent);color:var(--accent)}

/* ---------- mobile scrim ---------- */
.scrim{
  display:none;position:fixed;inset:var(--topbar-h) 0 0;z-index:55;
  background:rgba(0,0,0,.5);backdrop-filter:blur(2px);
}

@media (max-width:1180px){
  :root{--toc-w:0px}
  .shell{grid-template-columns:var(--side-w) minmax(0,1fr)}
  .toc{display:none}
}
@media (max-width:920px){
  .shell{grid-template-columns:minmax(0,1fr)}
  .content{padding:28px 26px 70px}
  .menu-btn{display:inline-flex}
  .searchbox{max-width:none}
  .sidebar{
    position:fixed;top:var(--topbar-h);left:0;z-index:56;
    width:min(86vw,330px);
    background:var(--bg);
    transform:translateX(-102%);
    transition:transform .22s ease;
    box-shadow:0 20px 50px -20px rgba(0,0,0,.6);
  }
  body.nav-open .sidebar{transform:translateX(0)}
  body.nav-open .scrim{display:block}
}
@media (max-width:560px){
  .searchbox .kbd{display:none}
  .brand__tag{display:none}
  .content{padding:24px 16px 64px}
  .pager-row{grid-template-columns:1fr}
  .pager--next{text-align:left}
}
@media (prefers-reduced-motion:reduce){
  *{scroll-behavior:auto !important;transition:none !important}
}
`

const SCRIPT = `
(function(){
  var root=document.documentElement;
  function bind(){
    var tgl=document.getElementById('theme-toggle');
    if(tgl){tgl.addEventListener('click',function(){
      var cur=root.getAttribute('data-theme')==='dark'?'light':'dark';
      root.setAttribute('data-theme',cur);
      try{localStorage.setItem('lorenz-theme',cur);}catch(e){}
    });}
    var menu=document.getElementById('menu-btn');
    var scrim=document.getElementById('scrim');
    function close(){document.body.classList.remove('nav-open');}
    if(menu){menu.addEventListener('click',function(){document.body.classList.toggle('nav-open');});}
    if(scrim){scrim.addEventListener('click',close);}
    document.querySelectorAll('.sidebar a').forEach(function(a){a.addEventListener('click',close);});
    document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});

    // focus search with "/"
    var search=document.getElementById('docsearch');
    if(search){document.addEventListener('keydown',function(e){
      if(e.key==='/'&&document.activeElement!==search){e.preventDefault();search.focus();}
    });}

    // build right TOC from h2/h3
    var main=document.getElementById('content-main');
    var tocList=document.getElementById('toc-list');
    if(main&&tocList){
      var heads=main.querySelectorAll('.prose h2, .prose h3');
      var built=[];
      heads.forEach(function(h){
        if(!h.id){
          var slug=(h.textContent||'').toLowerCase().trim()
            .replace(/[^a-z0-9\\s-]/g,'').replace(/\\s+/g,'-').replace(/-+/g,'-');
          if(!slug)slug='section';
          var id=slug,n=1;
          while(document.getElementById(id)){id=slug+'-'+(n++);}
          h.id=id;
        }
        var li=document.createElement('li');
        var a=document.createElement('a');
        a.href='#'+h.id;
        a.textContent=h.textContent;
        a.className=h.tagName==='H3'?'lvl-3':'lvl-2';
        li.appendChild(a);
        tocList.appendChild(li);
        built.push({id:h.id,link:a,el:h});
      });
      var tocWrap=document.getElementById('toc');
      if(built.length===0){
        if(tocWrap){
          tocList.remove();
          var e=document.createElement('p');
          e.className='toc__empty';e.textContent='No sections on this page.';
          tocWrap.appendChild(e);
        }
      }else{
        var active=null;
        function spy(){
          var off=(parseInt(getComputedStyle(root).getPropertyValue('--topbar-h'))||60)+24;
          var top=window.scrollY+off;
          var cur=built[0];
          for(var i=0;i<built.length;i++){
            if(built[i].el.offsetTop<=top)cur=built[i];else break;
          }
          if(cur!==active){
            if(active)active.link.classList.remove('is-active');
            cur.link.classList.add('is-active');
            active=cur;
          }
        }
        var ticking=false;
        window.addEventListener('scroll',function(){
          if(!ticking){window.requestAnimationFrame(function(){spy();ticking=false;});ticking=true;}
        },{passive:true});
        spy();
      }
    }

    // scroll active sidebar item into view
    var act=document.querySelector('.side-link.is-active');
    if(act&&act.scrollIntoView){act.scrollIntoView({block:'center'});}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);
  else bind();
})();
`

const SEARCH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
const SUN_SVG =
  '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>'
const MOON_SVG =
  '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.4 6.4 0 0 0 10.5 10.5Z"/></svg>'
const MENU_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'
const ARROW_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'

function render({
  siteTitle,
  pageTitle,
  bodyHtml,
  nav,
  relRoot,
  currentPath,
  isHome,
}) {
  const navArr = orderedNav(nav)
  const sidebar = renderSidebar(navArr, relRoot, currentPath)
  const breadcrumbs = renderBreadcrumbs(
    navArr,
    relRoot,
    currentPath,
    pageTitle,
    isHome
  )
  const pager = renderPrevNext(navArr, relRoot, currentPath, isHome)

  const title = isHome
    ? `${escapeHtml(siteTitle)} Docs`
    : `${escapeHtml(pageTitle)} - ${escapeHtml(siteTitle)} Docs`

  let hero = ''
  if (isHome) {
    hero = `<div class="hero">
  <span class="hero__eyebrow"><span class="dot"></span>Control plane for coding agents</span>
  <h1>Tracker issues in. <span class="accent">Agent runs out.</span></h1>
  <p class="hero__lede">Lorenz is a control plane that turns tracker issues into coding-agent runs. It dispatches the work to a fleet of agents and isolated workers, then reports back where your team already lives.</p>
  <div class="hero__cta">
    <a class="btn btn--primary" href="${relRoot}getting-started.html">Get started ${ARROW_SVG}</a>
    <a class="btn btn--ghost" href="${relRoot}architecture.html">How it works</a>
  </div>
</div>`
  }

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="color-scheme" content="dark light">
<meta name="description" content="${escapeAttr(siteTitle)} documentation - ${escapeAttr(pageTitle)}">
<script>
(function(){try{var t=localStorage.getItem('lorenz-theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;450;500;600;650;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<a class="skip-link" href="#content-main">Skip to content</a>
<header class="topbar">
  <button id="menu-btn" class="icon-btn menu-btn" aria-label="Toggle navigation" aria-controls="sidebar">${MENU_SVG}</button>
  <a class="brand" href="${relRoot}README.html" aria-label="${escapeAttr(siteTitle)} docs home">
    <span class="brand__mark" aria-hidden="true"></span>
    <span class="brand__name">${escapeHtml(siteTitle)}</span>
    <span class="brand__tag">Docs</span>
  </a>
  <div class="searchbox" role="search">
    ${SEARCH_SVG}
    <input id="docsearch" type="search" placeholder="Search the docs" aria-label="Search the documentation" autocomplete="off">
    <span class="kbd" aria-hidden="true">/</span>
  </div>
  <button id="theme-toggle" class="icon-btn theme-toggle" aria-label="Toggle dark mode" title="Toggle theme">${SUN_SVG}${MOON_SVG}</button>
</header>

<div class="scrim" id="scrim" aria-hidden="true"></div>

<div class="shell">
  <aside class="sidebar" id="sidebar" aria-label="Documentation navigation">
    ${sidebar}
  </aside>

  <main class="content" id="content-main">
    <div class="content-inner">
      ${breadcrumbs}
      ${hero}
      <article class="prose">
${bodyHtml}
      </article>
      ${pager}
      <footer class="doc-footer">
        <span>&copy; ${new Date().getFullYear()} ${escapeHtml(siteTitle)}</span>
        <span>Issues in, agent runs out.</span>
      </footer>
    </div>
  </main>

  <aside class="toc" id="toc" aria-label="On this page">
    <p class="toc__title">On this page</p>
    <ul class="toc__list" id="toc-list"></ul>
  </aside>
</div>

<script>${SCRIPT}</script>
</body>
</html>`
}

module.exports = {
  name: 'grotesk',
  label: 'Grotesk Display',
  render,
}
