// Phase 19.2 — renders runbooks/go-live.md as docs-site/go-live.html: one self-contained page
// (inline CSS and a small inline script, Google Fonts only) with collapsible sections and a tick box
// per step, so the operator can work through the launch as a checklist. The Markdown stays the
// source: scripts/setup/render-go-live.ts writes the page and go-live-html.test.ts fails when the
// committed page is out of date.
//
// The converter handles only what the guide uses: #/##/### headings, paragraphs, "-" and "1."
// lists (nested by indentation, indented continuation lines), fenced code, pipe tables, **bold**,
// `code` and [links](url). Relative runbook links point at the repository on GitHub.

export const REPO_BLOB =
  'https://github.com/infoworksdomain-blip/PostmindStudio/blob/main/runbooks/';

/** Sections that are reference material, not steps to tick. */
const NO_CHECKBOX = /^(Troubleshooting|Sources)$/;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkHref(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  if (/^[a-z0-9-]+\.md(#.*)?$/.test(url)) return `${REPO_BLOB}${url}`;
  return url;
}

/** Inline Markdown → HTML: code spans first (their content is literal), then links and bold. */
export function inline(text: string): string {
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
          const href = linkHref(url.replace(/&amp;/g, '&'));
          return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    })
    .join('');
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface ListItem {
  /** [0] = the item's inline text; later entries are complete HTML blocks (<p>, code). */
  html: string[];
  children: ListNode | null;
}
interface ListNode {
  ordered: boolean;
  indent: number;
  items: ListItem[];
}

const LIST_LINE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function renderList(node: ListNode): string {
  const tag = node.ordered ? 'ol' : 'ul';
  const items = node.items
    .map((item) => {
      const [first, ...rest] = item.html;
      const more = rest.join('');
      const kids = item.children ? renderList(item.children) : '';
      return `<li>${first ?? ''}${more}${kids}</li>`;
    })
    .join('');
  return `<${tag}>${items}</${tag}>`;
}

/** The list item an indented line continues: the last item of the deepest list indented less. */
function continuationOwner(stack: ListNode[], line: string): ListItem | null {
  const indent = line.length - line.trimStart().length;
  for (let i = stack.length - 1; i >= 0; i--) {
    const node = stack[i]!;
    if (node.indent < indent) return node.items[node.items.length - 1] ?? null;
  }
  return null;
}

function renderTable(rows: string[]): string {
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const [head, , ...body] = rows;
  const th = cells(head ?? '')
    .map((c) => `<th scope="col">${inline(c)}</th>`)
    .join('');
  const trs = body
    .map(
      (r) =>
        `<tr>${cells(r)
          .map((c) => `<td>${inline(c)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

/** Markdown blocks (between headings) → HTML. */
export function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let listRoot: ListNode | null = null;
  let stack: ListNode[] = [];
  let lastItem: ListItem | null = null;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listRoot) out.push(renderList(listRoot));
    listRoot = null;
    stack = [];
    lastItem = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      flushParagraph();
      const lang = line.slice(3).trim();
      const code: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1]!.startsWith('```')) code.push(lines[++i]!);
      i++;
      const block = `<div class="code"><button type="button" class="copy" aria-label="Copy this command">Copy</button><pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre></div>`;
      // While a list is open, a code block belongs to its last item ("- Run:" then the command).
      if (lastItem) lastItem.html.push(block);
      else out.push(block);
      continue;
    }
    if (line.startsWith('|')) {
      flushParagraph();
      flushList();
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(lines[i++]!);
      i--;
      out.push(renderTable(rows));
      continue;
    }
    const m = LIST_LINE.exec(line);
    if (m) {
      flushParagraph();
      const indent = m[1]!.length;
      const ordered = /\d/.test(m[2]!);
      const item: ListItem = { html: [inline(m[3]!)], children: null };
      if (!listRoot || indent < listRoot.indent) {
        flushList();
        listRoot = { ordered, indent, items: [item] };
        stack = [listRoot];
      } else {
        while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
        const top = stack[stack.length - 1]!;
        if (indent > top.indent && lastItem) {
          const child: ListNode = { ordered, indent, items: [item] };
          lastItem.children = child;
          stack.push(child);
        } else {
          top.items.push(item);
        }
      }
      lastItem = item;
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    const owner = /^\s+\S/.test(line) ? continuationOwner(stack, line) : null;
    if (owner) {
      // Indented continuation: it belongs to the last item of the deepest list indented less.
      const text = inline(line.trim());
      const prev = lines[i - 1] ?? '';
      const html = owner.html;
      const last = html[html.length - 1]!;
      const joins = prev.trim() !== '' && !prev.startsWith('```') && owner === lastItem;
      if (joins && html.length === 1) html[0] = `${last} ${text}`;
      else if (joins && last.endsWith('</p>'))
        html[html.length - 1] = `${last.slice(0, -4)} ${text}</p>`;
      else html.push(`<p>${text}</p>`);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

interface Step {
  title: string;
  body: string[];
}
interface Section {
  title: string;
  intro: string[];
  steps: Step[];
}

export interface GuideModel {
  title: string;
  intro: string[];
  sections: Section[];
}

export function parseGuide(markdown: string): GuideModel {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const model: GuideModel = { title: '', intro: [], sections: [] };
  let section: Section | null = null;
  let step: Step | null = null;
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.startsWith('# ')) {
      model.title = line.slice(2).trim();
      continue;
    }
    if (!inFence && line.startsWith('## ')) {
      section = { title: line.slice(3).trim(), intro: [], steps: [] };
      step = null;
      model.sections.push(section);
      continue;
    }
    if (!inFence && line.startsWith('### ') && section) {
      step = { title: line.slice(4).trim(), body: [] };
      section.steps.push(step);
      continue;
    }
    if (step) step.body.push(line);
    else if (section) section.intro.push(line);
    else model.intro.push(line);
  }
  return model;
}

