
// @ts-nocheck
"use strict";
// ═══════════════════════════════════════════════════════════════════
//  © 2026 Kaat Claerman — Alle rechten voorbehouden.
//  DataShop CEO — SQL Story Game (Educatieve versie)
//  Ongeautoriseerde reproductie, distributie of aanpassing is
//  verboden zonder schriftelijke toestemming van de auteur.
// ═══════════════════════════════════════════════════════════════════

// ── UTILITY ───────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── GAME CONFIG (tunable constants) ──────────────────────────────
const GAME_CONFIG = {
  hintPenaltyXP: 5,
  streakBonus3: 10,
  streakBonus5: 20,
  speedBonusMax: 30,
  repDamageSyntax: 2,
  repDamageLogic: 5,
  repDamageTimeout: 0,
  repGainEasy: 2,
  repGainMedium: 3,
  repGainHard: 5,
  consecutiveErrorsToReset: 2,
  dailyMultiplier: { easy: 1.2, medium: 1.5, hard: 2.0 },
  dailyRepeatMultiplier: 0.5,
  maxStreakShields: 3,
  shieldsPerWeek: 7,   // correct answers needed per shield
  maxEvents: 30,
  maxQueryHistory: 20,
};

/* =========================
   SAFE DOM HELPERS
========================= */
function setText(el, value) {
  if (!el) return;
  el.textContent = value ?? "";
}

function setHTML(el, html) {
  if (!el) return;
  el.innerHTML = sanitizeHTML(html ?? "");
}

// setFbHTML — writes feedback HTML (res.msg, hints, etc.) into an element.
// All feedback paths that mix authored HTML with potentially-echoed content must
// go through this helper so that a future err() that forgets esc() cannot inject
// raw markup into the DOM.
function setFbHTML(el, html) {
  if (!el) return;
  el.innerHTML = sanitizeHTML(html ?? "");
}

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  // BUTTON, INPUT, TEXTAREA removed: could enable phishing content within narrative HTML.
  // KBD retained for keyboard shortcut display; interactive form elements are not needed in narrative/feedback HTML.
  const allowedTags = ["B","I","EM","STRONG","BR","CODE","SPAN","MARK","SMALL","DIV","HR","TABLE","THEAD","TBODY","TR","TH","TD","PRE","A","H1","H2","H3","H4","P","UL","OL","LI","LABEL","KBD","SUB","SUP"];
  // "style" removed: enables CSS injection (e.g. position:fixed overlays).
  // "id" removed: enables DOM clobbering — attacker-controlled IDs can shadow critical elements.
  const allowedAttrs = ["class","href","data-action","data-sc","data-diff","data-ch","data-table","data-mod","data-les","data-filter","data-panel","data-theme","data-lang","data-i18n","data-i18n-attr","data-i18n-html","data-example","data-dbtab","data-dbtable","data-sqltype","data-sql-type","data-cat","title","aria-hidden","aria-label","role","width","height"];

  function walkAndSanitize(parent) {
    const children = Array.from(parent.childNodes);
    for (const node of children) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (!allowedTags.includes(node.tagName)) {
          // Replace disallowed tags with their text content
          const text = document.createTextNode(node.textContent);
          parent.replaceChild(text, node);
          continue;
        }
        // Remove disallowed attributes
        const attrs = Array.from(node.attributes);
        for (const attr of attrs) {
          if (!allowedAttrs.includes(attr.name)) {
            node.removeAttribute(attr.name);
          }
        }
        // SEC-1 fix: sanitize href on <A> tags — strip javascript:, vbscript:, data: URIs.
        // href is in allowedAttrs; this guard prevents script-protocol injection.
        if (node.tagName === 'A' && node.hasAttribute('href')) {
          const href = node.getAttribute('href').replace(/\s/g, '').toLowerCase();
          if (/^(javascript|vbscript|data):/.test(href)) {
            node.removeAttribute('href');
          }
          // SEC-1 fix: ensure all external links have noopener/noreferrer
          node.setAttribute('rel', 'noopener noreferrer');
          node.setAttribute('target', '_blank');
        }
        // Recursively sanitize children
        walkAndSanitize(node);
      }
    }
  }

  walkAndSanitize(template.content);
  return template.innerHTML;
}

