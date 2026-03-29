// ── campaign.js ──
// Campaign mode: story-driven SQL quests with a continuous narrative.
// COMPLETELY SEPARATE from all other modes — own CSS, own state, own components.
// Depends on: datashop-engine.js (for runSQL, esc, sanitizeHTML, t, DB, G, UI, save, LANG)
//
// DEFENSIVE: All entry points are wrapped in try-catch so a campaign bug
// can never crash the core game.

"use strict";

// ══════════════════════════════════════════════════════════════════
//  CAMPAIGN CSS — Injected at runtime, fully isolated with camp- prefix
// ══════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════
//  CAMPAIGN DATA
// ══════════════════════════════════════════════════════════════════
var CAMPAIGN_QUESTS = [
  {
    id: 'camp_1',
    chapter: 1,
    title: { nl: 'De Eerste Klant', en: 'The First Customer' },
    story: {
      nl: 'Je webshop is net gelanceerd. <strong>Emma De Vries</strong> uit <strong>Brussel</strong> wil zich registreren. Haar email is <strong>emma@mail.be</strong>. Voeg haar toe als actieve klant!',
      en: 'Your webshop just launched. <strong>Emma De Vries</strong> from <strong>Brussels</strong> wants to register. Her email is <strong>emma@mail.be</strong>. Add her as an active customer!'
    },
    objective: {
      nl: "INSERT INTO klant (naam, email, stad, actief) VALUES ('Emma De Vries', 'emma@mail.be', 'Brussel', 1)",
      en: "INSERT INTO klant (naam, email, stad, actief) VALUES ('Emma De Vries', 'emma@mail.be', 'Brussel', 1)"
    },
    sqlType: 'insert',
    check: 'INSERT INTO klant',
    mustContain: ['insert into klant', 'emma@mail.be', 'emma de vries'],
    xp: 15,
    unlock: 0,
    time: 240,
  },
  {
    id: 'camp_2',
    chapter: 1,
    title: { nl: 'Inventaris Controle', en: 'Inventory Check' },
    story: {
      nl: 'De eerste orders stromen binnen! Voordat je verder gaat, moet je weten welke producten je verkoopt. <strong>Toon alle producten</strong> met hun naam en prijs.',
      en: 'First orders are coming in! Before continuing, check which products you sell. <strong>Show all products</strong> with their name and price.'
    },
    objective: { nl: 'SELECT naam, prijs FROM product', en: 'SELECT naam, prijs FROM product' },
    sqlType: 'select',
    check: 'SELECT',
    xp: 10,
    unlock: 1,
    time: 180,
  },
  {
    id: 'camp_3',
    chapter: 1,
    title: { nl: 'Prijzenslag', en: 'Price War' },
    story: {
      nl: 'Een concurrent verlaagt zijn prijzen! Je moet de prijs van het product met <strong>product_id = 3</strong> verlagen naar <strong>€19.99</strong> om competitief te blijven.',
      en: 'A competitor is cutting prices! You need to lower the price of the product with <strong>product_id = 3</strong> to <strong>€19.99</strong> to stay competitive.'
    },
    objective: {
      nl: 'UPDATE product SET prijs = 19.99 WHERE product_id = 3',
      en: 'UPDATE product SET prijs = 19.99 WHERE product_id = 3'
    },
    sqlType: 'update',
    check: 'UPDATE product SET',
    mustContain: ['update product', 'prijs', '19.99', 'product_id'],
    xp: 20,
    unlock: 2,
    time: 180,
  },
  {
    id: 'camp_4',
    chapter: 2,
    title: { nl: 'Klantanalyse', en: 'Customer Analysis' },
    story: {
      nl: 'Het marketingteam wil weten hoeveel klanten er per stad zijn. <strong>Groepeer de klanten op stad</strong> en tel ze.',
      en: 'The marketing team wants to know how many customers there are per city. <strong>Group customers by city</strong> and count them.'
    },
    objective: {
      nl: 'SELECT stad, COUNT(*) FROM klant GROUP BY stad',
      en: 'SELECT stad, COUNT(*) FROM klant GROUP BY stad'
    },
    sqlType: 'select',
    check: 'GROUP BY',
    xp: 25,
    unlock: 3,
    time: 240,
  },
  {
    id: 'camp_5',
    chapter: 2,
    title: { nl: 'Bestellingen Koppelen', en: 'Linking Orders' },
    story: {
      nl: 'De CEO wil een overzicht: welke <strong>klant</strong> heeft welke <strong>bestelling</strong> geplaatst? Gebruik een <strong>JOIN</strong> om klant- en bestellingtabellen te koppelen.',
      en: 'The CEO wants an overview: which <strong>customer</strong> placed which <strong>order</strong>? Use a <strong>JOIN</strong> to link the customer and order tables.'
    },
    objective: {
      nl: 'SELECT k.naam, b.bestelling_id FROM klant k JOIN bestelling b ON k.klant_id = b.klant_id',
      en: 'SELECT k.naam, b.bestelling_id FROM klant k JOIN bestelling b ON k.klant_id = b.klant_id'
    },
    sqlType: 'select',
    check: 'JOIN',
    xp: 30,
    unlock: 4,
    time: 300,
  },
];

