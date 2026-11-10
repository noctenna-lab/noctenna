import {
  BufferAttribute,
  BufferGeometry,
  MathUtils,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Sphere,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three'
import { LANGS, DICT } from './i18n.js'
import { GAP_META, GAPS } from './gaps.js'

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
const phone = matchMedia('(max-width: 640px)').matches
const stacked = matchMedia('(max-width: 820px)')
const $ = (s) => document.querySelector(s)
const clamp = (x, a = 0, b = 1) => Math.min(Math.max(x, a), b)
const sm = (a, b, x) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {}
  },
}
let relayout = () => {}

// ---------- language ----------
let lang = 'en'
const T = (k) => DICT[lang]?.[k] ?? DICT.en[k] ?? k
function pickLang() {
  const saved = store.get('lang')
  if (saved && DICT[saved]) return saved
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const low = l.toLowerCase()
    if (/^zh-(tw|hk|mo|hant)/.test(low)) return 'zh-TW'
    const base = low.split('-')[0]
    if (DICT[base]) return base
  }
  return 'en'
}
const langmenu = $('#langmenu'),
  langbtn = $('#langbtn')
langmenu.innerHTML = LANGS.map(
  ([code, short, name]) => `<li role="option" tabindex="-1" data-lang="${code}">${name}<small>${short}</small></li>`,
).join('')
function applyLang(code) {
  lang = DICT[code] ? code : 'en'
  document.documentElement.lang = lang
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n)
  // phones show only the first half of the status line, so it stays on one line
  if (phone) {
    const pill = document.querySelector('[data-i18n="hero_pill"]')
    pill.textContent = T('hero_pill').split(' · ')[0]
  }
  $('#langcode').textContent = LANGS.find((l) => l[0] === lang)[1]
  langbtn.setAttribute('aria-label', T('lang_label'))
  for (const li of langmenu.children) li.setAttribute('aria-selected', String(li.dataset.lang === lang))
  words = T('rot').split('|')
  wi = 0
  rot.firstElementChild.textContent = words[0]
  renderBoard()
  renderNodes()
  renderStats()
  renderReopen()
  store.set('lang', lang)
  relayout()
}
// A button with a listbox under it: click or arrows to move, Enter to pick, Escape or a click elsewhere to close.
function bindMenu(wrap, btn, menu, pick) {
  const open = (on) => {
    menu.hidden = !on
    btn.setAttribute('aria-expanded', String(on))
    if (on) menu.querySelector('[aria-selected="true"]')?.focus()
  }
  const choose = (li) => {
    pick(li)
    open(false)
    btn.focus()
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    open(menu.hidden)
  })
  menu.addEventListener('click', (e) => {
    const li = e.target.closest('li')
    if (li) choose(li)
  })
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.children],
      i = items.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(i + 1) % items.length].focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i - 1 + items.length) % items.length].focus()
    } else if (e.key === 'Enter' && i >= 0) choose(items[i])
    else if (e.key === 'Escape') {
      open(false)
      btn.focus()
    }
  })
  document.addEventListener('click', (e) => {
    if (!e.target.closest(wrap)) open(false)
  })
}
bindMenu('#lang', langbtn, langmenu, (li) => applyLang(li.dataset.lang))

// ---------- network ----------
// The chain the install steps point Noctenna at, as `noctenna network` does: testnet until trading opens on mainnet at
// the launch. The board below reads mainnet markets either way, as the agent's radar and reopen tools do.
const NETS = { mainnet: 4663, testnet: 46630 }
const netmenu = $('#netmenu'),
  netbtn = $('#netbtn')
netmenu.innerHTML = Object.entries(NETS)
  .map(
    ([n, id]) =>
      `<li role="option" tabindex="-1" data-net="${n}"><span><span class="ndot"></span>${n}<small>${id}</small></span><b class="tick">✓</b></li>`,
  )
  .join('')
function applyNet(n) {
  const net = NETS[n] ? n : 'testnet'
  $('#netname').textContent = net
  $('#netid').textContent = NETS[net]
  $('#netline').hidden = net !== 'testnet'
  for (const li of netmenu.children) li.setAttribute('aria-selected', String(li.dataset.net === net))
  store.set('net', net)
}
applyNet(store.get('net') || 'testnet')
bindMenu('#net', netbtn, netmenu, (li) => applyNet(li.dataset.net))

// ---------- rotating word ----------
const rot = $('#rot')
let words = ['Launch checks.'],
  wi = 0
if (!reduce)
  setInterval(() => {
    const old = rot.firstElementChild
    wi = (wi + 1) % words.length
    const nw = document.createElement('span')
    nw.textContent = words[wi]
    nw.style.cssText = 'transform:translateY(100%);opacity:0;position:absolute;top:0'
    rot.appendChild(nw)
    requestAnimationFrame(() => {
      old.style.transform = 'translateY(-100%)'
      old.style.opacity = '0'
      nw.style.transform = ''
      nw.style.opacity = ''
    })
    setTimeout(() => {
      old.remove()
      nw.style.position = ''
    }, 600)
  }, 2400)