function stepHtml(id: string, title: string, body: string, checkable: boolean): string {
  const head = checkable
    ? `<label class="step-head"><input type="checkbox" data-step="${id}"><span class="step-title">${inline(title)}</span></label>`
    : `<h3 class="step-head plain">${inline(title)}</h3>`;
  return `<div class="step" id="${id}">${head}<div class="step-body">${body}</div></div>`;
}

function sectionHtml(section: Section, index: number): string {
  const id = `s-${slug(section.title)}`;
  const checkable = !NO_CHECKBOX.test(section.title);
  const intro = renderBlocks(section.intro);
  let steps: string;
  if (section.steps.length === 0) {
    // A section without sub-steps is one step: tick it when the whole section is done.
    steps = checkable
      ? stepHtml(`${id}-done`, `Done: ${section.title.replace(/^\d+\.\s*/, '')}`, intro, true)
      : `<div class="step-body">${intro}</div>`;
  } else {
    steps =
      (intro.trim() ? `<div class="section-intro">${intro}</div>` : '') +
      section.steps
        .map((s) => stepHtml(`${id}-${slug(s.title)}`, s.title, renderBlocks(s.body), checkable))
        .join('\n');
  }
  const counter = checkable ? '<span class="count" aria-live="polite"></span>' : '';
  return `<details class="section" id="${id}"${index === 0 ? ' open' : ''}><summary><span class="section-title">${inline(section.title)}</span>${counter}</summary><div class="section-body">${steps}</div></details>`;
}