// Campaign quests are registered into the global SC_BY_* indexes inside
// CAMP.init() so that LANG is already set to the stored preference by then.
// (Previously this ran as a top-level IIFE, which always used the default
// 'nl' language regardless of what the user had stored in localStorage.)


// ══════════════════════════════════════════════════════════════════
//  CAMPAIGN STATE
// ══════════════════════════════════════════════════════════════════
var CAMP = {
  doneQuests: new Set(),
  _timers: {},
  _timerRemaining: {},
  _timerPaused: {},
  _TIMER_LS_KEY: 'datashop_camp_timer',
  _questsRegistered: false,   // guard against double-registration on repeated init() calls
  _registeredLang: null,      // LANG value at last registration — triggers re-register on lang switch

  // ─── REGISTER INTO GLOBAL INDEXES ─────────────────────────────
  // Called once from init(), after LANG has been restored from localStorage
  // by init-lang.js.  Running this at parse time (as the old IIFE did) always
  // used the default 'nl' language, so English users got Dutch titles indexed.
  // Re-runs automatically if the user switches language mid-session.
  _registerQuests: function() {
    var lang = (typeof LANG !== 'undefined') ? LANG : 'nl';
    // Skip if already registered for this language
    if (this._questsRegistered && this._registeredLang === lang) return;
    if (typeof indexScenario !== 'function') return;
    // Fix 6: On re-registration (language switch), remove old campaign entries from
    // SC_BY_CH and SC_BY_TYPE arrays to prevent duplicate entries accumulating.
    if (this._questsRegistered) {
      var campaignIds = {};
      CAMPAIGN_QUESTS.forEach(function(q) { campaignIds[q.id] = true; });
      var filterOut = function(arr) { return arr.filter(function(s) { return !campaignIds[s.id]; }); };
      if (typeof SC_BY_CH !== 'undefined') {
        Object.keys(SC_BY_CH).forEach(function(ch) { SC_BY_CH[ch] = filterOut(SC_BY_CH[ch]); });
      }
      if (typeof SC_BY_TYPE !== 'undefined') {
        Object.keys(SC_BY_TYPE).forEach(function(tp) { SC_BY_TYPE[tp] = filterOut(SC_BY_TYPE[tp]); });
      }
    }
    CAMPAIGN_QUESTS.forEach(function(q) {
      indexScenario({
        id:      q.id,
        ch:      q.chapter,
        title:   (q.title && (q.title[lang] || q.title.nl)) || q.id,
        sqlType: q.sqlType || 'select',
        xp:      q.xp || 0,
        time:    q.time || null,
        _isCampaignQuest: true
      });
    });
    this._questsRegistered = true;
    this._registeredLang = lang;
  },

  // ─── PERSIST TIMER STATE ───────────────────────────────────────
  // Mirrors the datashop-ui.js pattern so a full tab close + reopen
  // restores the remaining time instead of silently losing it.
  _saveTimerState: function() {
    try {
      localStorage.setItem(this._TIMER_LS_KEY, JSON.stringify(this._timerPaused));
    } catch(e) {}
  },

  _restoreTimerState: function() {
    try {
      var raw = localStorage.getItem(this._TIMER_LS_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      var self = this;
      Object.keys(saved).forEach(function(id) {
        var left = saved[id];
        if (typeof left === 'number' && left > 0) self._timerPaused[id] = left;
      });
      localStorage.removeItem(this._TIMER_LS_KEY);
    } catch(e) {}
  },

  init: function() {
    try {
      var saved = localStorage.getItem('datashop_campaign');
      if (saved) {
        var data = JSON.parse(saved);
        if (data && data.done && Array.isArray(data.done)) {
          this.doneQuests = new Set(data.done);
        }
      }
    } catch (e) {
      console.warn('Campaign: could not load saved progress', e);
    }
    // Register quest titles into SC_BY_* indexes using the now-correct LANG value.
    this._registerQuests();
    // Restore any timer state that was persisted when the tab was closed.
    // Timers will resume when the quest is next opened (toggleQuest checks
    // _timerPaused and calls _startTimer with the remaining seconds).
    this._restoreTimerState();
  },

  save: function() {
    try {
      localStorage.setItem('datashop_campaign', JSON.stringify({
        done: Array.from(this.doneQuests)
      }));
    } catch (e) { /* ignore */ }
  },

  isUnlocked: function(quest) {
    if (!quest) return false;
    return this.doneQuests.size >= quest.unlock;
  },

  // ─── RENDER ────────────────────────────────────────────────────
  render: function() {
    try { this._renderInner(); }
    catch (e) { console.warn('Campaign render error:', e); }
  },

  _renderInner: function() {
    var content = document.getElementById('camp-content');
    if (!content) return;

    var lang = (typeof LANG !== 'undefined') ? LANG : 'nl';
    var done = this.doneQuests.size;
    var total = CAMPAIGN_QUESTS.length;
    var pct = total ? Math.round(done / total * 100) : 0;
    var self = this;
    var escFn = (typeof esc === 'function') ? esc : function(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
    var sanitizeFn = (typeof sanitizeHTML === 'function') ? sanitizeHTML : escFn;

    var html = '';

    // ── Header
    html += '<div class="camp-header">';
    html += '<div class="camp-header-left">';
    html += '<span class="camp-header-icon">⚔️</span>';
    html += '<div>';
    html += '<div class="camp-header-title">Campaign</div>';
    html += '<div class="camp-header-sub">DataShop CEO · Story Quests</div>';
    html += '</div></div>';
    html += '<div class="camp-xp-badge">⭐ ' + (typeof G !== 'undefined' && G ? (G.xp || 0) : 0) + ' XP</div>';
    html += '</div>';

    // ── Progress bar
    html += '<div class="camp-progress-wrap">';
    html += '<div class="camp-progress-meta">';
    html += '<span class="camp-progress-label">' + (typeof t === 'function' ? t('js_camp_progress_label') || 'Campaign Voortgang' : 'Campaign Voortgang') + '</span>';
    html += '<span class="camp-progress-val">' + done + '/' + total + ' · ' + pct + '%</span>';
    html += '</div>';
    html += '<div class="camp-progress-track">';
    html += '<div class="camp-progress-fill" data-w="' + pct + '"></div>';
    html += '</div></div>';

    // ── All done banner
    if (done === total && total > 0) {
      html += '<div class="camp-complete">';
      html += '<div class="camp-complete-trophy">🏆</div>';
      html += '<div class="camp-complete-title">' + (lang === 'nl' ? 'Campaign Voltooid!' : 'Campaign Complete!') + '</div>';
      html += '<div class="camp-complete-sub">' + (lang === 'nl'
        ? 'Je hebt alle ' + total + ' quests afgerond!'
        : 'You completed all ' + total + ' quests!') + '</div>';
      html += '<button class="camp-reset-btn" data-action="camp-reset">↻ ' + (lang === 'nl' ? 'Opnieuw beginnen' : 'Start Over') + '</button>';
      html += '</div>';
    }

    // ── No quests
    if (!CAMPAIGN_QUESTS.length) {
      html += '<div class="camp-empty">' + (typeof t === 'function' ? t('camp_no_quests') : 'Geen quests beschikbaar.') + '</div>';
      content.innerHTML = html;
      applyBarWidths(content);
      return;
    }

    // ── Group by chapter
    var chapters = {};
    CAMPAIGN_QUESTS.forEach(function(q) {
      if (!chapters[q.chapter]) chapters[q.chapter] = [];
      chapters[q.chapter].push(q);
    });

    // ── Render chapters
    Object.entries(chapters).forEach(function(entry) {
      var ch = entry[0];
      var quests = entry[1];
      var chDone = quests.filter(function(q) { return self.doneQuests.has(q.id); }).length;
      var allChDone = chDone === quests.length;

      html += '<div class="camp-chapter">';

      // Chapter header
      html += '<div class="camp-chapter-header">';
      html += '<div class="camp-chapter-num' + (allChDone ? ' done' : '') + '">' + ch + '</div>';
      html += '<div>';
      html += '<div class="camp-chapter-label">' + (lang === 'nl' ? 'Hoofdstuk' : 'Chapter') + ' ' + ch + '</div>';
      html += '<div class="camp-chapter-count">' + chDone + '/' + quests.length + ' ' + (lang === 'nl' ? 'voltooid' : 'completed') + (allChDone ? ' ✓' : '') + '</div>';
      html += '</div>';
      html += '<div class="camp-chapter-dots">';
      quests.forEach(function(q) {
        var dotClass = self.doneQuests.has(q.id) ? 'done' : self.isUnlocked(q) ? 'unlocked' : '';
        html += '<div class="camp-chapter-dot ' + dotClass + '"></div>';
      });
      html += '</div></div>';

      // Quest list
      html += '<div class="camp-quest-list">';
      quests.forEach(function(q) {
        var isDone = self.doneQuests.has(q.id);
        var unlocked = self.isUnlocked(q);
        var title = (q.title && q.title[lang]) || (q.title && q.title.nl) || q.id;
        var story = (q.story && q.story[lang]) || (q.story && q.story.nl) || '';
        var obj = (q.objective && q.objective[lang]) || (q.objective && q.objective.nl) || '';

        var questClass = 'camp-quest';
        if (isDone) questClass += ' camp-quest--done';
        else if (!unlocked) questClass += ' camp-quest--locked';

        html += '<div class="' + questClass + '" id="camp-' + q.id + '">';

        // Header
        html += '<div class="camp-quest-head" data-action="toggle-camp-quest" data-quest="' + q.id + '">';
        html += '<span class="camp-quest-icon">' + (isDone ? '✅' : unlocked ? '⚔️' : '🔒') + '</span>';
        html += '<div class="camp-quest-info">';
        html += '<div class="camp-quest-title">' + escFn(title) + '</div>';
        html += '<div class="camp-quest-tags">';
        html += '<span class="camp-tag camp-tag--' + q.sqlType + '">' + q.sqlType.toUpperCase() + '</span>';
        html += '<span class="camp-tag camp-tag--xp">+' + q.xp + ' XP</span>';
        if (q.time) html += '<span class="camp-tag camp-tag--time">⏱ ' + q.time + 's</span>';
        html += '</div></div>';
        html += '<span class="camp-quest-chevron" id="camp-chev-' + q.id + '">▸</span>';
        html += '</div>';

        // Body
        html += '<div class="camp-quest-body" id="camp-body-' + q.id + '">';
        html += '<div class="camp-story">' + sanitizeFn(story) + '</div>';
        html += '<div class="camp-objective"><strong>' + (lang === 'nl' ? 'Doel:' : 'Goal:') + '</strong> <code>' + escFn(obj) + '</code></div>';

        if (!isDone && unlocked) {
          // Timer
          html += '<div class="camp-timer" id="camp-timer-' + q.id + '">';
          html += '<div class="camp-timer-track"><div class="camp-timer-fill" id="camp-tb-' + q.id + '"></div></div>';
          html += '<div class="camp-timer-num" id="camp-tn-' + q.id + '"></div>';
          html += '</div>';
          // SQL input
          html += '<div class="camp-sql-area">';
          html += '<div class="camp-sql-wrap">';
          html += '<textarea class="camp-sql-input" id="camp-sql-' + q.id + '" placeholder="' + (lang === 'nl' ? 'Schrijf je SQL hier...' : 'Write your SQL here...') + '" spellcheck="false"></textarea>';
          html += '<div class="camp-sql-hint">Ctrl+Enter</div>';
          html += '</div>';
          html += '<button class="camp-run-btn" data-action="camp-run" data-quest="' + q.id + '">▶ Run</button>';
          html += '</div>';
          // Feedback area
          html += '<div id="camp-fb-' + q.id + '"></div>';
        } else if (isDone) {
          html += '<div class="camp-fb camp-fb--ok">✅ ' + (lang === 'nl' ? 'Quest voltooid!' : 'Quest completed!') + ' +' + q.xp + ' XP</div>';
        } else {
          html += '<div class="camp-fb camp-fb--hint">🔒 ' + (lang === 'nl' ? 'Voltooi eerdere quests om te ontgrendelen.' : 'Complete previous quests to unlock.') + '</div>';
        }

        html += '</div>'; // body
        html += '</div>'; // quest
      });
      html += '</div>'; // quest-list
      html += '</div>'; // chapter
    });

    content.innerHTML = html;
    applyBarWidths(content);

    // Attach Ctrl+Enter handlers to textareas
    CAMPAIGN_QUESTS.forEach(function(q) {
      var ta = document.getElementById('camp-sql-' + q.id);
      if (ta) {
        ta.addEventListener('keydown', function(e) {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            self.runQuest(q.id);
          }
        });
      }
    });
  },

  // ─── TOGGLE QUEST ──────────────────────────────────────────────
  toggleQuest: function(id) {
    try { this._toggleQuestInner(id); }
    catch (e) { console.warn('Campaign toggleQuest error:', e); }
  },

  _toggleQuestInner: function(id) {
    var body = document.getElementById('camp-body-' + id);
    var chev = document.getElementById('camp-chev-' + id);
    var card = document.getElementById('camp-' + id);
    if (!body) return;
    var wasOpen = body.classList.contains('open');

    // Close all
    var campContent = document.getElementById('camp-content');
    if (campContent) {
      campContent.querySelectorAll('.camp-quest-body').forEach(function(b) { b.classList.remove('open'); });
      campContent.querySelectorAll('.camp-quest-chevron').forEach(function(c) { c.classList.remove('open'); });
      campContent.querySelectorAll('.camp-quest').forEach(function(q) { q.classList.remove('camp-quest--active'); });
    }

    // Clear timer
    this._clearTimer(id);

    if (!wasOpen) {
      body.classList.add('open');
      if (chev) chev.classList.add('open');
      if (card) card.classList.add('camp-quest--active');

      var quest = CAMPAIGN_QUESTS.find(function(q) { return q.id === id; });
      if (quest && quest.time && !this.doneQuests.has(id) && this.isUnlocked(quest)) {
        // Use persisted remaining time if available (restored from localStorage after
        // a tab close), otherwise start from the quest's full time allocation.
        var resumeSecs = (this._timerPaused && this._timerPaused[id]) || quest.time;
        if (this._timerPaused) delete this._timerPaused[id];
        this._startTimer(id, resumeSecs);
      }
    }
  },

  // ─── TIMER ─────────────────────────────────────────────────────
  _clearTimer: function(id) {
    if (this._timers[id]) {
      cancelAnimationFrame(this._timers[id]);
      delete this._timers[id];
    }
    if (this._timerRemaining) delete this._timerRemaining[id];
  },

  _startTimer: function(id, secs) {
    this._clearTimer(id);
    var self = this;
    self._timerRemaining[id] = secs;
    var end = Date.now() + secs * 1000;

    function tick() {
      var left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      self._timerRemaining[id] = left;
      var numEl = document.getElementById('camp-tn-' + id);
      var barEl = document.getElementById('camp-tb-' + id);
      if (numEl) {
        numEl.textContent = left + 's';
        numEl.className = 'camp-timer-num' + (left <= 10 ? ' danger' : left <= 20 ? ' warn' : '');
      }
      if (barEl) {
        barEl.style.width = (left / secs * 100) + '%';
        barEl.className = 'camp-timer-fill' + (left <= 10 ? ' danger' : left <= 20 ? ' warn' : '');
      }
      if (left <= 0) {
        self._clearTimer(id);
        var fb = document.getElementById('camp-fb-' + id);
        if (fb) {
          fb.className = 'camp-fb camp-fb--timeout';
          fb.innerHTML = '⏰ <strong>' + (typeof t === 'function' ? t('js_camp_timeout') || 'Tijd voorbij!' : 'Tijd voorbij!') + '</strong> ' +
            (typeof t === 'function' ? t('js_camp_timeout_retry') || 'Probeer opnieuw.' : 'Probeer opnieuw.');
        }
        return;
      }
      self._timers[id] = requestAnimationFrame(tick);
    }
    self._timers[id] = requestAnimationFrame(tick);
  },

  // ─── RUN QUEST ─────────────────────────────────────────────────
  runQuest: function(id) {
    try { this._runQuestInner(id); }
    catch (e) {
      console.warn('Campaign runQuest error:', e);
      var fb = document.getElementById('camp-fb-' + id);
      if (fb) {
        fb.className = 'camp-fb camp-fb--err';
        fb.innerHTML = '⚠️ Er ging iets mis. Probeer opnieuw.';
      }
    }
  },

  _runQuestInner: function(id) {
    var quest = CAMPAIGN_QUESTS.find(function(q) { return q.id === id; });
    if (!quest || this.doneQuests.has(id) || !this.isUnlocked(quest)) return;

    var ta = document.getElementById('camp-sql-' + id);
    var fb = document.getElementById('camp-fb-' + id);
    if (!ta || !fb) return;

    var sql = ta.value.trim();
    if (!sql) {
      fb.className = 'camp-fb camp-fb--err';
      fb.innerHTML = '⚠️ ' + (typeof t === 'function' ? t('js_camp_enter_sql') || 'Voer een SQL-query in.' : 'Voer een SQL-query in.');
      return;
    }

    if (typeof runSQL !== 'function') {
      fb.className = 'camp-fb camp-fb--err';
      fb.innerHTML = '⚠️ SQL engine niet beschikbaar.';
      return;
    }

    var res = runSQL(sql);
    if (!res || !res.ok) {
      fb.className = 'camp-fb camp-fb--err';
      var escFn = (typeof esc === 'function') ? esc : function(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
      fb.innerHTML = '❌ ' + escFn((res && res.msg) || 'SQL fout.');
      return;
    }

    // Validate result
    var validated = this._validateQuestResult(quest, sql, res);
    if (!validated) {
      fb.className = 'camp-fb camp-fb--hint';
      fb.innerHTML = '🤔 ' + (typeof t === 'function' ? t('js_camp_close_but_wrong') || 'Bijna goed! Controleer je waarden.' : 'Bijna goed! Controleer je waarden.');
      return;
    }

    // Keyword check — single required string (legacy)
    var normalSql = sql.toLowerCase().replace(/\s+/g, ' ');
    var checkStr = (quest.check || '').toLowerCase();
    if (checkStr && !normalSql.includes(checkStr)) {
      fb.className = 'camp-fb camp-fb--hint';
      fb.innerHTML = '🤔 ' + (typeof t === 'function' ? t('js_camp_wrong_query') || 'Dit is niet wat de opdracht vraagt.' : 'Dit is niet wat de opdracht vraagt.');
      return;
    }

    // mustContain check — array of required SQL fragments (e.g. ['INSERT INTO klant', 'emma@mail.be'])
    // Allows quest authors to verify both the operation AND specific values without relying
    // solely on DB-state inspection, which can be satisfied by unintended mutations.
    if (Array.isArray(quest.mustContain)) {
      var missingFragment = null;
      for (var mi = 0; mi < quest.mustContain.length; mi++) {
        if (!normalSql.includes(quest.mustContain[mi].toLowerCase())) {
          missingFragment = quest.mustContain[mi];
          break;
        }
      }
      if (missingFragment) {
        fb.className = 'camp-fb camp-fb--hint';
        fb.innerHTML = '🤔 ' + (typeof t === 'function' ? t('js_camp_wrong_query') || 'Dit is niet wat de opdracht vraagt.' : 'Dit is niet wat de opdracht vraagt.');
        return;
      }
    }

    // ── Success! ──
    this.doneQuests.add(id);
    this.save();
    this._clearTimer(id);

    if (typeof G !== 'undefined' && G !== null) {
      G.xp = (G.xp || 0) + (quest.xp || 0);
      if (typeof UI !== 'undefined' && UI !== null) {
        if (typeof UI.updateXP === 'function') {
          try { UI.updateXP(); } catch(e) { console.warn('Campaign: UI.updateXP error', e); }
        }
        if (typeof UI.xpPop === 'function') {
          try { UI.xpPop('+' + (quest.xp || 0) + ' XP'); } catch(e) { /* ignore */ }
        }
        if (typeof UI.addEvent === 'function') {
          try {
            var escFn2 = (typeof esc === 'function') ? esc : function(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
            var lang = (typeof LANG !== 'undefined') ? LANG : 'nl';
            var titleStr = (quest.title && quest.title[lang]) || (quest.title && quest.title.nl) || quest.id;
            UI.addEvent('ok', '⚔️ Campaign quest voltooid: <strong>' + escFn2(titleStr) + '</strong>', true);
          } catch(e) { /* ignore */ }
        }
      }
      if (typeof save === 'function') {
        try { save(); } catch(e) { /* ignore */ }
      }
    }

    fb.className = 'camp-fb camp-fb--ok';
    fb.innerHTML = '✅ ' + (typeof t === 'function' ? t('js_camp_quest_done') || 'Quest voltooid!' : 'Quest voltooid!') + ' +' + (quest.xp || 0) + ' XP';

    // Re-render after delay
    var self = this;
    setTimeout(function() {
      try { self.render(); } catch(e) { /* ignore */ }
    }, 1500);
  },

  // ─── RESULT VALIDATION ─────────────────────────────────────────
  _validateQuestResult: function(quest, sql, res) {
    var lang = (typeof LANG !== 'undefined') ? LANG : 'nl';
    var objective = (quest.objective && quest.objective[lang]) || (quest.objective && quest.objective.nl) || '';
    if (!objective) return true;

    var normalObj = objective.toLowerCase().replace(/\s+/g, ' ').trim();

    switch (quest.sqlType) {
      case 'insert': {
        var insertM = normalObj.match(/insert\s+into\s+(\w+)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)/i);
        if (!insertM) return true;
        var tbl = insertM[1].toLowerCase();
        var cols = insertM[2].split(',').map(function(c) { return c.trim(); });
        var vals = insertM[3].split(',').map(function(v) { return v.trim().replace(/^'|'$/g, ''); });
        if (typeof DB === 'undefined' || !DB[tbl]) return true;
        return DB[tbl].rows.some(function(row) {
          return cols.every(function(col, i) {
            var expected = vals[i];
            var actual = row[col];
            if (actual == null) return false;
            if (!isNaN(Number(expected)) && !isNaN(Number(actual))) return Number(actual) === Number(expected);
            return String(actual).toLowerCase() === expected.toLowerCase();
          });
        });
      }
      case 'update': {
        var updateM = normalObj.match(/update\s+(\w+)\s+set\s+(.*?)\s+where\s+(.*)/i);
        if (!updateM) return true;
        var tbl2 = updateM[1].toLowerCase();
        if (typeof DB === 'undefined' || !DB[tbl2]) return true;
        var assignments = {};
        var setRe = /(\w+)\s*=\s*('(?:[^']*)'|[\d.]+)/g;
        var sm;
        while ((sm = setRe.exec(updateM[2])) !== null) {
          assignments[sm[1]] = sm[2].replace(/^'|'$/g, '');
        }
        return DB[tbl2].rows.some(function(row) {
          return Object.keys(assignments).every(function(col) {
            var expected = assignments[col];
            var actual = row[col];
            if (actual == null) return false;
            if (!isNaN(Number(expected)) && !isNaN(Number(actual))) return Number(actual) === Number(expected);
            return String(actual).toLowerCase() === expected.toLowerCase();
          });
        });
      }
      case 'delete': {
        var deleteM = normalObj.match(/delete\s+from\s+(\w+)\s+where\s+(.*)/i);
        if (!deleteM) return true;
        var tbl3 = deleteM[1].toLowerCase();
        if (typeof DB === 'undefined' || !DB[tbl3]) return true;
        var whereCol = deleteM[2].match(/(\w+)\s*=\s*('(?:[^']*)'|[\d.]+)/);
        if (!whereCol) return true;
        var col3 = whereCol[1];
        var val3 = whereCol[2].replace(/^'|'$/g, '');
        return !DB[tbl3].rows.some(function(row) {
          var actual = row[col3];
          if (!isNaN(Number(val3))) return Number(actual) === Number(val3);
          return String(actual || '').toLowerCase() === val3.toLowerCase();
        });
      }
      case 'select': {
        if (typeof runSQL !== 'function') return true;
        try {
          // Snapshot the expected result the first time this quest is validated.
          // Re-running the objective SQL on every attempt means the expected set
          // drifts when earlier quests have mutated the DB (e.g. camp_1 INSERTs
          // a new klant row, which changes COUNT(*) results for later SELECTs).
          // Storing the snapshot on the quest object is safe because CAMPAIGN_QUESTS
          // is module-private and the snapshot is deterministic for the initial DB.
          if (!quest._expectedRows) {
            var snapRes = runSQL(objective);  // objective is already lang-resolved above
            if (!snapRes || !snapRes.ok || !snapRes.rows) return true;
            quest._expectedRows = snapRes.rows;
          }
          var expectedRows = quest._expectedRows;
          if (!res || !res.ok || !res.rows) return true;
          if (expectedRows.length !== res.rows.length) return false;
          if (expectedRows.length > 0 && res.rows.length > 0) {
            var expectedCols = Object.keys(expectedRows[0]).sort();
            var actualCols = Object.keys(res.rows[0]).sort();
            if (expectedCols.join(',') !== actualCols.join(',')) return false;
            for (var i = 0; i < expectedRows.length; i++) {
              for (var j = 0; j < expectedCols.length; j++) {
                var ek = expectedCols[j];
                if (String(expectedRows[i][ek]) !== String(res.rows[i][ek])) return false;
              }
            }
          }
          return true;
        } catch (e) { return true; }
      }
      default: return true;
    }
  },

  // ─── RESET ─────────────────────────────────────────────────────
  reset: function() {
    this.doneQuests = new Set();
    // Clear SELECT snapshots so they are re-taken against the freshly reset DB.
    CAMPAIGN_QUESTS.forEach(function(q) { delete q._expectedRows; });
    // Force re-registration so quest index is rebuilt cleanly after reset.
    this._questsRegistered = false;
    this._registeredLang = null;
    this.save();
    this.render();
  },
};


// ══════════════════════════════════════════════════════════════════
//  TIMER PAUSE ON TAB SWITCH
//  On hide: cancel RAF loops and persist remaining time to localStorage
//  so a full tab close + reopen can still resume the correct countdown.
//  On show: restore from localStorage (if any) then restart timers.
// ══════════════════════════════════════════════════════════════════
document.addEventListener('visibilitychange', function() {
  if (!CAMP._timers) return;
  if (document.hidden) {
    if (!CAMP._timerPaused) CAMP._timerPaused = {};
    Object.keys(CAMP._timers).forEach(function(id) {
      var remaining = (CAMP._timerRemaining && CAMP._timerRemaining[id]) || 0;
      CAMP._timerPaused[id] = remaining;
      cancelAnimationFrame(CAMP._timers[id]);
      delete CAMP._timers[id];
    });
    CAMP._saveTimerState();   // persist — survives a full tab close
  } else {
    CAMP._restoreTimerState();  // pick up state from a previous session if needed
    if (!CAMP._timerPaused) return;
    Object.keys(CAMP._timerPaused).forEach(function(id) {
      var left = CAMP._timerPaused[id];
      delete CAMP._timerPaused[id];
      if (left > 0) CAMP._startTimer(id, left);
    });
    CAMP._saveTimerState();   // clear persisted state now that timers are running again
  }
});


// ══════════════════════════════════════════════════════════════════
//  EVENT DELEGATION — Campaign only
// ══════════════════════════════════════════════════════════════════
document.addEventListener('click', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset.action;

  if (action === 'toggle-camp-quest') {
    CAMP.toggleQuest(el.dataset.quest);
    return;
  }
  if (action === 'camp-run') {
    if (typeof _canExecSQL === 'function' && !_canExecSQL()) return;
    CAMP.runQuest(el.dataset.quest);
    return;
  }
  if (action === 'camp-reset') {
    CAMP.reset();
    return;
  }
});


// ══════════════════════════════════════════════════════════════════
//  HOOK INTO PANEL SHOW
//  Listen for the 'datashop:panelshow' custom event dispatched by
//  UI.showPanel() in datashop-ui.js.  This decouples campaign.js
//  from UI internals — no monkey-patching needed and the module
//  keeps working regardless of load order or future UI refactors.
// ══════════════════════════════════════════════════════════════════
document.addEventListener('datashop:panelshow', function(e) {
  if (!e.detail || e.detail.panel !== 'camp') return;
  try {
    CAMP.init();
    CAMP.render();
  } catch (err) {
    console.warn('Campaign: render error on panel show', err);
  }
});

// Initialize on load
try { CAMP.init(); } catch (e) { console.warn('Campaign init error', e); }