// ---------- toast and copy buttons ----------
const toast = $('#toast')
let toastGone = false
$('#toastx').addEventListener('click', () => {
  toast.hidden = true
  toastGone = true
})
const showToast = () => {
  if (toastGone) return
  toast.hidden = false
  setTimeout(() => {
    toast.hidden = true
    toastGone = true
  }, 10000)
}
if (phone)
  addEventListener(
    'scroll',
    function once() {
      if (scrollY > innerHeight) {
        showToast()
        removeEventListener('scroll', once)
      }
    },
    { passive: true },
  )
else setTimeout(showToast, 3500)
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]')
  if (!b) return
  const text = b.dataset.copy,
    code = b.querySelector('.code')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const r = document.createRange()
    r.selectNodeContents(code || b.parentElement.querySelector('code'))
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return
  }
  if (code) {
    code.textContent = T('copied')
    setTimeout(() => {
      code.textContent = text
    }, 1600)
  } else {
    b.classList.add('ok')
    setTimeout(() => b.classList.remove('ok'), 1600)
  }
})

// ---------- live funding: both venues' public APIs, every minute ----------
const WATCH = [
  ['BTC', 'Bitcoin'],
  ['ETH', 'Ether'],
  ['SOL', 'Solana'],
  ['WLD', 'Worldcoin'],
  ['NVDA', 'Nvidia'],
  ['TSLA', 'Tesla'],
  ['INTC', 'Intel'],
]
let live = {
  time: '06:50 UTC',
  rows: {
    BTC: [10.95, 10.51, null],
    ETH: [10.95, 10.51, null],
    SOL: [10.95, 3.5, null],
    WLD: [10.95, -27.16, null],
    NVDA: [4.48, 3.5, -0.87],
    TSLA: [4.48, 3.5, -0.47],
    INTC: [4.48, 3.5, -1.18],
  },
  top: [
    { s: 'WLD', a: 10.95, l: -27.16, g: 38.11 },
    { s: 'SOL', a: 10.95, l: 3.5, g: 7.45 },
    { s: 'BTC', a: 10.95, l: 10.51, g: 0.44 },
  ],
  longs: 142,
  total: 145,
  shut: 41,
  fixed: 4.48,
}
const f2 = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2)
async function getJSON(u) {
  const r = await fetch(u, { cache: 'no-store' })
  if (!r.ok) throw new Error(u + ' ' + r.status)
  return r.json()
}
async function refresh() {
  try {
    const [am, ld, lf] = await Promise.all([
      getJSON('https://api.arcus.xyz/v1/markets'),
      getJSON('https://api.rh.lighter.xyz/api/v1/orderBookDetails'),
      getJSON('https://api.rh.lighter.xyz/api/v1/funding-rates'),
    ])
    const A = {},
      L = {}
    for (const m of am.markets || am) {
      if (m.status !== 'ONLINE') continue
      const mark = +m.markPrice,
        settle = +(m.currentSettlementPrice || 0)
      A[m.baseAsset] = {
        f: +m.fundingRate * 24 * 365 * 100,
        closed: !!m.isOutsideRth,
        gap: settle ? (mark / settle - 1) * 100 : null,
      }
    }
    const perps = new Set(
      (ld.order_book_details || [])
        .filter((m) => m.market_type === 'perp' && m.status === 'active')
        .map((m) => m.symbol),
    )
    for (const f of lf.funding_rates || [])
      if (f.exchange === 'lighter' && perps.has(f.symbol)) L[f.symbol] = +f.rate * 3 * 365 * 100
    const rows = {}
    for (const [s] of WATCH) if (A[s]) rows[s] = [A[s].f, L[s] ?? null, A[s].closed ? A[s].gap : null]
    const top = Object.keys(A)
      .filter((s) => L[s] != null)
      .map((s) => ({ s, a: A[s].f, l: L[s], g: Math.abs(A[s].f - L[s]) }))
      .sort((x, y) => y.g - x.g)
      .slice(0, 3)
    stocks = (am.markets || am)
      .filter((m) => m.status === 'ONLINE' && STOCK.has(m.category))
      .map(stockOf)
      .sort((a, b) => b.vol - a.vol)
    const readings = [...Object.values(A).map((a) => a.f), ...Object.values(L)]
    const shut = Object.values(A).filter((a) => a.closed)
    const now = new Date()
    live = {
      time: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`,
      rows,
      top,
      longs: readings.filter((x) => x > 0).length,
      total: readings.length,
      shut: shut.length,
      fixed: shut.length ? shut[0].f : null,
    }
    renderBoard()
    renderStats()
    renderReopen()
  } catch (e) {
    /* keep the last good numbers */
  }
}
function bar(v, cls) {
  if (v == null)
    return `<div class="bar"><div class="neg-side"></div><div class="pos-side"></div><span class="val">–</span></div>`
  const w = Math.min(Math.abs(v) / 30, 1) * 100,
    fill = `<span class="fill ${v < 0 ? 'fneg' : cls}" style="width:${w}%"></span>`
  return `<div class="bar"><div class="neg-side">${v < 0 ? fill : ''}</div><div class="pos-side">${v >= 0 ? fill : ''}</div><span class="val">${f2(v)}</span></div>`
}
function renderBoard() {
  $('#b_time').textContent = live.time
  $('#rows').innerHTML = WATCH.filter(([s]) => live.rows[s])
    .map(([s, name]) => {
      const [a, l, gap] = live.rows[s],
        g = l == null ? null : Math.abs(a - l)
      return `<div class="brow"><div class="mk"><i>${s}</i><div>${s}<small>${name}</small></div></div>
      <div class="bars">${bar(a, 'fa')}${bar(l, 'fl')}</div>
      <div class="gap${g != null && g > 10 ? ' hot' : ''}">${g == null ? '–' : g.toFixed(2)}</div>
      <div class="stcol r">${gap == null ? `<span class="vst open">${T('st_open')}</span>` : `<span class="vst shut">${T('st_shut').replace('{x}', f2(gap))}</span>`}</div></div>`
    })
    .join('')
}
function renderStats() {
  const w = live.top?.[0]
  if (w) {
    for (const id of ['#s_gap', '#f_gap']) $(id).textContent = w.g.toFixed(1) + '%'
    for (const id of ['#s_gapsym', '#f_gapsym']) $(id).textContent = w.s
    $('#ans1').textContent = T('ans1')
      .replace('{s}', w.s)
      .replace('{a}', f2(w.a))
      .replace('{l}', f2(w.l))
      .replace('{g}', w.g.toFixed(2))
    $('#gaprows').innerHTML =
      `<div class="grow ghead"><span>${esc(T('col_market'))}</span><span>Arcus</span><span>Lighter</span><span>${esc(T('col_gap'))}</span></div>` +
      live.top
        .map(
          (r, i) =>
            `<div class="grow"><b>${esc(r.s)}</b><span${r.a < 0 ? ' class="neg"' : ''}>${f2(r.a)}</span><span${r.l < 0 ? ' class="neg"' : ''}>${f2(r.l)}</span><b${i === 0 && r.g > 10 ? ' class="hot"' : ''}>${r.g.toFixed(2)}</b></div>`,
        )
        .join('')
  }
  if (live.total) $('#s_longs').innerHTML = `${live.longs}<small> / ${live.total}</small>`
  for (const id of ['#s_shut', '#f_shut']) $(id).textContent = live.shut
  $('#ans1b').textContent =
    live.fixed == null ? '' : T('ans1b').replace('{n}', live.shut).replace('{f}', live.fixed.toFixed(2))
  $('#a_time').textContent = live.time
}

// ---------- reopen watch: Arcus's weekend bands, live, and what a reopen gap would do to one position ----------
// The calculator mirrors perps_reopen_check in the agent: liquidation ≈ an adverse move of 1/leverage − maintenance margin,
// read against the band, the widened band and the Monday-open history in gaps.js (one table for both).
const STOCK = new Set(['EQUITIES', 'INDICES', 'COMMODITIES'])
const nz = (x) => (x == null || x === '' ? null : +x)
const stockOf = (m) => ({
  s: m.baseAsset,
  name: m.fullAssetName || m.baseAsset,
  settle: +(m.currentSettlementPrice || m.markPrice),
  mark: +m.markPrice,
  lower: nz(m.lowerTradingBound),
  upper: nz(m.upperTradingBound),
  nl: nz(m.nextLowerTradingBound),
  nu: nz(m.nextUpperTradingBound),
  mmf: +(m.maintenanceMarginFraction || 0),
  imf: +m.initialMarginFraction,
  offImf: +(m.offHoursInitialMarginFraction || m.initialMarginFraction),
  shut: !!m.isOutsideRth,
  vol: +(m.volume24hNotional || 0),
})
// Sunday 8 Nov 2026, so the section reads right before the first refresh lands
let stocks = [
  ['SPY', 'SPDR S&P 500 ETF Trust', 736.06, 735.48, 728.7, 743.42, 721.34, 750.78, 0.013334, 0.02, 0.03],
  ['QQQ', 'Invesco QQQ Trust', 656.93, 655.42, 643.8, 670.06, 630.66, 683.2, 0.026667, 0.04, 0.06],
  ['NVDA', 'NVIDIA', 188.45, 187.31, 183.74, 193.16, 179.03, 197.87, 0.033334, 0.05, 0.075],
  ['AMZN', 'Amazon.com', 259.92, 259.75, 253.43, 266.41, 246.93, 272.91, 0.033334, 0.05, 0.075],
  ['HOOD', 'Robinhood Markets', 80.88, 80.72, 76.84, 84.92, 72.8, 88.96, 0.066667, 0.1, 0.15],
  ['SNDK', 'SanDisk', 839.69, 834.99, 797.71, 881.67, 755.73, 923.65, 0.066667, 0.1, 0.15],
  ['AAPL', 'Apple', 342.57, 342.16, 334.01, 351.13, 325.45, 359.69, 0.033334, 0.05, 0.075],
  ['AMD', 'Advanced Micro Devices', 447.57, 447.76, 425.2, 469.94, 402.82, 492.32, 0.066667, 0.1, 0.15],
  ['MU', 'Micron Technology', 693.65, 695.26, 658.97, 728.33, 624.29, 763.01, 0.066667, 0.1, 0.15],
  ['GLD', 'SPDR Gold Shares', 373.24, 372.54, 365.78, 380.7, 358.32, 388.16, 0.026667, 0.04, 0.06],
  ['INTC', 'Intel', 56.78, 56.31, 53.95, 59.61, 51.11, 62.45, 0.066667, 0.1, 0.15],
  ['GOOGL', 'Alphabet', 285.45, 285.0, 278.32, 292.58, 271.18, 299.72, 0.033334, 0.05, 0.075],
].map(([s, name, settle, mark, lower, upper, nl, nu, mmf, imf, offImf], i) => ({
  s,
  name,
  settle,
  mark,
  lower,
  upper,
  nl,
  nu,
  mmf,
  imf,
  offImf,
  shut: true,
  vol: 12 - i,
}))
const pct = (x, d = 1) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d) + '%'
const fmt = (k, o) => T(k).replace(/\{(\w+)\}/g, (_, x) => o[x] ?? '')
const day = (s) =>
  new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(s + 'T00:00:00Z'),
  )
const past = (t, side, at) => {
  const i = GAP_META.steps.findLastIndex((x) => x <= at)
  return i < 0 ? t.n : (side === 'long' ? t.down : t.up)[i]
}
{
  const us = GAPS.US,
    i2 = GAP_META.steps.indexOf(2),
    i5 = GAP_META.steps.indexOf(5)
  $('#ro_s1v').textContent = Math.round(((us.down[i2] + us.up[i2]) / us.n) * 100) + '%'
  $('#ro_s2v').textContent = Math.round(((us.down[i5] + us.up[i5]) / us.n) * 100) + '%'
}
function renderReopen() {
  const shut = stocks.filter((x) => x.shut && x.lower && x.upper)
  $('#ro_dot').classList.toggle('on', shut.length > 0)
  $('#ro_state').textContent = shut.length ? fmt('ro_state_shut', { t: live.time }) : T('ro_state_open')
  $('#ro_live_n').textContent = shut.length
  // the eight most traded, the ones nearest their band edge first
  const rows = shut
    .slice(0, 8)
    .map((x) => {
      const mv = (x.mark / x.settle - 1) * 100
      return { x, mv, used: Math.abs(x.mark - x.settle) / (mv < 0 ? x.settle - x.lower : x.upper - x.settle) }
    })
    .sort((a, b) => b.used - a.used)
  $('#ro_rows').innerHTML = rows.length
    ? rows
        .map(({ x, mv, used }) => {
          const at = (v) => ((v - x.lower) / (x.upper - x.lower)) * 100,
            lo = at(Math.min(x.mark, x.settle)),
            hi = at(Math.max(x.mark, x.settle))
          const room = ((mv < 0 ? x.mark - x.lower : x.upper - x.mark) / x.mark) * 100,
            warn = used > 0.6 ? ' warn' : ''
          return `<div class="rorow"><div class="mk"><i>${esc(x.s)}</i><div>${esc(x.s)}<small>${esc(x.name)}</small></div></div>
      <div class="romove ${mv < 0 ? 'neg' : 'ok'}">${pct(mv, 2)}</div>
      <div class="roband"><div class="rotrack"><span class="f${mv < 0 ? ' neg' : ''}" style="left:${lo.toFixed(1)}%;width:${(hi - lo).toFixed(1)}%"></span><span class="c" style="left:${at(x.settle).toFixed(1)}%"></span><span class="m" style="left:${at(x.mark).toFixed(1)}%"></span></div>
        <small><span>${pct((x.lower / x.settle - 1) * 100)}</span><span class="rm${warn}">${esc(fmt('ro_room', { p: room.toFixed(1) }))}</span><span>${pct((x.upper / x.settle - 1) * 100)}</span></small></div>
      <div class="roroom${warn}">${room.toFixed(1)}%</div></div>`
        })
        .join('')
    : `<div class="roempty">${esc(T('ro_state_open'))}</div>`
  const sel = $('#ro_mkt'),
    cur = sel.value || 'NVDA'
  sel.innerHTML = stocks
    .map((x) => `<option value="${esc(x.s)}"${x.s === cur ? ' selected' : ''}>${esc(x.s)} · ${esc(x.name)}</option>`)
    .join('')
  $('#ro_src').textContent = fmt('ro_src', {
    n: GAPS.US.n.toLocaleString(lang),
    from: day(GAP_META.from),
    to: day(GAP_META.to),
  })
  calc()
}
let roSide = 'long'
function calc() {
  const x = stocks.find((s) => s.s === $('#ro_mkt').value) || stocks[0]
  if (!x) return
  const lev = $('#ro_lev'),
    max = Math.max(1, Math.floor(1 / (x.shut ? x.offImf : x.imf) + 1e-9))
  lev.max = max
  if (+lev.value > max) lev.value = max
  const L = +lev.value,
    long = roSide === 'long'
  lev.style.setProperty('--p', `${((L - 1) / Math.max(max - 1, 1)) * 100}%`)
  $('#ro_levv').textContent = L + 'x'
  const lm = 1 / L - x.mmf,
    liq = x.mark * (long ? 1 - lm : 1 + lm),
    gap = (long ? 1 - liq / x.settle : liq / x.settle - 1) * 100
  const edge = long ? x.lower : x.upper,
    next = long ? x.nl : x.nu,
    reach = (p) => p != null && (long ? liq >= p : liq <= p)
  const half = (b) => Math.abs(b / x.settle - 1) * 100,
    t = GAPS[x.s] || GAPS.US
  $('#ro_band').textContent = edge
    ? fmt('ro_out_band_v', { a: half(edge).toFixed(1), b: half(next ?? edge).toFixed(1) })
    : '–'
  $('#ro_liq').textContent = lm > 0 ? `$${liq.toFixed(2)} · ${pct(long ? -lm * 100 : lm * 100)}` : '–'
  $('#ro_gap').textContent = lm > 0 ? pct(long ? -gap : gap) : '–'
  $('#ro_hist').textContent = `${past(t, roSide, gap)} / ${t.n.toLocaleString(lang)}` // a market without its own history reads all US shares, as the line below says
  const v = lm <= 0 ? 'ro_v_past' : reach(edge) ? 'ro_v_band' : reach(next) ? 'ro_v_wide' : 'ro_v_gap',
    out = $('#ro_verdict')
  out.textContent = T(v)
  out.classList.toggle('bad', v === 'ro_v_past' || v === 'ro_v_band')
  $('#ro_us').textContent = fmt('ro_us_all', {
    p: ((past(GAPS.US, roSide, gap) / GAPS.US.n) * 100).toFixed(1),
    n: GAPS.US.n.toLocaleString(lang),
  })
}
$('#ro_mkt').addEventListener('change', calc)
$('#ro_lev').addEventListener('input', calc)
$('#ro_side').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  roSide = b.dataset.side
  for (const x of $('#ro_side').children) x.setAttribute('aria-checked', String(x === b))
  calc()
})

// ---------- the agent's window: three conversations, played in turn while it is on screen ----------
const tabs = [...document.querySelectorAll('.tabs [role="tab"]')],
  panes = [...document.querySelectorAll('.pane')]
let tabAt = 0,
  tabPicked = false,
  winOn = false
function showTab(i, focus) {
  tabAt = i
  tabs.forEach((t, j) => {
    t.setAttribute('aria-selected', String(j === i))
    t.tabIndex = j === i ? 0 : -1
  })
  panes.forEach((p, j) => {
    p.hidden = j !== i
    p.classList.remove('on')
  })
  void panes[i].offsetWidth
  panes[i].classList.add('on')
  if (focus) tabs[i].focus()
}
tabs.forEach((t, i) =>
  t.addEventListener('click', () => {
    tabPicked = true
    showTab(i)
  }),
)
$('.tabs').addEventListener('keydown', (e) => {
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
  if (d) {
    e.preventDefault()
    tabPicked = true
    showTab((tabAt + d + tabs.length) % tabs.length, true)
  }
})
if (!reduce)
  setInterval(() => {
    if (winOn && !tabPicked && !document.hidden) showTab((tabAt + 1) % tabs.length)
  }, 7500)
new IntersectionObserver(
  ([e]) => {
    const was = winOn
    winOn = e.isIntersecting
    if (winOn && !was) showTab(tabAt)
  },
  { threshold: 0.3 },
).observe($('#win'))

// ---------- hub ----------
const NODES = [
  ['Arcus', 'node_perps'],
  ['Lighter', 'node_perps'],
  ['node_launches', 'node_curve'],
  ['KyberSwap', 'node_routes'],
  ['Uniswap', 'node_pools'],
  ['Relay', 'node_bridge'],
  ['node_wallet', 'node_local'],
]
function renderNodes() {
  const label = ([a, b]) => `<i></i>${a.startsWith('node_') ? T(a) : a} <small>${T(b)}</small>`
  $('#orbit').innerHTML = NODES.map((n, i) => {
    const ang = (i / NODES.length) * Math.PI * 2 - Math.PI / 2
    return `<div class="slot" style="left:${390 + Math.cos(ang) * 390}px;top:${390 + Math.sin(ang) * 390}px"><div class="node">${label(n)}</div></div>`
  }).join('')
  $('#nodesPhone').innerHTML = NODES.map((n) => `<div class="node">${label(n)}</div>`).join('')
}

let kick = () => {}
let renderer = null

// hub orbit: turns slowly, labels stay upright and facing the reader
let hubOn = false,
  hubRAF = 0
function hubFrame(now) {
  const th = reduce ? 0 : (now / 1000) * (360 / 80),
    orbit = $('#orbit')
  orbit.style.transform = `rotateZ(${th}deg)`
  for (const n of orbit.querySelectorAll('.node'))
    n.style.transform = `translate(-50%,-100%) rotateZ(${-th}deg) rotateX(${-hubTilt}deg)`
  hubRAF = hubOn && !reduce ? requestAnimationFrame(hubFrame) : 0
}
new IntersectionObserver(([e]) => {
  hubOn = e.isIntersecting && !phone
  if (hubOn && !hubRAF) hubRAF = requestAnimationFrame(hubFrame)
}).observe(document.getElementById('hub'))

// ---------- scroll: reveals, plates printing in, 3D tilts, active nav ----------
const io = new IntersectionObserver(
  (es) =>
    es.forEach((e) => {
      if (!e.isIntersecting) return
      const el = e.target,
        sibs = [...el.parentElement.children].filter((x) => x.classList.contains('reveal'))
      const delay = `${Math.min(Math.max(sibs.indexOf(el), 0), 5) * 90}ms`
      el.style.transitionDelay = delay
      el.style.setProperty('--stagger', delay)
      el.addEventListener(
        'transitionend',
        () => {
          el.style.transitionDelay = ''
        },
        { once: true },
      )
      el.classList.add('in')
      io.unobserve(el)
    }),
  { rootMargin: '0px 0px -10% 0px' },
)
document.querySelectorAll('.reveal, .vault .art').forEach((el) => io.observe(el))
for (const a of document.querySelectorAll('.art'))
  a.addEventListener('transitionend', (e) => {
    if (e.propertyName === '--r') a.classList.add('printed')
  })
// plates load when they come within reach of the screen, not with the page
const plates = new IntersectionObserver(
  (es) =>
    es.forEach((e) => {
      if (e.isIntersecting) {
        e.target.style.setProperty('--src', `url(${e.target.dataset.plate})`)
        plates.unobserve(e.target)
      }
    }),
  { rootMargin: '900px 0px' },
)
document.querySelectorAll('[data-plate]').forEach((el) => plates.observe(el))

const boardEl = $('#board'),
  win = $('#win'),
  band = $('#band'),
  bandV = band.querySelector('.ink.v'),
  bandL = band.querySelector('.ink.l')
const vaultArt = $('#vault .art'),
  hubscene = $('#hubscene'),
  heroEl = $('.hero'),
  heroCopy = $('#heroCopy')
let scrollQueued = false,
  heroScroll = 0,
  heroExit = 1,
  hubTilt = 62
// k = 1 while an element sits low on screen, easing to 0 by the time it reaches the upper part
const standUp = (el, from = 0.2, span = 0.6) =>
  sm(0, 1, (el.getBoundingClientRect().top - innerHeight * from) / (innerHeight * span))
function onScroll() {
  scrollQueued = false
  const vh = innerHeight
  boardEl.style.setProperty('--k', standUp(boardEl, 0.18, 0.62).toFixed(4))
  win.style.setProperty('--k', standUp(win, 0.2, 0.6).toFixed(4))
  vaultArt.style.setProperty('--d', standUp(vaultArt, 0.15, 0.65).toFixed(4))
  const rh = hubscene.getBoundingClientRect()
  hubTilt = 56 + 18 * sm(0, 1, (rh.top - vh * 0.1) / (vh * 0.7))
  hubscene.style.setProperty('--hub-tilt', `${hubTilt.toFixed(2)}deg`)
  // the panorama sits further back than the page: it drifts slower, and its UV layer slower still
  const rb = band.getBoundingClientRect()
  if (rb.bottom > -100 && rb.top < vh + 100) {
    const p = clamp((rb.top + rb.height / 2 - vh / 2) / vh, -1, 1)
    bandL.style.transform = `translate3d(0,${(-p * 36).toFixed(1)}px,0)`
    bandV.style.transform = `translate3d(6px,${(5 - p * 50).toFixed(1)}px,0)`
  }
  heroScroll = clamp(scrollY / (heroEl.offsetHeight * 0.95))
  heroCopy.style.transform = `translateY(${(-heroScroll * 60).toFixed(1)}px)`
  heroExit = 1 - sm(0.05, 0.55, heroScroll)
  if (!renderer) heroCopy.style.opacity = heroExit
  kick()
}
addEventListener(
  'scroll',
  () => {
    if (!scrollQueued) {
      scrollQueued = true
      requestAnimationFrame(onScroll)
    }
  },
  { passive: true },
)
const navLinks = [...document.querySelectorAll('.links a')]
const navObs = new IntersectionObserver(
  (es) =>
    es.forEach((e) => {
      if (e.isIntersecting)
        navLinks.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id))
    }),
  { rootMargin: '-45% 0px -50% 0px' },
)
;['ask', 'reopen', 'tools', 'radar', 'hub', 'safety', 'faq'].forEach((id) =>
  navObs.observe(document.getElementById(id)),
)

// ---------- hero: a living particle print ----------
// The print assembles from a starfield, then keeps breathing: signal rings pulse out from the antenna tip, points drift,
// the cursor pushes them aside, and scrolling tilts the print back and pulls its layers apart in depth.
const canvas = $('#pts')
const ASPECT = 4096 / 2294,
  TIP = [0.774, 0.126]
try {
  renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' })
} catch (e) {}
if (renderer) {
  if (!reduce) heroCopy.style.opacity = 0
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  renderer.setPixelRatio(dpr)
  renderer.setClearColor(0x000000, 0)
  const scene = new Scene()
  const camera = new PerspectiveCamera(30, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  const VIS_H = 2 * 10 * Math.tan(MathUtils.degToRad(15))
  const q = new Uint16Array(await (await fetch('/hero-points.bin')).arrayBuffer())
  const N = Math.min(q.length / 2, phone ? 60000 : 120000)
  const aStart = new Float32Array(N * 3),
    aSeed = new Float32Array(N),
    pos = new Float32Array(N * 3)
  const rnd = (() => {
    let s = 7
    return () => (s = (s * 16807) % 2147483647) / 2147483647
  })()
  for (let i = 0; i < N; i++) {
    pos[i * 3] = q[i * 2] / 65535
    pos[i * 3 + 1] = q[i * 2 + 1] / 65535
    pos[i * 3 + 2] = (rnd() - 0.5) * 0.06
    const th = rnd() * Math.PI * 2,
      r = 3 + rnd() * 6
    aStart[i * 3] = Math.cos(th) * r
    aStart[i * 3 + 1] = Math.sin(th) * r * 0.65
    aStart[i * 3 + 2] = -4 + rnd() * 7
    aSeed[i] = rnd()
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('aStart', new BufferAttribute(aStart, 3))
  geo.setAttribute('aSeed', new BufferAttribute(aSeed, 1))
  geo.boundingSphere = new Sphere(new Vector3(), 60)
  const U = {
    uIntro: { value: reduce ? 1 : 0 },
    uTime: { value: 0 },
    uPx: { value: dpr },
    uImg: { value: new Vector4(10, 5, 0, 0) },
    uDim: { value: 0.16 },
    uTop: { value: 9 },
    uDense: { value: 1 },
    uMouse: { value: new Vector3(0, 0, 0) },
    uMR: { value: 0.55 },
    uScroll: { value: 0 },
    uTip: { value: new Vector2(...TIP) },
    uMotion: { value: reduce ? 0 : 1 },
  }
  const mat = new ShaderMaterial({
    uniforms: U,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute vec3 aStart; attribute float aSeed;
      uniform float uIntro, uTime, uPx, uTop, uDense, uMR, uScroll, uMotion, uDim; uniform vec4 uImg; uniform vec2 uTip; uniform vec3 uMouse;
      varying float vA; varying vec3 vC;
      vec2 toWorld(vec2 uv){ return vec2((uv.x - 0.5) * uImg.x + uImg.z, (0.5 - uv.y) * uImg.y + uImg.w); }
      void main(){
        vec3 img = vec3(toWorld(position.xy), position.z);
        float d = clamp(uIntro * 1.7 - aSeed * 0.7, 0.0, 1.0); d = d * d * (3.0 - 2.0 * d);
        float sw = uTime * 0.18 * (1.0 - d);
        vec3 st = vec3(cos(sw) * aStart.x - sin(sw) * aStart.y, sin(sw) * aStart.x + cos(sw) * aStart.y, aStart.z);
        // living print: drift, and signal rings that travel out from the antenna tip through the sky
        float sky = 1.0 - smoothstep(0.62, 0.82, position.y);
        vec2 rel = img.xy - toWorld(uTip); float dd = length(rel);
        float wave = sin(dd * 9.0 - uTime * 2.3) * uMotion;
        img.xy += (rel / max(dd, 1e-3)) * wave * 0.014 * sky * smoothstep(0.08, 0.6, dd);
        img.xy += vec2(sin(uTime * 0.55 + aSeed * 43.0), cos(uTime * 0.47 + aSeed * 29.0)) * 0.009 * uMotion;
        vec3 p = mix(st, img, d);
        // the cursor pushes points aside and lifts them toward the viewer
        vec2 dm = p.xy - uMouse.xy; float md = length(dm);
        float push = uMouse.z * exp(-(md * md) / (uMR * uMR)) * d;
        p.xy += (dm / max(md, 1e-3)) * push * 0.42; p.z += push * 0.9;
        // scrolling away: layers separate in depth (sky back, ground forward), points rise and thin out
        float layer = mix(-2.2, 1.8, smoothstep(0.05, 0.95, position.y));
        p.z += layer * uScroll * 3.2; p.y += uScroll * (0.25 + aSeed * 0.7); p.x += (aSeed - 0.5) * uScroll * 0.25;
        // the print's own edges never show: its far left melts away, the ground dissolves at the foot,
        // and the sky behind the headline stays dim; the mast, ring and right edge stay whole
        float edge = smoothstep(0.0, 0.15, position.x) * smoothstep(1.0, 0.92, position.y) * mix(uDim, 1.0, smoothstep(0.36, 0.56, position.x));
        vA = 0.92 * (0.5 + 0.5 * d) * mix(1.0, edge, d);
        vA *= (1.0 + 0.22 * wave * sky * d) * (1.0 + push * 0.6) * (1.0 - smoothstep(0.55, 1.0, uScroll));
        vC = mix(vec3(0.58, 0.44, 1.0), vec3(0.95, 0.93, 1.0), smoothstep(0.15, 0.85, aSeed) * (0.6 + 0.4 * d));
        vC = mix(vC, vec3(1.0), clamp(push * 0.8 + max(wave, 0.0) * 0.15 * sky, 0.0, 1.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // stacked layout only: points fade out under the nav bar
        vA *= mix(1.0, 1.0 - smoothstep(uTop - 0.03, uTop + 0.02, gl_Position.y / gl_Position.w), d * (1.0 - uScroll));
        gl_PointSize = 1.5 * uDense * mix(2.4, 1.0, d) * (1.0 + push * 0.8) * uPx * (10.0 / -mv.z);
      }`,
    fragmentShader: `
      varying float vA; varying vec3 vC;
      void main(){ vec2 c = gl_PointCoord - 0.5; float r2 = dot(c, c); if (r2 > 0.25) discard; gl_FragColor = vec4(vC, vA * smoothstep(0.25, 0.12, r2)); }`,
  })
  const points = new Points(geo, mat)
  scene.add(points)

  let visW = 1
  // Desktop: the print is as tall as the hero (shorter only if the ring would run into the headline), its right edge
  // on the screen's right edge. Stacked: the ring spans the screen's width and the tip sits just under the nav.
  relayout = function layout() {
    const vw = heroEl.clientWidth,
      st = stacked.matches
    let wpx,
      top = 0
    if (st) {
      wpx = Math.min(vw / 0.455, innerHeight * 0.62 * ASPECT)
      top = 24
      heroEl.style.setProperty('--radar-h', `${Math.round(top + wpx / ASPECT)}px`)
    } else heroEl.style.removeProperty('--radar-h')
    const vh = heroEl.clientHeight
    if (!st) {
      const textR = Math.max(
        $('#h1text').getBoundingClientRect().right,
        heroCopy.querySelector('p').getBoundingClientRect().right,
      )
      wpx = Math.min(vh * ASPECT, Math.max(vw, (vw - textR - 24) / 0.445))
    }
    const hpx = wpx / ASPECT,
      k = VIS_H / vh
    renderer.setSize(vw, vh, false)
    camera.aspect = vw / vh
    camera.updateProjectionMatrix()
    visW = VIS_H * camera.aspect
    U.uImg.value.set(wpx * k, hpx * k, ((vw - wpx) / 2) * k, (vh / 2 - top - hpx / 2) * k)
    U.uDim.value = st ? 1 : 0.16
    U.uTop.value = st ? 1 - 2 * (62 / vh) : 9
    U.uDense.value = clamp(Math.sqrt((vw * Math.min(vh, 1000)) / (1440 * 900)), 1, 1.3)
    U.uMR.value = st ? 0.4 : 0.55
    kick()
  }
  const mouse = { x: 0, y: 0, k: 0, tk: 0, px: 0, py: 0 }
  const setPointer = (cx, cy) => {
    const r = canvas.getBoundingClientRect()
    mouse.x = ((cx - r.left) / r.width - 0.5) * visW
    mouse.y = (0.5 - (cy - r.top) / r.height) * VIS_H
    mouse.tk = 1
    mouse.px = (cx - r.left) / r.width - 0.5
    mouse.py = (cy - r.top) / r.height - 0.5
  }
  if (!reduce) {
    heroEl.addEventListener('pointermove', (e) => setPointer(e.clientX, e.clientY), { passive: true })
    heroEl.addEventListener('pointerdown', (e) => setPointer(e.clientX, e.clientY), { passive: true })
    heroEl.addEventListener('pointerleave', () => {
      mouse.tk = 0
    })
    heroEl.addEventListener(
      'touchend',
      () => {
        mouse.tk = 0
      },
      { passive: true },
    )
  }
  const t0 = performance.now()
  let running = false,
    visible = true,
    docVisible = true,
    rx = 0,
    ry = 0
  function frame(now) {
    const t = (now - t0) / 1000
    U.uIntro.value = reduce ? 1 : Math.min(t / 2.8, 1)
    U.uTime.value = t
    mouse.k += (mouse.tk - mouse.k) * 0.08
    U.uMouse.value.set(mouse.x, mouse.y, mouse.k)
    U.uScroll.value = heroScroll
    rx += ((reduce ? 0 : mouse.py * 0.05) - heroScroll * 0.8 - rx) * 0.1
    ry += ((reduce ? 0 : mouse.px * 0.05) - ry) * 0.08
    points.rotation.x = rx
    points.rotation.y = ry
    camera.position.z = 10 - heroScroll * 1.3
    heroCopy.style.opacity = (reduce ? 1 : sm(1.5, 2.6, t)) * heroExit
    renderer.render(scene, camera)
    // keep breathing while the hero is on screen; reduced motion stops once settled
    if (visible && docVisible && (!reduce || t < 0.2)) requestAnimationFrame(frame)
    else running = false
  }
  kick = () => {
    if (!running && visible && docVisible) {
      running = true
      requestAnimationFrame(frame)
    }
  }
  addEventListener('resize', () => relayout())
  document.addEventListener('visibilitychange', () => {
    docVisible = !document.hidden
    kick()
  })
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting
    kick()
  }).observe(heroEl)
  document.fonts?.ready.then(() => relayout())
} else {
  heroCopy.style.opacity = 1
}

applyLang(pickLang())
onScroll()
refresh()
setInterval(refresh, 60000)