// applyBarWidths — after setting innerHTML on a container, call this to apply
// width values stored in data-w="N" attributes as element.style.width.
// This avoids inline style="width:N%" attributes in HTML strings, which would
// require 'unsafe-inline' in the CSP style-src directive.
function applyBarWidths(container) {
  container.querySelectorAll('[data-w]').forEach(el => {
    el.style.width = el.getAttribute('data-w') + '%';
  });
}
function applyBarColors(container) {
  container.querySelectorAll('[data-color]').forEach(el => {
    const c = el.getAttribute('data-color');
    // Only allow CSS custom properties and hex colors to prevent CSS injection
    if (/^(var\(--[\w-]+\)|#[0-9a-fA-F]{3,8})$/.test(c)) {
      el.style.background = c;
    }
  });
}

function clamp(v, min, max) {
  if (typeof v !== "number" || isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

// Fix #4: Make $() a caching wrapper over EL so $('foo') and EL['foo'] always
// refer to the same cached node. EL properties defined via Object.defineProperty
// handle their own lazy initialisation; plain string keys are set here on first
// use. Do NOT cache IDs inside dynamically re-rendered containers — call
// EL._flush() after any innerHTML replacement that destroys cached children.
function $(id) {
  const cached = EL[id];
  if (cached !== undefined) return cached;
  const el = document.getElementById(id);
  // Only store in EL if the slot isn't already a defineProperty getter
  if (el && !Object.getOwnPropertyDescriptor(EL, id)) EL[id] = el;
  return el;
}

// ── Query history for terminal (↑↓ navigation) ──────────────────
const _qHistory = [];
let _qHistIdx = -1;

// ── DOM element cache (Q3 fix: true caching with lazy initialisation) ──
// Each property is looked up once on first access and then cached.
const EL = {};
['free-sql','free-out','free-fb','s-boot','s-game','s-cin',
 'boot-name','tut-ex-sql','sc-list','kpi-rep','sc-search-clear',
 'completion-overlay','chapter-recap-overlay','key-help',
 'key-help-backdrop','set-reset-confirm'].forEach(id => {
  let _cached = null;
  Object.defineProperty(EL, id, {
    get() {
      if (!_cached) _cached = document.getElementById(id);
      return _cached;
    },
    enumerable: true,
    configurable: true
  });
});
// Allow cache invalidation after major DOM rebuilds (e.g. full re-render)
EL._flush = function() {
  const ids = Object.keys(this).filter(k => k !== '_flush');
  ids.forEach(id => {
    let _cached = null;
    Object.defineProperty(this, id, {
      get() { if (!_cached) _cached = document.getElementById(id); return _cached; },
      enumerable: true, configurable: true
    });
  });
};
function err(msg) { return { ok: false, msg }; }

// ── i18n helper with interpolation ───────────────────────────────
// Usage: ti('js_val_row_count', {actual: 3, expected: 5})
// Falls back to key if t() is not available
function ti(key, vars) {
  let s = (typeof t === 'function') ? t(key) : key;
  // O16: single-pass replacement instead of one regex per variable
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (match, k) => vars[k] !== undefined ? String(vars[k]) : match);
  }
  return s;
}


// Geeft een pedagogische foutmelding zonder de volledige oplossing prijs te geven.
// Verwijdert kant-en-klare queries uit foutmeldingen zodat leerlingen zelf moeten nadenken.
// Let op: alleen volledige queries worden gestript (SELECT + FROM + minstens 1 ander keyword),
// géén losse uitleg-fragmenten met keywords in backticks.
function stripSolution(msg) {
  // Strips backtick-enclosed code fragments from error messages only when they look
  // like a complete, runnable SQL query — not pedagogical keyword references.
  //
  // Heuristic (tightened to reduce false positives on explanatory text):
  //   • Must be ≥20 chars (rules out single keywords like `SELECT`)
  //   • For SELECT queries: requires SELECT + FROM + at least 2 additional SQL keywords
  //     (e.g. WHERE, GROUP BY, ORDER BY). "SELECT naam FROM klant" alone is borderline
  //     pedagogical, so we require a third clause before stripping.
  //   • For non-SELECT DML/DDL (INSERT, UPDATE, DELETE, CREATE): requires ≥4 keywords.
  //     This preserves short instructional snippets like `INSERT INTO ... VALUES (...)`.
  return msg.replace(/`([^`]{20,})`/g, (match, code) => {
    const upper = code.toUpperCase();
    const hasSelect = /\bSELECT\b/.test(upper);
    const hasFrom   = /\bFROM\b/.test(upper);
    const kws = (upper.match(/\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|ADD|COLUMN|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|PRIMARY\s+KEY|AUTO_INCREMENT)\b/g) || []);
    // Complete SELECT query: SELECT + FROM + ≥1 further keyword (e.g. WHERE, GROUP BY).
    // Three keywords total is the minimum for a runnable query that gives away the answer.
    // A bare "SELECT x FROM t" (2 keywords) is borderline pedagogical and is NOT stripped.
    if (hasSelect && hasFrom && kws.length >= 3) return '<code>…</code>';
    // Other DML/DDL (INSERT, UPDATE, DELETE, CREATE): needs ≥3 keywords total.
    // "INSERT INTO tabel" alone (2 kw) → kept as pedagogical fragment.
    // "INSERT INTO tabel VALUES (…)" = 3 kw → stripped (it's a complete statement).
    // "UPDATE tabel SET col WHERE …" = 3 kw → stripped.
    if (!hasSelect && kws.length >= 3) return '<code>…</code>';
    return match;
  });
}

// ── STATE ─────────────────────────────────────────────────────────
const G = {
  name: '',
  xp: 0,
  rep: 100,
  streak: 0,
  done: new Set(),
  ach: new Set(),
  events: [],
  tutDone: new Set(),
  hintsUsedChs: new Set(),
  seenConcepts: new Set(),
  seenKeywords: new Set(),
  chRecapSeen: new Set(), // welke hoofdstuk-recaps al getoond
  consecutiveErrors: 0,  // reeks reset pas na 2 fouten op rij
  xpHistory: [],  // XP earned per session (last 7)
  stepsDone: {},  // multi-step scenario progress: {scenarioId: completedStepCount}
  streakShields: 0,       // Feature 7: shields beschermen de reeks
  weekStreak: 0,          // Feature 7: wekelijkse reeks
  correctThisWeek: 0,     // Feature 7: teller voor shield generatie
};

// ── STORAGE ───────────────────────────────────────────────────────
// ── OPEN SCENARIO HERSTEL ────────────────────────────────────────
// Sla het laatste open scenario op bij elke wisssel, herstel bij laden
function saveOpenSc(id) {
  try { localStorage.setItem('datashop_opensc', id || ''); } catch(e) {}
}
function loadOpenSc() {
  try { return localStorage.getItem('datashop_opensc') || ''; } catch(e) { return ''; }
}

// O9: Debounced save — multiple rapid save() calls (e.g. solve → ach → chapter check)
// only write to localStorage once. saveNow() is available for critical moments.
let _saveTimer = null;
let _resetPending = false;  // set to true before reload so beforeunload doesn't re-save

// ── SEC-1 FIX: Integrity check for localStorage ─────────────────
// Simple checksum to detect casual tampering via DevTools.
// Not cryptographically unbreakable (client-side key is inspectable), but raises
// the bar significantly above "just edit the JSON". The hash uses FNV-1a with a
// salt derived from the player name, so each save file has a unique checksum.
const _INTEGRITY_SALT = 'D4t4Sh0p_CEO_2026_';
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
function _computeChecksum(jsonStr) {
  return _fnv1a(_INTEGRITY_SALT + jsonStr + _INTEGRITY_SALT);
}

function save() { if (_resetPending) return; clearTimeout(_saveTimer); _saveTimer = setTimeout(_doSave, 200); }
function saveNow() { if (_resetPending) return; clearTimeout(_saveTimer); _doSave(); }
function _doSave() {
  if (_resetPending) return;
  try {
    const payload = JSON.stringify({
      name: G.name, xp: G.xp, rep: G.rep, streak: G.streak,
      done: [...G.done], ach: [...G.ach],
      tutDone: [...G.tutDone],
      hintsUsedChs: [...G.hintsUsedChs],
      seenConcepts: [...G.seenConcepts],
      seenKeywords: G.seenKeywords ? [...G.seenKeywords] : [],
      xpHistory: G.xpHistory||[],
      chRecapSeen:  [...G.chRecapSeen],
      stepsDone: G.stepsDone || {},
      streakShields: G.streakShields || 0,
      weekStreak: G.weekStreak || 0,
      correctThisWeek: G.correctThisWeek || 0,
    });
    localStorage.setItem('datashop_v3', payload);
    localStorage.setItem('datashop_v3_chk', _computeChecksum(payload));
  } catch(e) {
    // QuotaExceededError: localStorage is full (common in private/incognito mode).
    // Show a non-blocking toast so the user knows their progress was not saved.
    if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
      if (typeof UI !== 'undefined' && UI.toast) {
        UI.toast('⚠️ Voortgang kon niet worden opgeslagen — browseropslag vol of geblokkeerd.', 'warn');
      } else {
        console.warn('[save] localStorage quota exceeded — progress not persisted.');
      }
    }
    // Other errors (SecurityError in sandboxed iframes, etc.) are silently ignored.
  }
}

function load() {
  try {
    const raw = localStorage.getItem('datashop_v3');
    if (!raw) return false;
    // SEC-1: Verify integrity checksum
    const storedChk = localStorage.getItem('datashop_v3_chk');
    if (storedChk) {
      // Checksum exists — verify it. If tampered, warn and reject.
      const expectedChk = _computeChecksum(raw);
      if (storedChk !== expectedChk) {
        console.warn('[load] Save data integrity check failed — data may have been tampered with.');
        // Mark save as tampered so certificate can reflect this
        G._tampered = true;
        // Still load the data (don't lock students out), but flag it
      }
    }
    // If no checksum exists, this is a pre-update save — migrate silently
    const d = JSON.parse(raw);
    if (typeof d !== "object" || d === null) return false;
    G.name    = typeof d.name === 'string' ? d.name.slice(0, 40) : '';
    G.xp      = clamp(d.xp, 0, 1e6);
    G.rep     = clamp(d.rep ?? 100, 0, 100);
    G.streak  = clamp(d.streak, 0, 10000);
    G.done    = new Set(Array.isArray(d.done) ? d.done.filter(x => typeof x === 'string') : []);
    G.ach     = new Set(Array.isArray(d.ach) ? d.ach.filter(x => typeof x === 'string') : []);
    G.tutDone      = new Set(Array.isArray(d.tutDone) ? d.tutDone.filter(x => typeof x === 'string') : []);
    G.hintsUsedChs = new Set(Array.isArray(d.hintsUsedChs) ? d.hintsUsedChs : []);
    G.seenConcepts = new Set(Array.isArray(d.seenConcepts) ? d.seenConcepts.filter(x => typeof x === 'string') : []);
    G.seenKeywords = new Set(Array.isArray(d.seenKeywords) ? d.seenKeywords.filter(x => typeof x === 'string') : []);
    G.chRecapSeen  = new Set(Array.isArray(d.chRecapSeen) ? d.chRecapSeen : []);
    G.stepsDone    = (typeof d.stepsDone === 'object' && d.stepsDone !== null) ? d.stepsDone : {};
    G.streakShields   = clamp(d.streakShields, 0, 10);
    G.weekStreak      = clamp(d.weekStreak, 0, 1000);
    G.correctThisWeek = clamp(d.correctThisWeek, 0, 1000);
    return !!G.name;
  } catch(e) { console.warn("Save corrupted"); return false; }
}

// O9: Flush pending save on page close so no data is lost
window.addEventListener('beforeunload', saveNow);

// ── DATABASE ──────────────────────────────────────────────────────
const DB = {
  klant: {
    cols: [
      {n:'klant_id',t:'INT',pk:true},
      {n:'naam',t:'VARCHAR(100)',nn:true},
      {n:'email',t:'VARCHAR(150)',uq:true},
      {n:'stad',t:'VARCHAR(80)'},
      {n:'actief',t:'BOOLEAN'}
    ],
    rows: [
      {klant_id:1,naam:'Jana Pieters',email:'jana@mail.be',stad:'Gent',actief:1},
      {klant_id:2,naam:'Bram Declercq',email:'bram@shop.be',stad:'Antwerpen',actief:1},
      {klant_id:3,naam:'Lena Maes',email:'lena@web.be',stad:'Brugge',actief:1},
      {klant_id:4,naam:'Kobe Janssen',email:'kobe@net.be',stad:'Leuven',actief:0},
      {klant_id:5,naam:'Fatima El Asri',email:'fatima@shop.be',stad:'Mechelen',actief:1},
      {klant_id:6,naam:'Pieter Wouters',email:null,stad:'Gent',actief:1},
    ], nid: 7
  },
  product: {
    cols: [
      {n:'product_id',t:'INT',pk:true},
      {n:'naam',t:'VARCHAR(100)',nn:true},
      {n:'prijs',t:'DECIMAL(8,2)',nn:true},
      {n:'stock',t:'INT'},
      {n:'categorie',t:'VARCHAR(60)'}
    ],
    rows: [
      {product_id:1,naam:'Draadloze muis',prijs:24.99,stock:15,categorie:'Elektronica'},
      {product_id:2,naam:'USB-C Hub',prijs:49.99,stock:8,categorie:'Elektronica'},
      {product_id:3,naam:'Notitieboek A5',prijs:7.50,stock:42,categorie:'Kantoor'},
      {product_id:4,naam:'Ergonomische stoel',prijs:299.00,stock:3,categorie:'Meubelen'},
      {product_id:5,naam:'Webcam HD',prijs:79.99,stock:0,categorie:'Elektronica'},
      {product_id:6,naam:'Koffiekop 350ml',prijs:12.50,stock:25,categorie:'Keuken'},
      {product_id:7,naam:'Laptop sleeve 15"',prijs:34.99,stock:0,categorie:'Elektronica'},
    ], nid: 8
  },
  bestelling: {
    cols: [
      {n:'bestelling_id',t:'INT',pk:true},
      {n:'klant_id',t:'INT',fk:true},
      {n:'product_id',t:'INT',fk:true},
      {n:'datum',t:'DATE',nn:true},
      {n:'aantal',t:'INT'},
      {n:'status',t:'VARCHAR(30)'}
    ],
    rows: [
      {bestelling_id:1,klant_id:1,product_id:1,datum:'2024-11-10',aantal:2,status:'geleverd'},
      {bestelling_id:2,klant_id:2,product_id:3,datum:'2024-11-15',aantal:5,status:'onderweg'},
      {bestelling_id:3,klant_id:1,product_id:4,datum:'2024-11-20',aantal:1,status:'verwerking'},
      {bestelling_id:4,klant_id:5,product_id:2,datum:'2024-12-03',aantal:1,status:'onderweg'},
    ], nid: 5
  },
  review: {
    cols: [
      {n:'review_id',t:'INT',pk:true},
      {n:'klant_id',t:'INT',fk:true},
      {n:'product_id',t:'INT',fk:true},
      {n:'score',t:'INT'},
      {n:'commentaar',t:'VARCHAR(255)'}
    ],
    rows: [
      {review_id:1,klant_id:1,product_id:1,score:5,commentaar:'Uitstekende muis!'},
      {review_id:2,klant_id:2,product_id:3,score:4,commentaar:'Goed papier.'},
      {review_id:3,klant_id:3,product_id:2,score:2,commentaar:'Hub werkt niet op Mac.'},
      {review_id:4,klant_id:1,product_id:4,score:5,commentaar:'Zeer comfortabel.'},
    ], nid: 5
  },
  kortingscode: {
    cols: [
      {n:'code_id',t:'INT',pk:true},
      {n:'code',t:'VARCHAR(20)',uq:true},
      {n:'korting',t:'INT'},
      {n:'actief',t:'BOOLEAN'},
      {n:'gebruik',t:'INT'}
    ],
    rows: [
      {code_id:1,code:'WELKOM10',korting:10,actief:1,gebruik:42},
      {code_id:2,code:'ZOMER20',korting:20,actief:0,gebruik:7},
      {code_id:3,code:'TROUW15',korting:15,actief:1,gebruik:3},
      {code_id:4,code:'FOUT999',korting:99,actief:1,gebruik:0},
    ], nid: 5
  },
};

// Polyfill: structuredClone not available in Safari <15.4, Chrome <98
// Uses globalThis (ES2020) with fallback for older environments
(function(g) {
  if (typeof g.structuredClone !== 'function') {
    g.structuredClone = function(obj) { return JSON.parse(JSON.stringify(obj)); };
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : {});

// Deep-clone the initial database so it can be reset at any time.
// Object.freeze on the outer object guards against accidental top-level mutation
// (e.g. DB_INITIAL.klant = ... would silently succeed without the freeze).
// Individual row arrays inside are not frozen because resetDB() reads them via
// JSON.parse(JSON.stringify(...)), so deep immutability is not required here.
const DB_INITIAL = Object.freeze(structuredClone(DB));

function resetDB() {
  const fresh = structuredClone(DB_INITIAL);
  for (const k of Object.keys(DB)) { if (!fresh[k]) delete DB[k]; }
  for (const [k,v] of Object.entries(fresh)) { DB[k] = v; }
  // Tables created by CREATE TABLE missions (e.g. leverancier) are not in
  // DB_INITIAL and are therefore removed here. That is intentional — a reset
  // returns the database to its initial state. Those missions must be re-run
  // after a reset to recreate those tables.
}

function dbStats() {
  const b=DB.bestelling.rows, p=DB.product.rows, k=DB.klant.rows;
  // Fix #5: Build a product_id→prijs map once (O(p)) so the reduce is O(b)
  // rather than O(b×p). p.find() inside reduce was O(n²).
  const priceMap = Object.fromEntries(p.map(x => [x.product_id, x.prijs]));
  const rev = b.reduce((s, o) => {
    const prijs = priceMap[o.product_id];
    return s + (prijs !== undefined ? prijs * o.aantal : 0);
  }, 0);
  return {
    klanten:   k.length,
    actief:    k.filter(x=>x.actief).length,
    producten: p.length,
    uitverkocht: p.filter(x=>x.stock===0).length,
    orders:    b.length,
    open:      b.filter(x=>x.status!=='geleverd').length,
    revenue:   rev.toFixed(2),
    avgScore:  DB.review.rows.length
      ? (DB.review.rows.reduce((s,r)=>s+r.score,0)/DB.review.rows.length).toFixed(1)
      : '—',
  };
}

// ── SQL ENGINE ────────────────────────────────────────────────────
function splitTop(str, kw) {
  const parts=[]; let buf='', depth=0;
  const isAnd = kw.toUpperCase()==='AND';
  // O10: precompile regex once instead of per-character
  const kwRe = isAnd ? null : new RegExp('^\\s+'+kw+'\\s+','i');
  for (let i=0; i<str.length; i++) {
    if (str[i]==='(') depth++;
    else if (str[i]===')') depth--;
    if (depth===0 && isAnd) {
      // Don't split AND that belongs to a BETWEEN ... AND ... expression
      const rest=str.slice(i);
      const andM=rest.match(/^\s+AND\s+/i);
      if (andM) {
        // Check if the buffer ends with a BETWEEN clause (i.e. "col BETWEEN x")
        const isBetween = /\bBETWEEN\s+\S+\s*$/i.test(buf.trimEnd());
        if (!isBetween) { parts.push(buf); buf=''; i+=andM[0].length-1; continue; }
      }
    } else if (depth===0) {
      const rest=str.slice(i);
      const m=rest.match(kwRe);
      if (m) { parts.push(buf); buf=''; i+=m[0].length-1; continue; }
    }
    buf+=str[i];
  }
  parts.push(buf);
  return parts.length>1 ? parts : [str];
}

// Linear-time SQL LIKE matcher (no regex). Handles % (any chars) and _ (single char).
// O(n*m) worst case via DP, immune to catastrophic backtracking.
function sqlLikeMatch(value, pattern) {
  const n = value.length, m = pattern.length;
  // dp[j] = true means pattern[0..j-1] matches value[0..i-1]
  let prev = new Array(m + 1).fill(false);
  prev[0] = true;
  // Leading %'s match empty string
  for (let j = 1; j <= m; j++) {
    if (pattern[j - 1] === '%') prev[j] = prev[j - 1];
    else break;
  }
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(false);
    for (let j = 1; j <= m; j++) {
      const pc = pattern[j - 1];
      if (pc === '%') {
        cur[j] = cur[j - 1] || prev[j]; // skip % or consume one more char
      } else if (pc === '_' || pc === value[i - 1]) {
        cur[j] = prev[j - 1];
      }
    }
    prev = cur;
  }
  return prev[m];
}

function evalWhere(row, clause) {
  clause=clause.trim();
  if (clause.startsWith('(')&&clause.endsWith(')')) {
    let d=0,ok=true;
    for(let i=0;i<clause.length-1;i++){
      if(clause[i]==='(')d++;
      else if(clause[i]===')'){d--;if(d===0){ok=false;break;}}
    }
    if(ok) clause=clause.slice(1,-1).trim();
  }
  const ands=splitTop(clause,'AND');
  if(ands.length>1) return ands.every(p=>evalWhere(row,p.trim()));
  const ors=splitTop(clause,'OR');
  if(ors.length>1) return ors.some(p=>evalWhere(row,p.trim()));
  let m;
  m=clause.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i); if(m) return row[m[1]]!=null;
  m=clause.match(/^(\w+)\s+IS\s+NULL$/i);        if(m) return row[m[1]]==null;
  m=clause.match(/^(\w+)\s+(NOT\s+LIKE|LIKE)\s+'([^']*)'$/i);
  if(m){
    const notL=/NOT\s+LIKE/i.test(m[2]);
    const v=String(row[m[1]]||'').toLowerCase();
    const pattern=m[3].toLowerCase();
    // Linear-time SQL LIKE matcher — avoids Regex DoS from repeated % wildcards.
    // Uses dynamic programming: dp[j] = "can pattern[0..j-1] match value[0..i-1]?"
    const r=sqlLikeMatch(v, pattern);
    return notL?!r:r;
  }
  m=clause.match(/^(\w+)\s+NOT\s+IN\s*\(([^)]+)\)$/i);
  if(m){const rv=row[m[1]];const rn=Number(rv);const vals=m[2].split(',').map(v=>{const t=v.trim().replace(/^'|'$/g,'');return isNaN(Number(t))?t.toLowerCase():Number(t);});return !vals.some(v=>typeof v==='number'?v===rn:v===String(rv||'').toLowerCase());}
  m=clause.match(/^(\w+)\s+IN\s*\(([^)]+)\)$/i);
  if(m){const rv=row[m[1]];const rn=Number(rv);const vals=m[2].split(',').map(v=>{const t=v.trim().replace(/^'|'$/g,'');return isNaN(Number(t))?t.toLowerCase():Number(t);});return vals.some(v=>typeof v==='number'?v===rn:v===String(rv||'').toLowerCase());}
  m=clause.match(/^(\w+)\s+BETWEEN\s+['"]?([^'"\s]+)['"]?\s+AND\s+['"]?([^'"\s]+)['"]?$/i);
  if(m){const rv=row[m[1]],n=Number(rv),lo=Number(m[2]),hi=Number(m[3]);if(!isNaN(n)&&!isNaN(lo)&&!isNaN(hi))return n>=lo&&n<=hi;return String(rv)>=m[2]&&String(rv)<=m[3];}
  m=clause.match(/^(?:\w+\.)?(\w+)\s*(>=|<=|!=|<>|>|<|=)\s*'?([^']*?)'?$/);
  if(m){
    const[,col,op,raw]=m,rv=row[col];
    const cv=typeof rv==='number'&&raw!==''&&!isNaN(Number(raw))?Number(raw):raw;
    // Case-insensitive string comparison for = and !=
    // Strict equality (===) after numeric coercion prevents surprises like 0 === ""
    const eq=(a,b)=>typeof a==='string'&&typeof b==='string'?a.toLowerCase()===b.toLowerCase():a===b;
    switch(op){case'=':return eq(rv,cv);case'!=':case'<>':return !eq(rv,cv);case'>':return rv>cv;case'<':return rv<cv;case'>=':return rv>=cv;case'<=':return rv<=cv;}
  }
  // Unrecognised condition: throw so callers get a clear error instead of silent empty results.
  throw new Error('Onbekende WHERE-conditie: ' + clause);
}

function evalWhereJoin(row, clause) {
  clause=clause.trim();
  const ands=splitTop(clause,'AND'); if(ands.length>1) return ands.every(p=>evalWhereJoin(row,p.trim()));
  const ors=splitTop(clause,'OR');   if(ors.length>1)  return ors.some(p=>evalWhereJoin(row,p.trim()));
  const resolve=ref=>{
    let v=row[ref];
    if(v===undefined){const bare=ref.replace(/^\w+\./,'');const k=Object.keys(row).find(k=>k.endsWith('.'+bare));v=k?row[k]:undefined;}
    return v;
  };
  let m;
  // IS NOT NULL / IS NULL support (missing in original)
  m=clause.match(/^([\w.]+)\s+IS\s+NOT\s+NULL$/i); if(m) return resolve(m[1])!=null;
  m=clause.match(/^([\w.]+)\s+IS\s+NULL$/i);        if(m) return resolve(m[1])==null;
  m=clause.match(/^([\w.]+)\s*(=|!=|<>|>|<|>=|<=)\s*([\w.]+)$/);
  if(m){const lv=resolve(m[1]),rv=resolve(m[3]);const eq=(a,b)=>typeof a==='string'&&typeof b==='string'?a.toLowerCase()===b.toLowerCase():a===b;switch(m[2]){case'=':return eq(lv,rv);case'!=':case'<>':return !eq(lv,rv);case'>':return lv>rv;case'<':return lv<rv;case'>=':return lv>=rv;case'<=':return lv<=rv;}}
  m=clause.match(/^([\w.]+)\s*(=|!=|<>|>|<|>=|<=)\s*'?([^']*?)'?$/);
  if(m){const rv2=resolve(m[1]),cv=typeof rv2==='number'&&!isNaN(Number(m[3]))?Number(m[3]):m[3];const eq=(a,b)=>typeof a==='string'&&typeof b==='string'?a.toLowerCase()===b.toLowerCase():a===b;switch(m[2]){case'=':return eq(rv2,cv);case'!=':case'<>':return !eq(rv2,cv);case'>':return rv2>cv;case'<':return rv2<cv;case'>=':return rv2>=cv;case'<=':return rv2<=cv;}}
  // Unrecognised condition: throw so callers get a clear error (consistent with evalWhere).
  throw new Error('Onbekende JOIN WHERE-conditie: ' + clause);
}

function parseVals(str) {
  const vals=[]; let cur='',inStr=false,sc='';
  for(const ch of str){
    if(inStr){if(ch===sc)inStr=false;else cur+=ch;}
    else if(ch==='"'||ch==="'"){inStr=true;sc=ch;}
    else if(ch===','){vals.push(coerce(cur.trim()));cur='';}
    else cur+=ch;
  }
  vals.push(coerce(cur.trim()));
  return vals;
}

function coerce(v) { return v===''||isNaN(Number(v))?v:Number(v); }

function runSQL(rawSql) {
  // Normalize: strip comments, collapse whitespace, trim
  const s = rawSql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const sl = s.toLowerCase();
  // Subquery support: resolve innermost (SELECT ...) before outer query
  if(sl.startsWith('select'))       return doSelect(s);
  if(sl.startsWith('insert'))       return doInsert(s);
  if(sl.startsWith('update'))       return doUpdate(s);
  if(sl.startsWith('delete'))       return doDelete(s);
  if(sl.startsWith('create table')) return doCreate(s);
  if(sl.startsWith('alter table'))  return doAlter(s);
  if(sl.startsWith('drop'))         return err(t('js_eng_drop_forbidden'));
  // Targeted errors for unsupported SQL features — clearer than the generic fallback
  if(/\bunion\b/i.test(sl))          return err(t('js_eng_union_unsupported'));
  if(/\btruncate\b/i.test(sl))       return err(t('js_eng_truncate_unsupported'));
  return err(stripSolution(t('js_eng_use_statement')));
}

// Q1 fix: multiCheck removed — was dead code with no call sites.

// ── SUBQUERY RESOLVER ─────────────────────────────────────────────
function resolveSubqueries(sql) {
  // Resolve scalar subqueries: col OP (SELECT ...) → col OP value
  // Also IN (SELECT ...) → IN (v1,v2,...)
  // Hard cap at 5 iterations. Deeply nested subqueries beyond this limit get a
  // clear error rather than an exponential table-scan that hangs the browser tab.
  let out = sql;
  const MAX_SUBQUERY_DEPTH = 5;
  for (let i = 0; i < MAX_SUBQUERY_DEPTH; i++) {
    // Find innermost subquery: allow nested parens inside (for AVG(col), COUNT(*), etc.)
    // Strategy: find "(SELECT" then scan forward counting parens to find the matching ")"
    const startIdx = out.search(/\(\s*SELECT\s/i);
    if (startIdx === -1) break;
    let depth = 0, endIdx = -1;
    for (let j = startIdx; j < out.length; j++) {
      if (out[j] === '(') depth++;
      else if (out[j] === ')') { depth--; if (depth === 0) { endIdx = j; break; } }
    }
    if (endIdx === -1) break;
    const inner = out.slice(startIdx + 1, endIdx).trim(); // without outer parens
    const res = runSQL(inner);
    if (res.ok && res.rows && res.rows.length) {
      const vals = res.rows.map(r => {
        const v = Object.values(r)[0];
        // Don't quote numeric values — so "prijs > 72.71" works, not "prijs > '72.71'"
        if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)))) return String(Number(v));
        // E9 fix: escape embedded single quotes in string values
        return typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v ?? 'NULL');
      });
      const beforeSubq = out.slice(0, startIdx).trimEnd().toUpperCase();
      const isInContext = /\bNOT\s+IN\s*$/.test(beforeSubq) || /\bIN\s*$/.test(beforeSubq);
      const replacement = isInContext ? `(${vals.join(',')})` : vals[0];
      out = out.slice(0, startIdx) + replacement + out.slice(endIdx + 1);
    } else break;
  }
  // If unresolved subqueries remain after MAX_SUBQUERY_DEPTH iterations, the query
  // is too deeply nested to process safely. Return a sentinel that runSQL will reject
  // cleanly rather than performing a silent exponential table-scan.
  if (/\(\s*SELECT/i.test(out)) {
    return '__SUBQUERY_TOO_DEEP__';
  }
  return out;
}

// ── SHARED COLUMN PARSERS (used by both doExplicitJoin and doSingleSelect) ──
// Split on commas but NOT inside CASE...END blocks
function splitColParts(str) {
  const parts = []; let cur = '', depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ahead = str.slice(i).toUpperCase();
    if (/^CASE\b/.test(ahead)) depth++;
    if (/^END\b/.test(ahead) && depth > 0) { depth--; cur += 'END'; i += 2; continue; }
    if (str[i] === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += str[i];
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
// Evaluate a CASE WHEN ... END expression against a row
function evalCase(expr, row) {
  const norm = expr.replace(/\s+/g,' ').trim();
  const branches = [];
  const whenRe = /WHEN\s+(.*?)\s+THEN\s+(?:'([^']*)'|([\d.]+))/gi;
  let wm;
  while ((wm = whenRe.exec(norm)) !== null) branches.push({ cond: wm[1], val: wm[2] !== undefined ? wm[2] : coerce(wm[3]) });
  const elseM = norm.match(/ELSE\s+(?:'([^']*)'|([\d.]+))/i);
  const elseVal = elseM ? (elseM[1] !== undefined ? elseM[1] : coerce(elseM[2])) : null;
  for (const b of branches) { try { if (evalWhere(row, b.cond)) return b.val; } catch(e) {} }
  return elseVal;
}

// ── SHARED MULTI-COLUMN ORDER BY ─────────────────────────────────
// Parses "col1 ASC, col2 DESC, col3" into [{col, asc}, ...] and applies
// a stable sort chain. Fixes BUG-1: multi-column ORDER BY was silently
// ignored — only the first column (with trailing comma) was used.
function parseOrderCols(orderByStr) {
  return orderByStr.split(',').map(part => {
    const tokens = part.trim().split(/\s+/);
    const col = tokens[0];
    const asc = !tokens[1] || tokens[1].toUpperCase() === 'ASC';
    return { col, asc };
  }).filter(o => o.col);
}

function applyMultiSort(rows, orderByStr, resolveColFn) {
  const cols = parseOrderCols(orderByStr);
  if (!cols.length) return;
  rows.sort((a, b) => {
    for (const { col, asc } of cols) {
      let av, bv;
      if (resolveColFn) {
        av = resolveColFn(col, a);
        bv = resolveColFn(col, b);
      } else {
        const bare = col.replace(/^\w+\./, '');
        av = a[bare] ?? a[col];
        bv = b[bare] ?? b[col];
      }
      if (av < bv) return asc ? -1 : 1;
      if (av > bv) return asc ? 1 : -1;
    }
    return 0;
  });
}

// ── SHARED AGGREGATE COMPUTATION ─────────────────────────────────
// ARCH-3+4: Extracted from doExplicitJoin, doSingleSelect, and doJoin
// to eliminate triple-duplicated GROUP BY / HAVING logic.
function computeAggregate(fn, vals) {
  switch(fn) {
    case 'AVG': return vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2) : null;
    case 'SUM': return vals.reduce((a,b)=>a+b,0).toFixed(2);
    case 'MAX': return vals.length ? Math.max(...vals) : null;
    case 'MIN': return vals.length ? Math.min(...vals) : null;
  }
  return null;
}

// Shared GROUP BY: groups rows, computes aggregates, returns result rows.
// resolveColFn(ref, row) resolves a column reference to its value.
// For simple tables: (ref, row) => row[ref]
// For JOINs: the prefixed resolver from doExplicitJoin/doJoin
function applyGroupBy(rows, grpBy, colStr, resolveColFn) {
  if (!resolveColFn) resolveColFn = (ref, row) => row[ref];
  const grpKey = grpBy.replace(/^\w+\./, '');
  const grps = {};
  rows.forEach(r => {
    const k = resolveColFn(grpBy, r) ?? resolveColFn(grpKey, r) ?? 'NULL';
    if (!grps[k]) grps[k] = [];
    grps[k].push(r);
  });
  const colParts = colStr.split(',').map(c => c.trim());
  const gRows = Object.entries(grps).map(([k, grpRows]) => {
    const out = {};
    colParts.forEach(p => {
      const aliasM = p.match(/^(.+?)\s+as\s+(\w+)$/i);
      const expr = aliasM ? aliasM[1].trim() : p;
      const label = aliasM ? aliasM[2] : expr;
      if (/^count\s*\(\s*\*\s*\)$/i.test(expr)) {
        out[label] = grpRows.length;
      } else {
        const aggM = expr.match(/^(AVG|SUM|MAX|MIN)\s*\(\s*([\w.]+)\s*\)$/i);
        if (aggM) {
          const fn = aggM[1].toUpperCase(), col = aggM[2];
          const vals = grpRows.map(r => Number(resolveColFn(col, r))).filter(v => !isNaN(v));
          out[label] = computeAggregate(fn, vals);
        } else {
          // Plain column (typically the GROUP BY key)
          const bare = expr.replace(/^\w+\./, '');
          out[label.replace(/^\w+\./, '')] = resolveColFn(expr, grpRows[0]) ?? resolveColFn(bare, grpRows[0]) ?? k;
        }
      }
    });
    return out;
  });
  return { gRows, colParts };
}

// Shared HAVING filter: supports COUNT(*) > n, AVG(col) > n, alias > n
// colParts is needed for alias resolution (BUG-4 fix)
function applyHaving(rows, having, colParts) {
  if (!having) return rows;
  const hm = having.match(/(count\s*\(\s*\*\s*\)|(?:AVG|SUM|MAX|MIN)\s*\(\s*[\w.]+\s*\))\s*(>|<|>=|<=|=|!=)\s*([\d.]+)/i);
  const aliasHm = !hm ? having.match(/^(\w+)\s*(>|<|>=|<=|=|!=)\s*([\d.]+)$/i) : null;

  const evalHaving = (v, op, n) => {
    switch(op){ case'>':return v>n; case'<':return v<n; case'>=':return v>=n; case'<=':return v<=n; case'=':return v==n; case'!=':return v!=n; }
    return true;
  };

  // Find the row key that matches the HAVING expression (raw aggregate or alias)
  const findKey = (r, exprRaw) => {
    // ENG-4 fix: removed .includes() fallback that could match partial key names.
    // Exact match (after whitespace normalization) handles all legitimate cases.
    let key = Object.keys(r).find(k => k.toUpperCase().replace(/\s+/g,'') === exprRaw);
    if (key) return key;
    if (exprRaw.includes('COUNT')) { key = Object.keys(r).find(k => k === 'COUNT(*)'); if (key) return key; }
    // Alias resolution: check SELECT colParts for aggregate→alias mapping
    if (colParts) {
      for (const p of colParts) {
        const am = p.match(/^(.+?)\s+as\s+(\w+)$/i);
        if (am && am[1].trim().toUpperCase().replace(/\s+/g,'') === exprRaw) {
          key = Object.keys(r).find(k => k === am[2]);
          if (key) return key;
        }
      }
    }
    return undefined;
  };

  if (hm) {
    const havExprRaw = hm[1].toUpperCase().replace(/\s+/g,''), op = hm[2], n = Number(hm[3]);
    return rows.filter(r => {
      const key = findKey(r, havExprRaw);
      if (key === undefined) return true;
      return evalHaving(Number(r[key]), op, n);
    });
  } else if (aliasHm) {
    const aliasName = aliasHm[1], op = aliasHm[2], n = Number(aliasHm[3]);
    return rows.filter(r => {
      const key = Object.keys(r).find(k => k.toLowerCase() === aliasName.toLowerCase());
      if (key === undefined) return true;
      return evalHaving(Number(r[key]), op, n);
    });
  }
  return rows;
}

function doSelect(sql) {
  // Resolve subqueries first
  if (/\(\s*SELECT/i.test(sql)) sql = resolveSubqueries(sql);
  if (sql.includes('__SUBQUERY_TOO_DEEP__')) return err(t('js_eng_subquery_deep'));
  // Detect ANSI JOIN syntax: INNER JOIN, LEFT JOIN, RIGHT JOIN, JOIN
  if (/\b(INNER|LEFT|RIGHT|CROSS)?\s*JOIN\b/i.test(sql)) return doExplicitJoin(sql);
  // Detect implicit JOIN (comma-separated tables)
  const fm=sql.match(/\bfrom\s+([\w\s,]+?)(?:\s+(?:where|order|limit|group|having)\b|$)/i);
  if(fm&&fm[1].includes(',')) {
    const joinRes = doJoin(sql);
    if (joinRes) return joinRes;
    // doJoin returned null — the implicit JOIN syntax wasn't parseable.
    // Return a clear error instead of silently falling back to doSingleSelect.
    return err(t('js_eng_implicit_join_failed'));
  }
  return doSingleSelect(sql);
}

// ── EXPLICIT JOIN ENGINE (INNER JOIN / LEFT JOIN / RIGHT JOIN ... ON) ──────
function doExplicitJoin(sql) {
  // Parseer: SELECT kolommen FROM tabel1 [alias] [INNER|LEFT|RIGHT] JOIN tabel2 [alias] ON conditie [JOIN ...] [WHERE ...] [GROUP BY] [HAVING] [ORDER BY] [LIMIT]
  const selM = sql.match(/^select\s+(.*?)\s+from\s+/i);
  if (!selM) return err(t('js_eng_check_select'));
  const colStr = selM[1];

  // Extract everything after FROM
  const afterFrom = sql.slice(selM[0].length);

  // Parseer stap voor stap
  let remaining = afterFrom.trim();

  // Parseer eerste tabel + optioneel alias
  const firstTblM = remaining.match(/^(\w+)(?:\s+(\w+))?\s*/i);
  if (!firstTblM) return err(t('js_eng_table_missing_from'));
  const firstTblName = firstTblM[1].toLowerCase();
  const firstTblAlias = (firstTblM[2] && !/^(inner|left|right|cross|join|where|on|order|group|having|limit)$/i.test(firstTblM[2]))
    ? firstTblM[2].toLowerCase() : firstTblName;

  if (!DB[firstTblName]) return err(ti('js_eng_table_not_found', {tbl: esc(firstTblName), available: Object.keys(DB).join(', ')}));

  // Advance remaining past table name + alias only (not JOIN keywords that follow)
  const firstTblConsumed = firstTblAlias !== firstTblName
    ? firstTblName.length + 1 + firstTblAlias.length
    : firstTblName.length;
  remaining = remaining.slice(firstTblConsumed).trimStart();

  // Parse JOIN ... ON ... blocks
  const joinSteps = []; // [{joinType, tblName, alias, onLeft, op, onRight}]
  // Multi-condition ON clauses (e.g. ON a.id = b.id AND a.x = b.x) are not supported.
  // Detect them explicitly and return a clear error rather than silently mismatching rows.
  const multiOnRe = /^(?:INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|JOIN)\s+\w+(?:\s+\w+)?\s+ON\s+\S+\s*(?:=|!=|<>|<=|>=|<|>)\s*\S+\s+AND\b/i;
  if (multiOnRe.test(remaining)) {
    return err(t('js_eng_multi_on'));
  }
  // E2 fix: CROSS JOIN does not require ON clause
  const joinBlockRe = /^(INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|JOIN)\s+(\w+)(?:\s+(\w+))?\s+ON\s+(\S+)\s*(=|!=|<>|<=|>=|<|>)\s*(\S+)\s*/i;
  const crossJoinRe = /^(CROSS\s+JOIN)\s+(\w+)(?:\s+(\w+))?\s*/i;
  while (true) {
    let jm = remaining.match(joinBlockRe);
    let isCrossNoOn = false;
    if (!jm) {
      // Try CROSS JOIN without ON
      jm = remaining.match(crossJoinRe);
      if (!jm) break;
      isCrossNoOn = true;
    }
    const joinType = jm[1].toUpperCase().replace(/\s+/g,' ').includes('LEFT') ? 'LEFT'
                   : jm[1].toUpperCase().includes('RIGHT') ? 'RIGHT'
                   : jm[1].toUpperCase().includes('CROSS') ? 'CROSS' : 'INNER';
    const tblName = jm[2].toLowerCase();
    const rawAlias = jm[3];
    const alias = (rawAlias && !/^(on|where|inner|left|right|join|group|order|having|limit)$/i.test(rawAlias))
      ? rawAlias.toLowerCase() : tblName;
    if (!DB[tblName]) return err(ti('js_eng_table_not_found_join', {tbl: esc(tblName)}));
    if (isCrossNoOn) {
      // CROSS JOIN without ON: use a dummy ON that always returns true
      joinSteps.push({joinType: 'CROSS', tblName, alias, onLeft: null, op: null, onRight: null, crossNoOn: true});
    } else {
      const onLeft = jm[4], op = jm[5], onRight = jm[6];
      joinSteps.push({joinType, tblName, alias, onLeft, op, onRight});
    }
    remaining = remaining.slice(jm[0].length);
  }

  if (!joinSteps.length) return err(t('js_eng_join_syntax'));

  // Parseer optionele clausules (WHERE / GROUP BY / HAVING / ORDER BY / LIMIT)
  let where=null, grpBy=null, having=null, orderBy=null, limit=null;
  let rm = remaining.trim();

  const whereM = rm.match(/^where\s+(.+?)(?:\s+(?:group\s+by|order\s+by|having|limit)\b|$)/i);
  if (whereM) { where = whereM[1].trim(); rm = rm.slice(whereM[0].length).trim(); }
  const grpM = rm.match(/^group\s+by\s+([\w.,\s]+?)(?=\s+(?:having|order\s+by|limit)\b|$)/i);
  if (grpM) { grpBy = grpM[1]; rm = rm.slice(grpM[0].length).trim(); }
  const havM = rm.match(/^having\s+(.+?)(?:\s+(?:order\s+by|limit)\b|$)/i);
  if (havM) { having = havM[1].trim(); rm = rm.slice(havM[0].length).trim(); }
  const ordM = rm.match(/^order\s+by\s+(.+?)(?=\s+limit\b|$)/i);
  if (ordM) { orderBy = ordM[1] + (ordM[2] ? ' '+ordM[2] : ''); rm = rm.slice(ordM[0].length).trim(); }
  const limM = rm.match(/^limit\s+(\d+)/i);
  if (limM) { limit = Number(limM[1]); }

  // Resolve column reference: "alias.col" or "col" → row value
  function resolveCol(ref, row) {
    if (row[ref] !== undefined) return row[ref];
    const bare = ref.replace(/^\w+\./, '');
    const key = Object.keys(row).find(k => k === bare || k.endsWith('.'+bare));
    return key !== undefined ? row[key] : undefined;
  }

  // Evaluate ON condition: left op right (both column refs)
  function evalOn(row, leftRef, op, rightRef) {
    const lv = resolveCol(leftRef, row);
    const rv = resolveCol(rightRef, row);
    // Use strict equality consistent with evalWhere — avoids type-coercion surprises
    // (e.g. 0 == "" is true with ==, false with ===). For numeric JOIN keys both sides
    // will be the same type from the DB, so === is safe and correct.
    switch(op) {
      case '=':  return lv === rv;
      case '!=': case '<>': return lv !== rv;
      case '>':  return lv > rv;
      case '<':  return lv < rv;
      case '>=': return lv >= rv;
      case '<=': return lv <= rv;
    }
    return false;
  }

  // Prefix all columns with alias
  function prefixRow(r, alias) {
    const o = {};
    Object.keys(r).forEach(k => { o[alias+'.'+k] = r[k]; o[k] = r[k]; });
    return o;
  }

  // Start with first table
  let rows = DB[firstTblName].rows.map(r => prefixRow(r, firstTblAlias));

  // Apply each JOIN step
  for (const step of joinSteps) {
    const rightRows = DB[step.tblName].rows;
    const newRows = [];

    if (step.joinType === 'RIGHT') {
      // RIGHT JOIN: all right rows appear; NULLs for left side when no match.
      // Build a null-left prototype from the current accumulated column set.
      const nullLeft = {};
      if (rows.length > 0) {
        Object.keys(rows[0]).forEach(k => { nullLeft[k] = null; });
      }
      for (const rightRow of rightRows) {
        const prefixedRight = prefixRow(rightRow, step.alias);
        const matches = rows.filter(lr => {
          const combined = {...lr, ...prefixedRight};
          return evalOn(combined, step.onLeft, step.op, step.onRight);
        });
        if (matches.length > 0) {
          matches.forEach(lr => newRows.push({...lr, ...prefixedRight}));
        } else {
          newRows.push({...nullLeft, ...prefixedRight});
        }
      }
    } else if (step.crossNoOn) {
      // E2 fix: CROSS JOIN without ON — produce cartesian product
      for (const leftRow of rows) {
        for (const rr of rightRows) {
          newRows.push({...leftRow, ...prefixRow(rr, step.alias)});
        }
      }
    } else {
      // INNER JOIN / LEFT JOIN / CROSS JOIN with ON
      for (const leftRow of rows) {
        const matches = rightRows.filter(rr => {
          const combined = {...leftRow, ...prefixRow(rr, step.alias)};
          return evalOn(combined, step.onLeft, step.op, step.onRight);
        });
        if (matches.length > 0) {
          matches.forEach(rr => newRows.push({...leftRow, ...prefixRow(rr, step.alias)}));
        } else if (step.joinType === 'LEFT') {
          // LEFT JOIN: include left row with NULLs for right side
          const nullRight = {};
          DB[step.tblName].cols.forEach(c => { nullRight[step.alias+'.'+c.n] = null; nullRight[c.n] = null; });
          newRows.push({...leftRow, ...nullRight});
        }
        // INNER JOIN / CROSS JOIN: unmatched left rows are simply dropped
      }
    }

    rows = newRows;
  }

  // Apply WHERE filter
  if (where) {
    let whereErr = null;
    rows = rows.filter(r => {
      try { return evalWhereJoin(r, where); } catch(e) { whereErr = e; return false; }
    });
    if (whereErr) return err(`Ongeldige WHERE-conditie: ${esc(where)}. Controleer kolomnamen.`);
  }

  // Apply GROUP BY + aggregates + HAVING (ARCH-3+4: uses shared functions)
  if (grpBy) {
    const { gRows, colParts } = applyGroupBy(rows, grpBy, colStr, resolveCol);
    rows = applyHaving(gRows, having, colParts);
  } else {
    // Project columns (no GROUP BY) — uses shared splitColParts and evalCase
    if (colStr.trim() !== '*') {
      const colParts = splitColParts(colStr);
      rows = rows.map(r => {
        const o = {};
        colParts.forEach(p => {
          // CASE WHEN ... END [AS alias]
          const caseM = p.match(/^(CASE\s+.*?END)\s*(?:AS\s+(\w+))?$/i);
          if (caseM) { o[caseM[2] || 'case'] = evalCase(caseM[1], r); return; }
          const aliasM = p.match(/^(\S+)\s+as\s+(\w+)$/i);
          const ref = aliasM ? aliasM[1] : p;
          const alias = aliasM ? aliasM[2] : p.replace(/^\w+\./, '');
          o[alias] = resolveCol(ref, r) ?? resolveCol(ref.replace(/^\w+\./, ''), r);
        });
        return o;
      });
    }
  }

  // ORDER BY (multi-column)
  if (orderBy) applyMultiSort(rows, orderBy);

  // LIMIT
  if (limit) rows = rows.slice(0, limit);

  return {ok:true, type:'select', rows};
}

function doSingleSelect(sql) {
  // Quote-aware clause splitter: finds the LAST unquoted occurrence of each
  // clause keyword so that strings like WHERE naam = 'pending order' don't
  // trigger a false ORDER BY match. Aligned with doUpdate's scanning approach.
  let rest = sql;

  // Helper: find the last unquoted position of a keyword pattern (case-insensitive)
  function findLastUnquoted(str, kwRe) {
    let inStr = false, sc = '', last = -1;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (!inStr && (ch === "'" || ch === '"')) { inStr = true; sc = ch; continue; }
      if (inStr && ch === sc && str[i-1] !== '\\') { inStr = false; continue; }
      if (!inStr && kwRe.test(str.slice(i))) { last = i; }
    }
    return last;
  }

  // LIMIT
  let limit = null;
  const limIdx = findLastUnquoted(rest, /^limit\s+\d+\s*$/i);
  if (limIdx !== -1) {
    const limM = rest.slice(limIdx).match(/^limit\s+(\d+)\s*$/i);
    if (limM) { limit = Number(limM[1]); rest = rest.slice(0, limIdx).trim(); }
  }

  // ORDER BY
  let orderBy = null;
  const ordIdx = findLastUnquoted(rest, /^order\s+by\s+/i);
  if (ordIdx !== -1) {
    orderBy = rest.slice(ordIdx).replace(/^order\s+by\s+/i, '').trim();
    rest = rest.slice(0, ordIdx).trim();
  }

  // HAVING
  let having = null;
  const havIdx = findLastUnquoted(rest, /^having\s+/i);
  if (havIdx !== -1) {
    having = rest.slice(havIdx).replace(/^having\s+/i, '').trim();
    rest = rest.slice(0, havIdx).trim();
  }

  // GROUP BY
  let grpBy = null;
  const grpIdx = findLastUnquoted(rest, /^group\s+by\s+/i);
  if (grpIdx !== -1) {
    grpBy = rest.slice(grpIdx).replace(/^group\s+by\s+/i, '').trim();
    rest = rest.slice(0, grpIdx).trim();
  }

  // WHERE
  let where = null;
  const whereIdx = findLastUnquoted(rest, /^where\s+/i);
  if (whereIdx !== -1) {
    where = rest.slice(whereIdx).replace(/^where\s+/i, '').trim();
    rest = rest.slice(0, whereIdx).trim();
  }

  // SELECT … FROM table [alias]
  const selFromM = rest.match(/^select\s+(.*?)\s+from\s+(\w+)(?:\s+(?:as\s+)?(\w+))?\s*$/i);
  if (!selFromM) return err(stripSolution(t('js_eng_check_select_syntax')));
  let [, colStr, tbl] = selFromM;
  tbl=tbl.toLowerCase();
  if(!DB[tbl]) return err(ti('js_eng_table_not_found', {tbl: esc(tbl), available: Object.keys(DB).join(', ')}));
  let rows=[...DB[tbl].rows];
  if(where) {
    let whereErr = null;
    rows = rows.filter(r => { try { return evalWhere(r, where.trim()); } catch(e) { whereErr = e; return false; } });
    if (whereErr) return err(ti('js_eng_invalid_where', {clause: esc(where.trim())}));
  }

  // Multiple aggregates: SELECT MIN(x), MAX(x), AVG(x), SUM(x), COUNT(*), COUNT(DISTINCT x)
  const multiAggParts = colStr.match(/((?:AVG|SUM|MAX|MIN)\s*\(\s*\w+\s*\)|COUNT\s*\(\s*(?:DISTINCT\s+)?\w+|\*\s*\))/gi);
  if (multiAggParts && multiAggParts.length >= 1 && !grpBy) {
    const resultRow = {};
    for (const part of colStr.split(',')) {
      const p = part.trim();
      const cntDist = p.match(/^COUNT\s*\(\s*DISTINCT\s+(\w+)\s*\)$/i);
      if (cntDist) {
        const col = cntDist[1];
        const uniq = new Set(rows.map(r=>r[col]));
        resultRow['COUNT(DISTINCT '+col+')'] = uniq.size;
      } else {
        const agg = p.match(/^(AVG|SUM|MAX|MIN)\s*\(\s*(\w+)\s*\)$/i);
        if (agg) {
          const fn=agg[1].toUpperCase(), col=agg[2];
          const vals = rows.map(r=>Number(r[col])).filter(v=>!isNaN(v));
          let res;
          switch(fn) {
            case'AVG': res=vals.length?(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2):null; break;
            case'SUM': res=vals.reduce((a,b)=>a+b,0).toFixed(2); break;
            case'MAX': res=vals.length?Math.max(...vals):null; break;
            case'MIN': res=vals.length?Math.min(...vals):null; break;
          }
          resultRow[fn+'('+col+')'] = res;
        } else if (/count\s*\(\s*\*\s*\)/i.test(p)) {
          resultRow['COUNT(*)'] = rows.length;
        }
      }
    }
    if (Object.keys(resultRow).length > 0) return {ok:true,type:'select',rows:[resultRow]};
  }

  if(grpBy) {
    // ARCH-3+4: uses shared applyGroupBy + applyHaving
    const { gRows: _gRows, colParts } = applyGroupBy(rows, grpBy, colStr);
    let gRows = applyHaving(_gRows, having, colParts);
    if(orderBy) applyMultiSort(gRows, orderBy);
    if(limit) gRows=gRows.slice(0,Number(limit));
    return {ok:true,type:'select',rows:gRows};
  }
  if(/count\s*\(\s*\*\s*\)/i.test(colStr)){
    return {ok:true,type:'select',rows:[{'COUNT(*)':rows.length}]};
  }

  // DISTINCT support
  const distinctMatch = colStr.match(/^distinct\s+(.*)/i);
  if (distinctMatch) {
    colStr = distinctMatch[1];
    const cols2 = colStr.split(',').map(c=>c.trim().replace(/^\w+\./,''));
    rows = rows.map(r=>{const o={};cols2.forEach(c=>{if(r[c]!==undefined)o[c]=r[c];});return o;});
    const seen2 = new Set();
    rows = rows.filter(r=>{const k=JSON.stringify(r);if(seen2.has(k))return false;seen2.add(k);return true;});
    if(orderBy) applyMultiSort(rows, orderBy);
    if(limit) rows=rows.slice(0,Number(limit));
    return {ok:true,type:'select',rows,tbl};
  }

  // Parse columns with aliases and CASE WHEN support (uses shared splitColParts/evalCase)
  if (colStr.trim() !== '*') {
    const colParts = splitColParts(colStr);
    rows = rows.map(r => {
      const o = {};
      colParts.forEach(p => {
        // CASE WHEN ... END [AS alias]
        const caseM = p.match(/^(CASE\s+.*?END)\s*(?:AS\s+(\w+))?$/i);
        if (caseM) { o[caseM[2] || 'case'] = evalCase(caseM[1], r); return; }
        const aliasM = p.match(/^(\S+)\s+as\s+(\w+)$/i);
        const raw = aliasM ? aliasM[1].trim() : p.trim();
        const alias = aliasM ? aliasM[2] : null;
        const bare = raw.replace(/^\w+\./,'');
        const v = r[bare] !== undefined ? r[bare] : r[raw];
        o[alias || bare] = v;
      });
      return o;
    });
  }
  if(orderBy) applyMultiSort(rows, orderBy);
  if(limit) rows=rows.slice(0,Number(limit));
  return {ok:true,type:'select',rows,tbl};
}

function doJoin(sql) {
  // BUG-6 fix: added GROUP BY and HAVING support to implicit join handler.
  const m=sql.match(/select\s+(.*?)\s+from\s+([\w\s,]+?)(?:\s+where\s+(.+?))?(?:\s+group\s+by\s+([\w.,\s]+?))?(?:\s+having\s+(.+?))?(?:\s+order\s+by\s+(.+?))?(?:\s+limit\s+(\d+))?$/i);
  if(!m) return null;
  let[,colStr,tblStr,where,grpBy,having,orderBy,limit]=m;
  if (grpBy) grpBy = grpBy.trim();
  if (having) having = having.trim();
  const tbls=tblStr.split(',').map(tb=>{const p=tb.trim().split(/\s+/);return{name:p[0].toLowerCase(),alias:p[1]||p[0].toLowerCase()};});
  for(const tb of tbls) if(!DB[tb.name]) return null;
  let rows=DB[tbls[0].name].rows.map(r=>{const o={};Object.keys(r).forEach(k=>o[tbls[0].alias+'.'+k]=r[k]);return o;});
  for(let i=1;i<tbls.length;i++){const tb=tbls[i];const nr=[];rows.forEach(ex=>{DB[tb.name].rows.forEach(r=>{const c={...ex};Object.keys(r).forEach(k=>c[tb.alias+'.'+k]=r[k]);nr.push(c);});});rows=nr;}
  if(where) {
    let whereErr = null;
    rows = rows.filter(r => { try { return evalWhereJoin(r, where); } catch(e) { whereErr = e; return false; } });
    if (whereErr) return err(ti('js_eng_invalid_where_join', {clause: esc(where.trim())}));
  }

  // Resolve column ref in join context (alias.col or bare col)
  function resolveCol(ref, row) {
    if (row[ref] !== undefined) return row[ref];
    const bare = ref.replace(/^\w+\./, '');
    const key = Object.keys(row).find(k => k === bare || k.endsWith('.'+bare));
    return key !== undefined ? row[key] : undefined;
  }

  if (grpBy) {
    // ARCH-3+4: uses shared applyGroupBy + applyHaving
    const { gRows: _gRows, colParts } = applyGroupBy(rows, grpBy, colStr, resolveCol);
    let gRows = applyHaving(_gRows, having, colParts);
    if(orderBy) applyMultiSort(gRows, orderBy);
    if(limit) gRows=gRows.slice(0,Number(limit));
    return {ok:true,type:'select',rows:gRows};
  }

  let proj;
  if(colStr.trim()==='*'){proj=rows;}
  else{
    const cols=colStr.split(',').map(c=>{const[raw,al]=c.trim().split(/\s+as\s+/i);return{raw:raw.trim(),al:al||null};});
    proj=rows.map(r=>{const o={};cols.forEach(({raw,al})=>{let v=r[raw];if(v===undefined){const bare=raw.replace(/^\w+\./,'');const key=Object.keys(r).find(k=>k.endsWith('.'+bare));v=key?r[key]:undefined;}o[al||raw.replace(/^\w+\./,'')]=v;});return o;});
  }
  if(orderBy) applyMultiSort(proj, orderBy);
  if(limit) proj=proj.slice(0,Number(limit));
  return {ok:true,type:'select',rows:proj};
}

function doInsert(sql) {
  const m=sql.match(/insert\s+into\s+(\w+)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)/i);
  if(!m) return err(stripSolution(t('js_eng_insert_syntax')));
  const[,tbl,cs,vs]=m,tblData=DB[tbl.toLowerCase()];
  if(!tblData) return err(ti('js_eng_table_not_found', {tbl: esc(tbl), available: Object.keys(DB).join(', ')}));
  const cols=cs.split(',').map(c=>c.trim()),vals=parseVals(vs);
  if(cols.length!==vals.length) return err(ti('js_eng_col_count_mismatch', {cols: cols.length, vals: vals.length}));
  const pk=tblData.cols.find(c=>c.pk);
  const row={};if(pk) row[pk.n]=tblData.nid++;
  cols.forEach((c,i)=>row[c]=vals[i]);
  for(const col of tblData.cols.filter(c=>c.nn&&!c.pk)){if(row[col.n]===undefined||row[col.n]==='')return err(ti('js_eng_col_not_null', {col: esc(col.n)}));}
  for(const col of tblData.cols.filter(c=>c.uq)){if(tblData.rows.some(r=>r[col.n]===row[col.n]))return err(ti('js_eng_unique_exists', {val: esc(row[col.n]), col: esc(col.n)}));}
  // Fix 5: FK validation — warn (don't block) when a foreign key value has no match.
  // Educational: reinforces referential integrity concepts without preventing the INSERT.
  const fkWarnings = [];
  for (const col of tblData.cols.filter(c => c.fk)) {
    const val = row[col.n];
    if (val == null) continue;
    // Heuristic: col_name "xxx_id" → referenced table "xxx" with PK "xxx_id"
    const refTbl = col.n.replace(/_id$/, '');
    if (DB[refTbl]) {
      const refPk = DB[refTbl].cols.find(c => c.pk);
      if (refPk && !DB[refTbl].rows.some(r => r[refPk.n] === val)) {
        fkWarnings.push(ti('js_eng_fk_warning', {val: esc(val), col: esc(col.n), tbl: esc(refTbl)}));
      }
    }
  }
  tblData.rows.push(row);
  if (fkWarnings.length) fkWarnings.forEach(w => UI.addEvent('warn', w));
  UI.addEvent('ok', ti('js_eng_insert_event', {tbl: esc(tbl), id: row[pk?.n]||''}));
  UI.refreshUI();
  return {ok:true,type:'insert',affectedRows:1,rowId:row[pk?.n]};
}

function doUpdate(sql) {
  // Split on the last unquoted WHERE keyword.
  // The previous char-by-char scanner used a 5-char slice without a word boundary,
  // so a quoted string like 'no where to go' would match.
  // Now we skip over quoted strings explicitly and test the keyword with \b.
  let tblSetPart=sql, where=null;
  const whereIdx=(function(){
    let inStr=false,sc='',last=-1;
    for(let i=0;i<sql.length;i++){
      const ch=sql[i];
      if(!inStr&&(ch==="'"||ch==='"')){inStr=true;sc=ch;continue;}
      if(inStr&&ch===sc&&sql[i-1]!=='\\'){inStr=false;continue;}
      if(!inStr&&/^where\b/i.test(sql.slice(i))){last=i;}
    }
    return last;
  })();
  if(whereIdx!==-1){where=sql.slice(whereIdx+5).trim();tblSetPart=sql.slice(0,whereIdx).trim();}
  const m2=tblSetPart.match(/^update\s+(\w+)\s+set\s+(.*?)$/i);
  if(!m2) return err(stripSolution(t('js_eng_update_syntax')));
  const[,tbl,setStr]=m2,tblData=DB[tbl.toLowerCase()];
  if(!tblData) return err(ti('js_eng_table_not_found', {tbl: esc(tbl), available: Object.keys(DB).join(', ')}));
  if(!where) return err(t('js_eng_no_where_update'));
  // Parseer SET-toewijzingen — verwerkt ook geciteerde strings met komma's
  // en relatieve expressies zoals col = col + 10 of col = col - 1
  const set={};
  const assignRegex=/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^\s,]+(?:\s*[+\-\*\/]\s*[^\s,]+)?)/gi;
  let am;
  while((am=assignRegex.exec(setStr))!==null){
    const col=am[1], raw=am[2].replace(/^['"]|['"]$/g,'');
    // Detect relative expression: col = col +/- n  (e.g. stock = stock + 10)
    const relExpr=raw.match(/^(\w+)\s*([+\-\*\/])\s*([\d.]+)$/);
    if(relExpr && relExpr[1].toLowerCase()===col.toLowerCase()){
      set[col]={__expr:true,op:relExpr[2],val:Number(relExpr[3])};
    } else {
      set[col]=raw==='true'?1:raw==='false'?0:coerce(raw);
    }
  }
  if(!Object.keys(set).length) return err(t('js_eng_no_set'));
  // Dry-run the WHERE clause on the first row to surface syntax errors early,
  // before any rows are mutated. evalWhere errors were previously silently swallowed.
  let whereErr = null;
  try { evalWhere(tblData.rows[0] || {}, where.trim()); } catch(e) { whereErr = e; }
  if (whereErr) return err(ti('js_eng_invalid_where', {clause: esc(where.trim())}));
  let n=0;
  tblData.rows.forEach((r,i)=>{
    try{
      if(evalWhere(r,where.trim())){
        const resolved={};
        for(const[k,v] of Object.entries(set)){
          if(v&&v.__expr){
            const cur=Number(r[k])||0;
            switch(v.op){case'+':resolved[k]=cur+v.val;break;case'-':resolved[k]=cur-v.val;break;case'*':resolved[k]=cur*v.val;break;case'/':resolved[k]=v.val!==0?cur/v.val:cur;break;default:resolved[k]=cur;}
          } else { resolved[k]=v; }
        }
        Object.assign(tblData.rows[i],resolved);n++;
      }
    }catch(e){
      // Per-row evalWhere error after the dry-run passed: skip row and log to console.
      // This should not happen in practice; the dry-run above catches syntax errors.
      console.warn('[doUpdate] evalWhere error on row', i, e);
    }
  });
  UI.addEvent('warn', ti('js_eng_update_event', {tbl: esc(tbl), n: n}));
  UI.refreshUI();
  return {ok:true,type:'update',affectedRows:n};
}

function doDelete(sql) {
  const m=sql.match(/delete\s+from\s+(\w+)(?:\s+where\s+(.+))?$/i);
  if(!m) return err(stripSolution(t('js_eng_delete_syntax')));
  const[,tbl,where]=m,tblData=DB[tbl.toLowerCase()];
  if(!tblData) return err(ti('js_eng_table_not_found', {tbl: esc(tbl), available: Object.keys(DB).join(', ')}));
  if(!where) return err(t('js_eng_no_where_delete'));
  // Clone the row array before filtering so that a WHERE evaluation error
  // leaves the table fully intact (no partial deletes on first-error short-circuit).
  const snapshot = tblData.rows.slice();
  let delErr = null;
  const filtered = snapshot.filter(r => { try { return !evalWhere(r, where); } catch(e) { delErr = e; return false; } });
  if (delErr) return err(ti('js_eng_invalid_where_delete', {clause: esc(where.trim())}));
  tblData.rows = filtered;
  const before = snapshot.length;
  UI.addEvent('err', ti('js_eng_delete_event', {tbl: esc(tbl), n: before-tblData.rows.length}));
  UI.refreshUI();
  return {ok:true,type:'delete',affectedRows:before-tblData.rows.length};
}

function doCreate(sql) {
  const m=sql.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)\s*\(([^)]+)\)/i);
  if(!m) return err(t('js_eng_create_syntax'));
  const[,tbl,colDefs]=m,name=tbl.toLowerCase();
  if(DB[name]) return err(ti('js_eng_table_exists', {tbl: esc(tbl)}));
  const cols=colDefs.split(',').map(def=>{def=def.trim();const pts=def.split(/\s+/);const c={n:pts[0],t:pts[1]||'VARCHAR(100)'};if(/primary\s+key/i.test(def)){c.pk=true;c.ai=/auto_increment/i.test(def);}if(/not\s+null/i.test(def))c.nn=true;if(/unique/i.test(def))c.uq=true;return c;}).filter(c=>c.n&&!/^(primary|foreign|constraint|unique|index)/i.test(c.n));
  DB[name]={cols,rows:[],nid:1};
  UI.renderSchema();UI.renderDBTabs();
  UI.addEvent('info', ti('js_eng_create_event', {tbl: esc(tbl)}));
  return {ok:true,type:'ddl',msg: ti('js_eng_create_msg', {tbl: esc(tbl)})};
}

function doAlter(sql) {
  const m=sql.match(/alter\s+table\s+(\w+)\s+add\s+(?:column\s+)?(\w+)\s+(\S+)/i);
  if(!m) return err(stripSolution(t('js_eng_alter_syntax')));
  const[,tbl,col,type]=m,tblData=DB[tbl.toLowerCase()];
  if(!tblData) return err(ti('js_eng_table_not_found', {tbl: esc(tbl), available: Object.keys(DB).join(', ')}));
  if(tblData.cols.find(c=>c.n===col)) return err(ti('js_eng_col_exists', {col: esc(col)}));
  tblData.cols.push({n:col,t:type});tblData.rows.forEach(r=>r[col]=null);
  UI.renderSchema();UI.renderCurrentTable();
  UI.addEvent('info', ti('js_eng_alter_event', {col: esc(col)}));
  return {ok:true,type:'ddl',msg: ti('js_eng_alter_msg', {col: esc(col), type: esc(type)})};
}

// ── TABLE RENDERER ────────────────────────────────────────────────
function renderTableHTML(name) {
  const tblData=DB[name];
  if(!tblData) return `<div class="table-not-found">${ti('js_eng_table_not_found_render', {tbl: esc(name)})}</div>`;
  const hdrs=tblData.cols.map(c=>`<th>
    ${c.pk?'<span class="schema-pk-badge">PK</span>':''}
    ${c.fk?'<span class="schema-fk-badge">FK</span>':''}
    ${esc(c.n)} <span class="schema-col-type">${esc(c.t)}</span>
  </th>`).join('');
  const body=tblData.rows.map(r=>`<tr>${tblData.cols.map(c=>`<td class="${c.pk?'pk':c.fk?'fk':''}">${r[c.n]==null?'<span class="u-muted">NULL</span>':esc(String(r[c.n]))}</td>`).join('')}</tr>`).join('');
  return `<div class="tv-header"><span class="tv-name">${esc(name)}</span><span class="tv-badge">${tblData.rows.length} rijen</span></div>
    <div class="tv-scroll"><table class="data-table"><thead><tr>${hdrs}</tr></thead><tbody>${body}</tbody></table></div>`;
}
// ── END datashop-engine.js ──
// Continues in datashop-data.js → datashop-ui.js

// ── ES MODULE EXPORTS (for testing — disabled in browser context) ──
// export { sqlLikeMatch, evalWhere, evalWhereJoin, runSQL, resetDB, DB, DB_INITIAL, esc, clamp, coerce, splitTop, parseVals, stripSolution };