const STYLE = `
:root{--bg:#f6f3ee;--surface:#fffdf9;--ink:#1d1b18;--muted:#5f5a52;--line:#e2dcd2;--accent:#b4441d;--accent-soft:#f6e3d9;--done:#2f6b3f;--done-soft:#e1efe4;--code-bg:#211f1c;--code-ink:#f3eee6;--focus:#1f5fbf}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151412;--surface:#1e1c19;--ink:#efe9df;--muted:#a79f93;--line:#35312b;--accent:#f08a5d;--accent-soft:#3a2419;--done:#7cc58e;--done-soft:#1d3323;--code-bg:#0d0c0b;--code-ink:#efe9df;--focus:#8ab4ff}}
:root[data-theme="dark"]{--bg:#151412;--surface:#1e1c19;--ink:#efe9df;--muted:#a79f93;--line:#35312b;--accent:#f08a5d;--accent-soft:#3a2419;--done:#7cc58e;--done-soft:#1d3323;--code-bg:#0d0c0b;--code-ink:#efe9df;--focus:#8ab4ff}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "Inter",system-ui,sans-serif}
.wrap{max-width:52rem;margin:0 auto;padding:0 16px 4rem}
header.top{padding:2.5rem 0 1.5rem;border-bottom:1px solid var(--line);margin-bottom:1.5rem}
h1{font:600 clamp(1.8rem,1.2rem + 2.5vw,2.8rem)/1.15 "Newsreader",Georgia,serif;margin:0 0 .75rem;letter-spacing:-.01em}
.progress{position:sticky;top:0;z-index:2;background:var(--bg);padding:.75rem 0;border-bottom:1px solid var(--line);display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.bar{flex:1 1 12rem;height:.5rem;border-radius:1rem;background:var(--line);overflow:hidden}
.bar span{display:block;height:100%;width:0;background:var(--done);transition:width .3s ease}
.progress p{margin:0;color:var(--muted);font-size:.9rem}
.progress button{font:inherit;font-size:.85rem;background:none;border:1px solid var(--line);color:var(--ink);border-radius:.5rem;padding:.3rem .7rem;cursor:pointer}
.progress button:hover{border-color:var(--accent)}
details.section{background:var(--surface);border:1px solid var(--line);border-radius:.9rem;margin:1rem 0;overflow:hidden}
details.section[data-complete="true"]{border-color:var(--done)}
summary{list-style:none;cursor:pointer;padding:1rem 1.25rem;display:flex;gap:1rem;align-items:baseline;justify-content:space-between}
summary::-webkit-details-marker{display:none}
summary::before{content:"+";font-weight:600;color:var(--accent);width:1ch}
details[open]>summary::before{content:"\\2212"}
.section-title{flex:1;font:600 1.25rem/1.3 "Newsreader",Georgia,serif}
.count{font-size:.85rem;color:var(--muted);white-space:nowrap}
details[data-complete="true"] .count{color:var(--done);font-weight:600}
.section-body{padding:0 1.25rem 1.25rem}
.section-intro{margin-bottom:.5rem}
.step{border-top:1px solid var(--line);padding:1rem 0 .25rem}
.step-head{display:flex;gap:.75rem;align-items:flex-start;cursor:pointer;font-weight:600;margin:0;font-size:1.05rem}
.step-head.plain{cursor:default}
.step-head input{margin-top:.3rem;width:1.15rem;height:1.15rem;accent-color:var(--done);flex:none}
.step-head:has(input:checked) .step-title{color:var(--done);text-decoration:line-through;text-decoration-thickness:1px}
.step-body{padding-inline-start:1.9rem}
.step-head.plain+.step-body{padding-inline-start:0}
p,li{overflow-wrap:anywhere}
ul,ol{padding-inline-start:1.25rem}
li{margin:.3rem 0}
li>p{margin:.35rem 0}
a{color:var(--accent);text-underline-offset:.15em}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
code{font:.88em/1.4 "JetBrains Mono",ui-monospace,monospace;background:var(--accent-soft);padding:.05em .3em;border-radius:.3em}
.code{position:relative;margin:.75rem 0}
pre{margin:0;background:var(--code-bg);color:var(--code-ink);padding:2.25rem 1rem 1rem;border-radius:.6rem;overflow-x:auto}
pre code{background:none;padding:0;color:inherit;font-size:.85rem}
.copy{position:absolute;inset-block-start:.4rem;inset-inline-end:.4rem;font:600 .75rem "Inter",sans-serif;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:.4rem;padding:.2rem .55rem;cursor:pointer}
.table-wrap{overflow-x:auto;margin:.75rem 0}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:start;border-bottom:1px solid var(--line);padding:.45rem .6rem;vertical-align:top}
th{color:var(--muted);font-weight:600}
footer{color:var(--muted);font-size:.85rem;margin-top:2rem}
@media (prefers-reduced-motion:reduce){.bar span{transition:none}}
`;

const SCRIPT = `
(function(){
  var KEY='postmind-go-live-v1';
  var state={};
  try{state=JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch(e){state={};}
  function save(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}}
  var boxes=[].slice.call(document.querySelectorAll('input[data-step]'));
  function update(){
    var done=0;
    boxes.forEach(function(b){if(b.checked)done++;});
    var pct=boxes.length?Math.round(done*100/boxes.length):0;
    document.getElementById('bar').style.width=pct+'%';
    document.getElementById('done').textContent=done+' of '+boxes.length+' steps done';
    [].forEach.call(document.querySelectorAll('details.section'),function(d){
      var own=d.querySelectorAll('input[data-step]');
      if(!own.length)return;
      var n=0;[].forEach.call(own,function(b){if(b.checked)n++;});
      d.querySelector('.count').textContent=n+' / '+own.length;
      d.setAttribute('data-complete',n===own.length?'true':'false');
    });
  }
  boxes.forEach(function(b){
    b.checked=!!state[b.getAttribute('data-step')];
    b.addEventListener('change',function(){state[b.getAttribute('data-step')]=b.checked;save();update();});
  });
  document.getElementById('expand').addEventListener('click',function(){
    [].forEach.call(document.querySelectorAll('details.section'),function(d){d.open=true;});
  });
  document.getElementById('collapse').addEventListener('click',function(){
    [].forEach.call(document.querySelectorAll('details.section'),function(d){d.open=false;});
  });
  document.getElementById('reset').addEventListener('click',function(){
    if(!confirm('Clear every tick on this page?'))return;
    state={};save();boxes.forEach(function(b){b.checked=false;});update();
  });
  [].forEach.call(document.querySelectorAll('.copy'),function(btn){
    btn.addEventListener('click',function(){
      var text=btn.parentNode.querySelector('code').textContent;
      function ok(){btn.textContent='Copied';setTimeout(function(){btn.textContent='Copy';},1500);}
      if(navigator.clipboard){navigator.clipboard.writeText(text).then(ok,function(){btn.textContent='Select and copy';});}
      else{btn.textContent='Select and copy';}
    });
  });
  update();
})();
`;

/** The whole page. Deterministic: the same Markdown always gives the same bytes. */
export function renderGoLiveHtml(markdown: string): string {
  const model = parseGuide(markdown);
  const sections = model.sections.map((s, i) => sectionHtml(s, i)).join('\n');
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio Go-Live Checklist</title>
<meta name="description" content="Click-by-click guide from empty accounts to a live PostMind Studio site, as a checklist.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono:wght@400&family=Newsreader:opsz,wght@6..72,600&display=swap">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header class="top">
<h1>${inline(model.title)}</h1>
${renderBlocks(model.intro)}
</header>
<div class="progress" role="region" aria-label="Progress">
<div class="bar" aria-hidden="true"><span id="bar"></span></div>
<p id="done"></p>
<button type="button" id="expand">Open all</button>
<button type="button" id="collapse">Close all</button>
<button type="button" id="reset">Clear ticks</button>
</div>
<main>
${sections}
</main>
<footer><p>Generated from runbooks/go-live.md by scripts/setup/render-go-live.ts. Ticks are saved in this browser only.</p></footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
