/* Road to C1 — app logic. Everything is stored locally: state in localStorage, audio in IndexedDB. */
(function () {
  'use strict';
  const D = window.RC1_DATA;
  const TOTAL_WEEKS = D.weeks.length; // 43
  const SKILLS = ['listening', 'speaking', 'reading', 'writing', 'vocab'];
  const SKILL_LABEL = { listening: 'Listening', speaking: 'Speaking', reading: 'Reading', writing: 'Writing', vocab: 'Vocabulary' };
  const STORE_KEY = 'rc1:state:v1';

  // ---------- utils ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
  const weekStartOf = (s) => { const d = parseYmd(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return ymd(d); };
  const fmtDate = (s, opts = { month: 'short', day: 'numeric' }) => parseYmd(s).toLocaleDateString('en-US', opts);
  const fmtSec = (sec) => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${pad(sec % 60)}`; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const pick = (arr, seed) => arr[hash(seed) % arr.length];
  const rand = (n) => Math.floor(Math.random() * n);
  const wordCount = (t) => (t.trim().match(/[A-Za-z0-9’'-]+/g) || []).length;

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- state ----------
  function defaultState() {
    return {
      version: 1,
      startDate: today(),
      settings: { listeningGoal: 210, newPerDay: 10, voiceURI: '', theme: 'auto' },
      baseline: { listening: 5.5, reading: 6.5, writing: 6.0, speaking: 6.0 },
      days: {},          // { date: { done: { taskId: true } } }
      weeksDone: {},     // { weekNo: true }
      vocab: {},         // SRS progress by word id
      customVocab: [],   // [{ id, term, type, meaning, example }]
      listening: [],     // [{ id, date, type, title, minutes, notes }]
      writing: [],       // [{ id, date, task, prompt, text, words, minutes, checks }]
      speakingLog: [],   // [{ date, sec }]
      shadowCount: {},   // { phraseIndex: count }
      selfChecks: [],    // [{ month, listening, reading, writing, speaking, note }]
      draft: null,       // writing draft
      lastExport: null,
    };
  }
  let S;
  function load() {
    try { S = Object.assign(defaultState(), JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || {}); }
    catch (e) { S = defaultState(); }
    S.settings = Object.assign(defaultState().settings, S.settings || {});
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
    catch (e) { toast('Could not save — browser storage is full or blocked'); }
  }
  load();

  // ---------- IndexedDB (recordings) ----------
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('rc1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('recordings', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('recordings', mode); const st = t.objectStore('recordings');
        const out = fn(st); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
      });
    };
    return {
      put: (rec) => tx('readwrite', (st) => st.put(rec)),
      del: (id) => tx('readwrite', (st) => st.delete(id)),
      all: () => tx('readonly', (st) => st.getAll()).then((r) => (r || []).sort((a, b) => b.created - a.created)),
      clear: () => tx('readwrite', (st) => st.clear()),
    };
  })();
  let recCount = 0;
  const refreshRecCount = () => idb.all().then((r) => { recCount = r.length; }).catch(() => {});

  // ---------- audio helpers ----------
  let audioCtx;
  function beep(times = 1) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
        const t0 = audioCtx.currentTime + i * 0.25;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.start(t0); o.stop(t0 + 0.2);
      }
    } catch (e) { /* no audio */ }
  }

  const Recorder = {
    mr: null, chunks: [], stream: null, t0: 0,
    get active() { return !!this.mr && this.mr.state === 'recording'; },
    async start() {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('Recording is not supported in this browser'); return false; }
      try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { toast('Microphone access was blocked'); return false; }
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t));
      this.mr = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
      this.chunks = []; this.mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.mr.start(); this.t0 = Date.now();
      return true;
    },
    stop() {
      return new Promise((res) => {
        if (!this.mr || this.mr.state === 'inactive') return res(null);
        this.mr.onstop = () => {
          const mime = this.mr.mimeType || 'audio/webm';
          const blob = new Blob(this.chunks, { type: mime });
          this.stream.getTracks().forEach((t) => t.stop());
          const out = { blob, mime, duration: (Date.now() - this.t0) / 1000 };
          this.mr = null; this.stream = null; res(out);
        };
        this.mr.stop();
      });
    },
  };
  async function saveRecording(r, kind, label) {
    if (!r || r.blob.size < 200) return null;
    const rec = { id: uid(), created: Date.now(), date: today(), kind, label, duration: r.duration, mime: r.mime, blob: r.blob };
    await idb.put(rec); recCount++;
    return rec;
  }

  // Text-to-speech (American English)
  const TTS = {
    voices: [],
    load() {
      if (!('speechSynthesis' in window)) return;
      this.voices = speechSynthesis.getVoices().filter((v) => /^en[-_]US/i.test(v.lang));
    },
    voice() {
      if (!this.voices.length) this.load();
      const chosen = this.voices.find((v) => v.voiceURI === S.settings.voiceURI);
      if (chosen) return chosen;
      const prefer = ['Samantha', 'Google US English', 'Aria', 'Jenny', 'Ava', 'Allison', 'Natural'];
      for (const p of prefer) { const v = this.voices.find((x) => x.name.includes(p)); if (v) return v; }
      return this.voices[0] || null;
    },
    speak(text, rate = 1) {
      if (!('speechSynthesis' in window)) { toast('Text-to-speech is not supported here'); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.voice(); if (v) u.voice = v;
      u.lang = 'en-US'; u.rate = rate;
      speechSynthesis.speak(u);
    },
  };
  if ('speechSynthesis' in window) { TTS.load(); speechSynthesis.onvoiceschanged = () => TTS.load(); }

  // ---------- plan logic ----------
  function weekNoFor(date) { return Math.min(TOTAL_WEEKS, Math.max(1, Math.floor(daysBetween(S.startDate, date) / 7) + 1)); }
  function phaseFor(week) { return D.phases.find((p) => week >= p.weeks[0] && week <= p.weeks[1]); }
  function weekInfo(n) { const w = D.weeks[n - 1]; return { n, theme: w[0], speaking: w[1], listening: w[2], extra: w[3] }; }

  function tasksFor(date) {
    const wk = weekInfo(weekNoFor(date));
    const wd = parseYmd(date).getDay(); // 0 Sun
    const shadowCats = [...new Set(D.shadowing.map((s) => s[2]))];
    const parts = ['everyday', 'part1', 'part2', 'part3', 'everyday', 'part2', 'part3'];
    const part = parts[wd];
    let prompt;
    if (part === 'part2') prompt = 'Part 2: ' + pick(D.speaking.part2, date).q;
    else if (part === 'part1') prompt = 'Part 1: ' + pick(D.speaking.part1, date) + ' (+ 2 more Part 1 questions)';
    else if (part === 'part3') prompt = 'Part 3: ' + pick(D.speaking.part3, date);
    else prompt = 'Everyday: ' + pick(D.speaking.everyday, date);
    const sug = pick(D.listeningSuggestions, date + 'l');
    const tasks = [
      { id: 'shadow', skill: 'speaking', min: 15, title: 'Shadowing — 5 phrases', detail: `Focus: ${pick(shadowCats, date)}. Listen at slow speed, then normal, then record yourself.`, link: '#shadowing' },
      { id: 'listen', skill: 'listening', min: 20, title: 'Listening practice — 20 min', detail: `${wk.listening}. Idea: ${sug[0]} — ${sug[1]}. Log it in the Listening log.`, link: '#listening' },
      { id: 'speak', skill: 'speaking', min: 15, title: 'Speaking prompt — record yourself', detail: prompt, link: '#speaking' },
      { id: 'vocab', skill: 'vocab', min: 10, title: 'Vocabulary review', detail: 'Finish today\'s due cards and learn new ones. Say each example sentence out loud.', link: '#vocab' },
    ];
    if (wd === 1 || wd === 5) tasks.push({ id: 'write', skill: 'writing', min: 25, title: 'Writing — Task 2 essay (40 min timed, or plan + 2 paragraphs)', detail: pick(D.writing.task2, date), link: '#writing' });
    else if (wd === 3) tasks.push({ id: 'write', skill: 'writing', min: 25, title: 'Writing — Task 1 report (20 min)', detail: pick(D.writing.task1, date).q, link: '#writing' });
    else tasks.push({ id: 'read', skill: 'reading', min: 15, title: 'Reading — one passage or long article', detail: 'Do an IELTS Reading passage (20 min) or read a US news article. Note 5 useful collocations.', link: null });
    return tasks;
  }
  const dayRec = (date) => S.days[date] || { done: {} };
  function dayDoneCount(date) { const r = dayRec(date); return tasksFor(date).filter((t) => r.done[t.id]).length; }
  function dayComplete(date) { return dayDoneCount(date) >= 4; }
  function streaks() {
    let cur = 0; let d = today();
    if (!dayComplete(d)) d = addDays(d, -1);
    while (dayComplete(d)) { cur++; d = addDays(d, -1); }
    const dates = Object.keys(S.days).sort();
    let best = 0, run = 0, prev = null;
    for (const dt of dates) {
      if (!dayComplete(dt)) { run = 0; prev = dt; continue; }
      run = prev && daysBetween(prev, dt) === 1 && run ? run + 1 : 1;
      best = Math.max(best, run); prev = dt;
    }
    return { cur, best: Math.max(best, cur) };
  }

  // Minutes per skill for a day: the larger of ticked-task minutes and logged minutes (avoids double counting).
  function dayMinutes(date) {
    const r = dayRec(date); const fromTasks = Object.fromEntries(SKILLS.map((s) => [s, 0]));
    tasksFor(date).forEach((t) => { if (r.done[t.id]) fromTasks[t.skill] += t.min; });
    const logged = Object.fromEntries(SKILLS.map((s) => [s, 0]));
    S.listening.forEach((l) => { if (l.date === date) logged.listening += +l.minutes || 0; });
    S.writing.forEach((w) => { if (w.date === date) logged.writing += +w.minutes || 0; });
    S.speakingLog.forEach((x) => { if (x.date === date) logged.speaking += x.sec / 60; });
    const out = {};
    SKILLS.forEach((s) => { out[s] = Math.round(Math.max(fromTasks[s], logged[s])); });
    return out;
  }
  function activeDates() {
    const set = new Set(Object.keys(S.days));
    S.listening.forEach((l) => set.add(l.date)); S.writing.forEach((w) => set.add(w.date)); S.speakingLog.forEach((x) => set.add(x.date));
    return [...set];
  }

  // ---------- vocab / SRS ----------
  function allVocab() {
    const built = D.vocab.map(([term, type, meaning, example]) => ({ id: 'b:' + term, term, type, meaning, example, custom: false }));
    return built.concat(S.customVocab.map((v) => ({ ...v, custom: true })));
  }
  const prog = (id) => S.vocab[id];
  const isLearned = (id) => (prog(id)?.interval || 0) >= 7;
  function reviewQueue() {
    const t = today(); const items = allVocab();
    const due = items.filter((v) => prog(v.id) && prog(v.id).due <= t)
      .sort((a, b) => (prog(b.id).lapses - prog(a.id).lapses) || (prog(a.id).due < prog(b.id).due ? -1 : 1));
    const newToday = Object.values(S.vocab).filter((p) => p.added === t).length;
    // custom words first among new ones
    const fresh = items.filter((v) => !prog(v.id)).sort((a, b) => (b.custom - a.custom)).slice(0, Math.max(0, S.settings.newPerDay - newToday));
    return due.concat(fresh);
  }
  function rate(id, grade) {
    const t = today();
    const p = S.vocab[id] || { ease: 2.5, interval: 0, due: t, reps: 0, lapses: 0, added: t };
    p.reps++; p.last = t;
    if (grade === 0) { p.lapses++; p.ease = Math.max(1.3, p.ease - 0.2); p.interval = 0; }
    else if (grade === 1) { p.ease = Math.max(1.3, p.ease - 0.15); p.interval = Math.max(1, Math.round(p.interval * 1.2)); }
    else if (grade === 2) { p.interval = p.interval === 0 ? 1 : p.interval === 1 ? 3 : Math.round(p.interval * p.ease); }
    else { p.ease += 0.15; p.interval = p.interval === 0 ? 4 : Math.round(p.interval * p.ease * 1.3); }
    // words you often miss come back sooner
    if (grade > 0 && p.lapses >= 3) p.interval = Math.max(1, Math.round(p.interval * 0.7));
    p.due = addDays(t, p.interval);
    S.vocab[id] = p; save();
  }

  // ---------- icons ----------
  const I = {
    today: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
    roadmap: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
    speaking: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 17v5"/>',
    shadowing: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14"/>',
    vocab: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5z"/><path d="M4 19.5A2.5 2.5 0 006.5 22H20v-5"/>',
    listening: '<path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1v-6h3zM3 19a2 2 0 002 2h1v-6H3z"/>',
    writing: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    stats: '<path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    slow: '<path d="M6 4l14 8-14 8z"/><path d="M2 4v16" />',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 17v5"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    refresh: '<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

  // ---------- router ----------
  const ROUTES = [
    ['today', 'Today'], ['roadmap', 'Roadmap'], ['speaking', 'Speaking'], ['shadowing', 'Shadowing'],
    ['vocab', 'Vocabulary'], ['listening', 'Listening'], ['writing', 'Writing'], ['stats', 'Stats'], ['settings', 'Backup & Settings'],
  ];
  $('#nav').innerHTML = ROUTES.map(([k, l]) => `<a href="#${k}" data-route="${k}">${icon(k)}<span>${l === 'Backup & Settings' ? 'Settings' : l}</span></a>`).join('');

  let cleanup = [];
  const onLeave = (fn) => cleanup.push(fn);
  function route() {
    cleanup.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } }); cleanup = [];
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    while (objectURLs.length) URL.revokeObjectURL(objectURLs.pop());
    const key = (location.hash.slice(1) || 'today').split('?')[0];
    const view = VIEWS[key] ? key : 'today';
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === view));
    const root = $('#view'); root.innerHTML = '';
    VIEWS[view](root);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ---------- shared UI pieces ----------
  const objectURLs = [];
  const audioTag = (blob) => { const u = URL.createObjectURL(blob); objectURLs.push(u); return `<audio controls preload="metadata" src="${u}"></audio>`; };

  async function renderRecordings(el, kind) {
    let recs = [];
    try { recs = await idb.all(); } catch (e) { el.innerHTML = '<p class="muted">Recordings storage is unavailable in this browser.</p>'; return; }
    if (kind) recs = recs.filter((r) => r.kind === kind);
    if (!recs.length) { el.innerHTML = '<div class="empty">No recordings yet. Your first recording is your baseline — make one today!</div>'; return; }
    const groups = {};
    recs.forEach((r) => (groups[r.date] = groups[r.date] || []).push(r));
    el.innerHTML = Object.keys(groups).sort().reverse().map((d) => `
      <h3 style="margin-top:14px">${fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} <span class="muted small">· ${groups[d].length}</span></h3>
      <ul class="list">${groups[d].map((r) => `
        <li data-id="${r.id}">
          <div style="flex:1;min-width:200px"><span class="chip ${r.kind === 'shadowing' ? 'vocab' : 'speaking'}">${r.kind}</span>
            <span class="small muted">${new Date(r.created).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${fmtSec(r.duration)}</span>
            <div class="small">${esc(r.label)}</div></div>
          ${audioTag(r.blob)}
          <a class="btn sm ghost" title="Download" download="road-to-c1-${r.date}-${r.id}.${/mp4/.test(r.mime) ? 'm4a' : /ogg/.test(r.mime) ? 'ogg' : 'webm'}" href="${objectURLs[objectURLs.length - 1]}">${icon('download')}</a>
          <button class="btn sm ghost danger" data-del="${r.id}" title="Delete">${icon('trash')}</button>
        </li>`).join('')}</ul>`).join('');
    $$('[data-del]', el).forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this recording?')) return;
      await idb.del(b.dataset.del); recCount = Math.max(0, recCount - 1); renderRecordings(el, kind);
    });
  }

  // ---------- VIEWS ----------
  const VIEWS = {};

  // TODAY
  VIEWS.today = (root) => {
    const t = today(); const wn = weekNoFor(t); const wk = weekInfo(wn); const ph = phaseFor(wn);
    const tasks = tasksFor(t); const rec = dayRec(t);
    const done = tasks.filter((x) => rec.done[x.id]).length;
    const totalMin = tasks.reduce((a, x) => a + x.min, 0);
    const doneMin = tasks.filter((x) => rec.done[x.id]).reduce((a, x) => a + x.min, 0);
    const st = streaks();
    const before = daysBetween(S.startDate, t) < 0;
    const needBackup = !S.lastExport || daysBetween(S.lastExport.slice(0, 10), t) > 14;
    root.innerHTML = `
      <div class="page-head"><div>
        <p class="muted">${parseYmd(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1>Today's plan</h1>
        <p class="muted">Week ${wn} of ${TOTAL_WEEKS} · ${ph.name} (${ph.months}) · <b>${esc(wk.theme)}</b></p>
      </div></div>
      ${before ? `<div class="banner">Your plan starts on ${fmtDate(S.startDate)}. You can change the start date in Settings.</div>` : ''}
      ${needBackup && activeDates().length > 3 ? `<div class="banner">💾 Your data lives only in this browser. <a href="#settings">Export a backup</a> every couple of weeks.</div>` : ''}
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="card stat"><div class="num">🔥 ${st.cur}</div><div class="lbl">day streak · best ${st.best}</div></div>
        <div class="card stat"><div class="num">${done}/${tasks.length}</div><div class="lbl">tasks done</div></div>
        <div class="card stat"><div class="num">${doneMin}<span class="small muted"> / ${totalMin} min</span></div><div class="lbl">today's time</div></div>
        <div class="card stat"><div class="num">${Math.round((wn - 1 + parseYmd(t).getDay() / 7) / TOTAL_WEEKS * 100)}%</div><div class="lbl">of the 10-month road</div></div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:10px"><h2 style="margin:0">Checklist</h2><span class="spacer"></span><span class="small muted">A day counts for your streak at 4+ tasks</span></div>
        <div class="progress" style="margin-bottom:14px"><div style="width:${done / tasks.length * 100}%"></div></div>
        <div id="tasks">${tasks.map((x) => `
          <label class="task ${rec.done[x.id] ? 'done' : ''}">
            <input type="checkbox" class="check" data-task="${x.id}" ${rec.done[x.id] ? 'checked' : ''}>
            <div class="task-body">
              <div class="row" style="gap:8px"><span class="task-title">${esc(x.title)}</span><span class="chip ${x.skill}">${SKILL_LABEL[x.skill]} · ${x.min} min</span></div>
              <div class="small muted" style="margin-top:3px">${esc(x.detail)}</div>
              ${x.link ? `<a class="small" href="${x.link}">Open ${x.link.slice(1)} →</a>` : ''}
            </div>
          </label>`).join('')}</div>
        ${done === tasks.length ? '<p style="margin:10px 0 0;font-weight:600;color:var(--ok)">🎉 All done today. Great work — consistency is what gets you to C1.</p>' : ''}
      </div>
      <div class="card">
        <h2>This week's goals <span class="muted small">· Week ${wn}</span></h2>
        <ul class="list">
          <li><span class="chip speaking">Speaking</span> ${esc(wk.speaking)}</li>
          <li><span class="chip listening">Listening</span> ${esc(wk.listening)}</li>
          <li><span class="chip writing">Also</span> ${esc(wk.extra)}</li>
        </ul>
        <a href="#roadmap" class="small">See the full roadmap →</a>
      </div>`;
    $$('[data-task]', root).forEach((cb) => cb.onchange = () => {
      const r = S.days[t] = S.days[t] || { done: {} };
      if (cb.checked) r.done[cb.dataset.task] = true; else delete r.done[cb.dataset.task];
      save(); route();
    });
  };

  // ROADMAP
  VIEWS.roadmap = (root) => {
    const cur = weekNoFor(today());
    const doneTotal = Object.keys(S.weeksDone).filter((k) => S.weeksDone[k]).length;
    root.innerHTML = `
      <div class="page-head"><div><h1>10-month roadmap</h1>
        <p class="muted">From B2 (IELTS 6.0) to C1 (7.0+). Started ${fmtDate(S.startDate, { month: 'short', day: 'numeric', year: 'numeric' })} · you're in week ${cur}. ${doneTotal}/${TOTAL_WEEKS} weeks completed.</p></div></div>
      <div class="card">
        <div class="phase-bar">${D.phases.map((p) => {
          const len = p.weeks[1] - p.weeks[0] + 1;
          const d = Array.from({ length: len }, (_, i) => p.weeks[0] + i).filter((w) => S.weeksDone[w]).length;
          return `<div style="width:${len / TOTAL_WEEKS * 100}%;background:var(--surface-2);position:relative;border-right:2px solid var(--surface)"><div style="height:100%;width:${d / len * 100}%;background:${p.color}"></div></div>`;
        }).join('')}</div>
        <div class="grid grid-3" style="margin-top:16px">${D.phases.map((p) => {
          const len = p.weeks[1] - p.weeks[0] + 1;
          const d = Array.from({ length: len }, (_, i) => p.weeks[0] + i).filter((w) => S.weeksDone[w]).length;
          const isCur = cur >= p.weeks[0] && cur <= p.weeks[1];
          return `<div><div class="row" style="gap:8px"><span class="dot" style="background:${p.color}"></span><b>Phase ${p.id}: ${p.name}</b>${isCur ? '<span class="chip" style="color:var(--accent)">current</span>' : ''}</div>
            <div class="small muted">${p.months} · weeks ${p.weeks[0]}–${p.weeks[1]} · ${d}/${len} done</div>
            <p class="small" style="margin-top:6px">${esc(p.summary)}</p>
            <ul class="small muted" style="padding-left:18px;margin:0">${p.targets.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
        }).join('')}</div>
      </div>
      ${D.phases.map((p) => `
        <h2 style="margin-top:24px"><span class="dot" style="background:${p.color}"></span> Phase ${p.id} · ${p.name} <span class="muted small">${p.months}</span></h2>
        <div class="weeks">${Array.from({ length: p.weeks[1] - p.weeks[0] + 1 }, (_, i) => {
          const w = weekInfo(p.weeks[0] + i); const start = addDays(S.startDate, (w.n - 1) * 7);
          return `<div class="week ${w.n === cur ? 'current' : ''} ${S.weeksDone[w.n] ? 'complete' : ''}" id="w${w.n}">
            <div class="row" style="gap:6px;margin-bottom:4px"><span class="small muted">Week ${w.n} · ${fmtDate(start)}</span><span class="spacer"></span>
              <label class="small row" style="gap:6px;cursor:pointer"><input type="checkbox" class="check" style="width:20px;height:20px" data-week="${w.n}" ${S.weeksDone[w.n] ? 'checked' : ''}> done</label></div>
            <h4>${esc(w.theme)}</h4>
            <ul><li>🗣 ${esc(w.speaking)}</li><li>🎧 ${esc(w.listening)}</li><li>✏️ ${esc(w.extra)}</li></ul>
          </div>`;
        }).join('')}</div>`).join('')}`;
    $$('[data-week]', root).forEach((cb) => cb.onchange = () => {
      if (cb.checked) S.weeksDone[cb.dataset.week] = true; else delete S.weeksDone[cb.dataset.week];
      save(); const y = window.scrollY; route(); window.scrollTo(0, y);
    });
    const el = $('#w' + cur); if (el) setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  };

  // SPEAKING
  const SP_MODES = {
    part1: { label: 'Part 1', prep: 0, talk: 45, hint: 'Answer directly, give a reason and a quick example. 2–4 sentences.' },
    part2: { label: 'Part 2', prep: 60, talk: 120, hint: '1 minute to prepare (make notes), then talk for the full 2 minutes.' },
    part3: { label: 'Part 3', prep: 10, talk: 75, hint: 'Opinion → reason → example → other side. Aim for 45–75 seconds.' },
    everyday: { label: 'Everyday', prep: 20, talk: 120, hint: 'Role-play it out loud like a real American conversation. Use contractions and reductions.' },
  };
  const sp = { mode: 'part2', idx: null, phase: 'idle', endAt: 0, timer: null, talkStart: 0, autoRec: true };
  function spPrompt() {
    const arr = D.speaking[sp.mode];
    if (sp.idx == null || sp.idx >= arr.length) sp.idx = rand(arr.length);
    return arr[sp.idx];
  }
  VIEWS.speaking = (root) => {
    const m = SP_MODES[sp.mode]; const q = spPrompt();
    const qText = typeof q === 'string' ? q : q.q;
    root.innerHTML = `
      <div class="page-head"><div><h1>Speaking practice</h1><p class="muted">Random IELTS questions and everyday American conversations. Record, listen back, and track your progress.</p></div></div>
      <div class="card">
        <div class="row"><div class="seg" id="modes">${Object.entries(SP_MODES).map(([k, v]) => `<button data-mode="${k}" class="${k === sp.mode ? 'on' : ''}">${v.label}</button>`).join('')}</div>
          <span class="spacer"></span><button class="btn" id="next">${icon('refresh')} New question</button></div>
        <div style="margin:18px 0 6px" class="prompt-box">${esc(qText)}</div>
        ${q.bullets ? `<div class="small muted">You should say:</div><ul style="margin:4px 0 0">${q.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
        <p class="small muted" style="margin-top:10px">${esc(m.hint)}</p>
      </div>
      <div class="card" id="timerCard">
        <div class="row" style="align-items:flex-end">
          <div><div class="timer-phase" id="phase">Ready</div><div class="timer" id="clock">${fmtSec(m.prep || m.talk)}</div></div>
          <span class="spacer"></span>
          <label class="field" style="width:90px">Prep (sec)<input type="number" id="prep" min="0" max="600" value="${m.prep}"></label>
          <label class="field" style="width:90px">Talk (sec)<input type="number" id="talk" min="10" max="900" value="${m.talk}"></label>
        </div>
        <div class="progress" style="margin:12px 0"><div id="bar" style="width:0%"></div></div>
        <div class="row">
          <button class="btn primary" id="start">${icon('play')} Start timer</button>
          <button class="btn" id="stopT" disabled>${icon('stop')} Stop</button>
          <label class="row small" style="gap:6px;cursor:pointer"><input type="checkbox" id="autoRec" ${sp.autoRec ? 'checked' : ''}> Record automatically when talking starts</label>
          <span class="spacer"></span>
          <button class="btn" id="recBtn">${icon('mic')} Record</button>
        </div>
        <div id="justRec" style="margin-top:12px"></div>
      </div>
      <div class="grid grid-2">
        <div class="card"><h2>Natural phrases to use</h2>
          <ul class="list">${D.speaking.phrases.map(([k, v]) => `<li><div><b class="small">${esc(k)}</b><div class="small muted">${esc(v)}</div></div></li>`).join('')}</ul></div>
        <div class="card"><h2>Self-check after each answer</h2>
          <ul class="small" style="padding-left:18px;margin:0;line-height:1.9">
            <li>Did I keep talking without long pauses (Fluency)?</li><li>Did I use linking words and examples (Coherence)?</li>
            <li>Did I use at least 2 less common words or idioms (Lexical resource)?</li><li>Did I mix simple and complex sentences (Grammar)?</li>
            <li>Did I use contractions, reductions and natural stress (Pronunciation)?</li></ul></div>
      </div>
      <div class="card"><div class="row"><h2 style="margin:0">My recordings</h2><span class="spacer"></span>
        <div class="seg" id="recFilter"><button data-k="" class="on">All</button><button data-k="speaking">Speaking</button><button data-k="shadowing">Shadowing</button></div></div>
        <div id="recs"></div></div>`;

    const clock = $('#clock', root), phaseEl = $('#phase', root), bar = $('#bar', root);
    const startBtn = $('#start', root), stopBtn = $('#stopT', root), recBtn = $('#recBtn', root);
    const recsEl = $('#recs', root); let recKind = '';
    renderRecordings(recsEl, recKind);
    $$('#recFilter button', root).forEach((b) => b.onclick = () => {
      $$('#recFilter button', root).forEach((x) => x.classList.toggle('on', x === b)); recKind = b.dataset.k; renderRecordings(recsEl, recKind);
    });
    $$('#modes button', root).forEach((b) => b.onclick = () => { if (sp.phase !== 'idle' || Recorder.active) return toast('Stop the current session first'); sp.mode = b.dataset.mode; sp.idx = null; route(); });
    $('#next', root).onclick = () => { if (sp.phase !== 'idle' || Recorder.active) return toast('Stop the current session first'); sp.idx = null; route(); };
    $('#autoRec', root).onchange = (e) => { sp.autoRec = e.target.checked; };

    const setRecUI = () => { recBtn.innerHTML = Recorder.active ? `${icon('stop')} Stop recording` : `${icon('mic')} Record`; recBtn.classList.toggle('rec', Recorder.active); };
    async function stopRec() {
      if (!Recorder.active) return;
      const r = await Recorder.stop(); setRecUI();
      const saved = await saveRecording(r, 'speaking', `${m.label}: ${qText}`);
      if (saved) { $('#justRec', root).innerHTML = `<div class="row small"><b>Just recorded (${fmtSec(saved.duration)}):</b> ${audioTag(saved.blob)}</div>`; renderRecordings(recsEl, recKind); toast('Recording saved'); }
    }
    recBtn.onclick = async () => { if (Recorder.active) return stopRec(); if (await Recorder.start()) setRecUI(); };

    function logTalk() {
      if (!sp.talkStart) return;
      const sec = (Date.now() - sp.talkStart) / 1000; sp.talkStart = 0;
      if (sec >= 5) { S.speakingLog.push({ date: today(), sec: Math.round(sec) }); save(); }
    }
    function finish(manual) {
      clearInterval(sp.timer); sp.timer = null;
      if (sp.phase === 'talk') logTalk();
      sp.phase = 'idle'; phaseEl.textContent = manual ? 'Stopped' : 'Time\'s up!';
      startBtn.disabled = false; stopBtn.disabled = true; bar.style.width = manual ? '0%' : '100%';
      if (!manual) { beep(2); $('#timerCard', root).classList.add('flash'); }
      stopRec();
    }
    async function enterTalk() {
      const talk = +$('#talk', root).value || 120;
      sp.phase = 'talk'; sp.endAt = Date.now() + talk * 1000; sp.talkStart = Date.now(); sp.dur = talk;
      phaseEl.textContent = 'Talk'; phaseEl.style.color = 'var(--c-speaking)';
      beep(1);
      if (sp.autoRec && !Recorder.active && await Recorder.start()) setRecUI();
    }
    function tick() {
      const left = (sp.endAt - Date.now()) / 1000;
      clock.textContent = fmtSec(Math.ceil(left));
      bar.style.width = `${Math.min(100, (1 - left / sp.dur) * 100)}%`;
      if (left <= 0) { if (sp.phase === 'prep') enterTalk(); else finish(false); }
    }
    startBtn.onclick = async () => {
      $('#timerCard', root).classList.remove('flash');
      const prep = +$('#prep', root).value || 0;
      startBtn.disabled = true; stopBtn.disabled = false;
      if (prep > 0) { sp.phase = 'prep'; sp.endAt = Date.now() + prep * 1000; sp.dur = prep; phaseEl.textContent = 'Prepare — make notes'; phaseEl.style.color = 'var(--c-listening)'; }
      else await enterTalk();
      sp.timer = setInterval(tick, 200); tick();
    };
    stopBtn.onclick = () => finish(true);
    onLeave(() => { clearInterval(sp.timer); if (sp.phase === 'talk') logTalk(); sp.phase = 'idle'; if (Recorder.active) Recorder.stop(); });
  };

  // SHADOWING
  const sh = { cat: 'All' };
  VIEWS.shadowing = (root) => {
    const cats = ['All', ...new Set(D.shadowing.map((s) => s[2]))];
    const items = D.shadowing.map((s, i) => ({ i, text: s[0], sounds: s[1], cat: s[2], tip: s[3] })).filter((s) => sh.cat === 'All' || s.cat === sh.cat);
    const hasTTS = 'speechSynthesis' in window;
    root.innerHTML = `
      <div class="page-head"><div><h1>Shadowing</h1><p class="muted">Listen → repeat at the same time → record → compare. Copy the rhythm and melody, not just the words.</p></div></div>
      <div class="card">
        <div class="form-grid">
          <label class="field">American voice<select id="voice"></select></label>
          <label class="field">Slow speed<select id="slowRate">${[0.5, 0.6, 0.7, 0.8].map((r) => `<option value="${r}" ${r === (S.settings.slowRate || 0.7) ? 'selected' : ''}>${r}×</option>`).join('')}</select></label>
        </div>
        ${hasTTS ? '' : '<p class="small" style="color:var(--danger);margin-top:8px">This browser has no text-to-speech. Try Chrome, Edge or Safari.</p>'}
        <p class="small muted" style="margin:10px 0 0">Method: ① play slow and read along ② play normal and whisper along ③ play and speak at the same time ④ record yourself and compare with the model.</p>
      </div>
      <div class="card">
        <h3>Shadow your own sentence</h3>
        <div class="row"><input type="text" id="custom" placeholder="Paste any sentence from a podcast or series…" style="flex:1;min-width:200px">
          <button class="btn" data-say="custom" data-rate="1">${icon('play')} Normal</button><button class="btn" data-say="custom" data-rate="slow">Slow</button></div>
      </div>
      <div class="seg" style="margin-bottom:14px" id="cats">${cats.map((c) => `<button class="${c === sh.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="grid grid-2">${items.map((s) => `
        <div class="card" data-i="${s.i}">
          <div class="row" style="gap:6px;margin-bottom:6px"><span class="chip vocab">${esc(s.cat)}</span><span class="spacer"></span><span class="small muted">${S.shadowCount[s.i] ? `practiced ${S.shadowCount[s.i]}×` : ''}</span></div>
          <div style="font-size:1.12rem;font-weight:650">${esc(s.text)}</div>
          <div class="small" style="margin:4px 0;color:var(--accent)">🔊 ${esc(s.sounds)}</div>
          <div class="small muted">${esc(s.tip)}</div>
          <div class="row" style="margin-top:12px;gap:6px">
            <button class="btn sm" data-play="${s.i}" data-rate="1">${icon('play')} Normal</button>
            <button class="btn sm" data-play="${s.i}" data-rate="slow">Slow</button>
            <button class="btn sm" data-rec="${s.i}">${icon('mic')} Record me</button>
          </div>
          <div class="take small" style="margin-top:8px"></div>
        </div>`).join('')}</div>`;

    const sel = $('#voice', root);
    const fillVoices = () => {
      TTS.load(); const v = TTS.voice();
      sel.innerHTML = TTS.voices.length ? TTS.voices.map((x) => `<option value="${esc(x.voiceURI)}" ${v && v.voiceURI === x.voiceURI ? 'selected' : ''}>${esc(x.name)}</option>`).join('') : '<option value="">Default (en-US)</option>';
    };
    fillVoices();
    if ('speechSynthesis' in window) { const prev = speechSynthesis.onvoiceschanged; speechSynthesis.onvoiceschanged = () => { TTS.load(); fillVoices(); }; onLeave(() => { speechSynthesis.onvoiceschanged = prev; }); }
    sel.onchange = () => { S.settings.voiceURI = sel.value; save(); toast('Voice saved'); };
    $('#slowRate', root).onchange = (e) => { S.settings.slowRate = +e.target.value; save(); };
    const rateOf = (r) => (r === 'slow' ? (S.settings.slowRate || 0.7) : 1);
    $$('[data-say]', root).forEach((b) => b.onclick = () => { const t = $('#custom', root).value.trim(); if (t) TTS.speak(t, rateOf(b.dataset.rate)); });
    $$('#cats button', root).forEach((b) => b.onclick = () => { sh.cat = b.dataset.cat; route(); });
    $$('[data-play]', root).forEach((b) => b.onclick = () => TTS.speak(D.shadowing[b.dataset.play][0], rateOf(b.dataset.rate)));

    let activeBtn = null;
    $$('[data-rec]', root).forEach((b) => b.onclick = async () => {
      const i = +b.dataset.rec; const card = b.closest('.card');
      if (Recorder.active) {
        if (activeBtn !== b) return toast('Finish the other recording first');
        const r = await Recorder.stop(); activeBtn = null;
        b.classList.remove('rec'); b.innerHTML = `${icon('mic')} Record me`;
        const saved = await saveRecording(r, 'shadowing', D.shadowing[i][0]);
        if (saved) {
          S.shadowCount[i] = (S.shadowCount[i] || 0) + 1; save();
          $('.take', card).innerHTML = `<div class="row" style="gap:6px"><b>Your take:</b> ${audioTag(saved.blob)}<button class="btn sm" data-cmp>Model → me</button></div>`;
          const a = $('audio', card);
          $('[data-cmp]', card).onclick = () => {
            if (!('speechSynthesis' in window)) return a.play();
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(D.shadowing[i][0]); const v = TTS.voice(); if (v) u.voice = v; u.lang = 'en-US';
            u.onend = () => { a.currentTime = 0; a.play(); };
            speechSynthesis.speak(u);
          };
        }
        return;
      }
      if (await Recorder.start()) { activeBtn = b; b.classList.add('rec'); b.innerHTML = `${icon('stop')} Stop`; }
    });
    onLeave(() => { if (Recorder.active) Recorder.stop(); });
  };

  // VOCAB
  const vs = { tab: 'review', queue: null, cur: null, shown: false, q: '', type: 'all', tricky: false };
  VIEWS.vocab = (root) => {
    const items = allVocab();
    const learned = items.filter((v) => isLearned(v.id)).length;
    const seen = items.filter((v) => prog(v.id)).length;
    const dueCount = reviewQueue().length;
    root.innerHTML = `
      <div class="page-head"><div><h1>Vocabulary & phrases</h1><p class="muted">C1 words, phrasal verbs, idioms and collocations Americans actually use. Spaced repetition brings back the ones you miss.</p></div></div>
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="card stat"><div class="num">${dueCount}</div><div class="lbl">to review now</div></div>
        <div class="card stat"><div class="num">${learned}</div><div class="lbl">learned (7+ day interval)</div></div>
        <div class="card stat"><div class="num">${seen}</div><div class="lbl">started</div></div>
        <div class="card stat"><div class="num">${items.length}</div><div class="lbl">in your deck</div></div>
      </div>
      <div class="seg" style="margin-bottom:14px" id="tabs">
        <button data-tab="review" class="${vs.tab === 'review' ? 'on' : ''}">Review</button>
        <button data-tab="browse" class="${vs.tab === 'browse' ? 'on' : ''}">Browse</button>
        <button data-tab="add" class="${vs.tab === 'add' ? 'on' : ''}">Add my word</button>
      </div>
      <div id="tab"></div>`;
    $$('#tabs button', root).forEach((b) => b.onclick = () => { vs.tab = b.dataset.tab; vs.queue = null; route(); });
    const tab = $('#tab', root);
    if (vs.tab === 'review') reviewTab(tab);
    else if (vs.tab === 'browse') browseTab(tab);
    else addTab(tab);
  };
  function reviewTab(el) {
    if (!vs.queue) {
      if (vs.tricky) {
        vs.queue = allVocab().filter((v) => prog(v.id)?.lapses).sort((a, b) => prog(b.id).lapses - prog(a.id).lapses).slice(0, 15);
      } else vs.queue = reviewQueue();
      vs.shown = false;
    }
    const v = vs.queue[0];
    if (!v) {
      const tricky = allVocab().filter((x) => prog(x.id)?.lapses).length;
      el.innerHTML = `<div class="card empty"><h2>✅ You're done for today</h2><p>Come back tomorrow for new words and reviews.</p>
        <div class="row" style="justify-content:center">${tricky ? `<button class="btn" id="tricky">Practice ${Math.min(15, tricky)} tricky words</button>` : ''}
        <button class="btn" id="more">Learn 5 more new words</button></div></div>`;
      $('#tricky', el) && ($('#tricky', el).onclick = () => { vs.tricky = true; vs.queue = null; reviewTab(el); });
      $('#more', el).onclick = () => { vs.tricky = false; vs.queue = allVocab().filter((x) => !prog(x.id)).slice(0, 5); reviewTab(el); };
      vs.tricky = false;
      return;
    }
    const p = prog(v.id);
    el.innerHTML = `
      <div class="card flash-card">
        <div class="row" style="justify-content:center;gap:6px;margin-bottom:10px"><span class="chip vocab">${esc(v.type)}</span>
          ${p ? (p.lapses ? `<span class="chip" style="color:var(--warn)">missed ${p.lapses}×</span>` : '') : '<span class="chip" style="color:var(--accent)">new</span>'}
          <span class="chip">${vs.queue.length} left</span></div>
        <div class="term">${esc(v.term)}</div>
        <button class="btn sm ghost" id="say" style="margin-top:6px">${icon('play')} Hear it</button>
        <div id="ans" class="${vs.shown ? '' : 'hidden'}" style="margin-top:16px">
          <div style="font-size:1.05rem">${esc(v.meaning)}</div>
          <div class="muted" style="margin-top:8px;font-style:italic">“${esc(v.example)}”</div>
          <button class="btn sm ghost" id="sayEx" style="margin-top:4px">${icon('play')} Example</button>
          <p class="small muted" style="margin-top:10px">Now say your own sentence with it out loud.</p>
        </div>
      </div>
      ${vs.shown ? `<div class="rate-btns">
          <button class="btn" data-g="0" style="color:var(--danger)">Again<small>didn't know</small></button>
          <button class="btn" data-g="1">Hard<small>barely</small></button>
          <button class="btn" data-g="2" style="color:var(--ok)">Good<small>got it</small></button>
          <button class="btn" data-g="3" style="color:var(--accent)">Easy<small>too easy</small></button></div>`
        : '<button class="btn primary" id="show" style="width:100%">Show meaning</button>'}`;
    $('#say', el).onclick = () => TTS.speak(v.term, 0.9);
    $('#sayEx', el).onclick = () => TTS.speak(v.example, 1);
    if (!vs.shown) $('#show', el).onclick = () => { vs.shown = true; reviewTab(el); };
    $$('[data-g]', el).forEach((b) => b.onclick = () => {
      const g = +b.dataset.g; rate(v.id, g); vs.queue.shift(); vs.shown = false;
      if (g === 0) vs.queue.splice(Math.min(3, vs.queue.length), 0, v); // missed words come back in this session
      route();
    });
  }
  function browseTab(el) {
    const types = ['all', 'word', 'phrasal verb', 'idiom', 'collocation', 'mine'];
    el.innerHTML = `<div class="card">
      <div class="row"><input type="text" id="q" placeholder="Search…" value="${esc(vs.q)}" style="flex:1;min-width:180px">
        <select id="type" style="width:auto">${types.map((t) => `<option ${t === vs.type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <ul class="list" id="vlist" style="margin-top:8px"></ul></div>`;
    const draw = () => {
      const q = vs.q.toLowerCase();
      const list = allVocab().filter((v) => (vs.type === 'all' || (vs.type === 'mine' ? v.custom : v.type === vs.type)) && (!q || (v.term + v.meaning + v.example).toLowerCase().includes(q)));
      $('#vlist', el).innerHTML = list.map((v) => {
        const p = prog(v.id); const status = !p ? 'New' : isLearned(v.id) ? 'Learned' : 'Learning';
        return `<li><div style="flex:1;min-width:220px"><b>${esc(v.term)}</b> <span class="chip vocab">${esc(v.type)}</span> <span class="chip" style="color:${status === 'Learned' ? 'var(--ok)' : status === 'Learning' ? 'var(--warn)' : 'var(--muted)'}">${status}${p?.lapses ? ` · missed ${p.lapses}×` : ''}</span>
          <div class="small">${esc(v.meaning)}</div><div class="small muted"><i>${esc(v.example)}</i></div></div>
          <button class="btn sm ghost" data-say="${esc(v.id)}">${icon('play')}</button>
          ${v.custom ? `<button class="btn sm ghost danger" data-delv="${esc(v.id)}">${icon('trash')}</button>` : ''}</li>`;
      }).join('') || '<li class="empty">Nothing found.</li>';
      $$('[data-say]', el).forEach((b) => b.onclick = () => { const v = allVocab().find((x) => x.id === b.dataset.say); TTS.speak(`${v.term}. ${v.example}`, 0.95); });
      $$('[data-delv]', el).forEach((b) => b.onclick = () => {
        if (!confirm('Delete this word?')) return;
        S.customVocab = S.customVocab.filter((x) => x.id !== b.dataset.delv); delete S.vocab[b.dataset.delv]; save(); draw();
      });
    };
    $('#q', el).oninput = (e) => { vs.q = e.target.value; draw(); };
    $('#type', el).onchange = (e) => { vs.type = e.target.value; draw(); };
    draw();
  }
  function addTab(el) {
    el.innerHTML = `<div class="card"><form id="addf" class="stack">
      <div class="form-grid"><label class="field">Word or phrase<input type="text" name="term" required placeholder="e.g. hit the ground running"></label>
        <label class="field">Type<select name="type"><option>word</option><option>phrasal verb</option><option>idiom</option><option>collocation</option></select></label></div>
      <label class="field">Meaning<input type="text" name="meaning" required placeholder="Short definition in English"></label>
      <label class="field">Example sentence<input type="text" name="example" placeholder="Where did you hear it? Write the real sentence."></label>
      <button class="btn primary">Add to my deck</button></form>
      <p class="small muted" style="margin-top:10px">Your words are shown first among new cards in your next review.</p></div>`;
    $('#addf', el).onsubmit = (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      S.customVocab.push({ id: 'c:' + uid(), term: f.get('term').trim(), type: f.get('type'), meaning: f.get('meaning').trim(), example: f.get('example').trim() });
      save(); e.target.reset(); toast('Word added');
    };
  }

  // LISTENING
  VIEWS.listening = (root) => {
    const t = today(); const ws = weekStartOf(t);
    const weekMin = S.listening.filter((l) => l.date >= ws && l.date <= addDays(ws, 6)).reduce((a, l) => a + (+l.minutes || 0), 0);
    const goal = S.settings.listeningGoal; const total = S.listening.reduce((a, l) => a + (+l.minutes || 0), 0);
    const types = ['Podcast', 'Series / Movie', 'YouTube', 'IELTS practice test', 'Audiobook', 'News', 'Other'];
    root.innerHTML = `
      <div class="page-head"><div><h1>Listening log</h1><p class="muted">Your biggest gap is Listening (5.5). Log everything you watch and listen to in English.</p></div></div>
      <div class="card">
        <div class="row"><h2 style="margin:0">This week</h2><span class="spacer"></span>
          <label class="row small" style="gap:6px">Weekly goal <input type="number" id="goal" min="30" step="30" value="${goal}" style="width:90px"> min</label></div>
        <div class="row" style="margin:12px 0 6px"><span class="stat"><span class="num">${weekMin}</span> <span class="muted">/ ${goal} min</span></span><span class="spacer"></span>
          <span class="small muted">${weekMin >= goal ? '🎉 Goal reached!' : `${goal - weekMin} min to go · about ${Math.ceil((goal - weekMin) / Math.max(1, 7 - (parseYmd(t).getDay() + 6) % 7))} min/day`}</span></div>
        <div class="progress"><div style="width:${Math.min(100, weekMin / goal * 100)}%"></div></div>
        <p class="small muted" style="margin:8px 0 0">All-time: ${Math.floor(total / 60)} h ${total % 60} min across ${S.listening.length} sessions.</p>
      </div>
      <div class="card"><h2>Add a session</h2>
        <form id="lf" class="stack">
          <div class="form-grid">
            <label class="field">Date<input type="date" name="date" value="${t}" required></label>
            <label class="field">Type<select name="type">${types.map((x) => `<option>${x}</option>`).join('')}</select></label>
            <label class="field">Minutes<input type="number" name="minutes" min="1" max="600" value="20" required></label>
          </div>
          <label class="field">What did you watch or listen to?<input type="text" name="title" required placeholder="e.g. The Daily — episode about AI jobs"></label>
          <label class="field">Notes (new phrases, how much you understood…)<input type="text" name="notes" placeholder="optional"></label>
          <button class="btn primary">Log it</button>
        </form></div>
      <div class="card"><h2>History</h2><ul class="list" id="ll"></ul></div>
      <div class="card"><h2>Ideas — American English</h2><ul class="list">${D.listeningSuggestions.map(([k, v]) => `<li><span class="chip listening">${k}</span> <span class="small">${esc(v)}</span></li>`).join('')}</ul>
        <p class="small muted" style="margin-top:8px">Tip: watch with English subtitles first, then rewatch a 2-minute scene with no subtitles and shadow it.</p></div>`;
    $('#goal', root).onchange = (e) => { S.settings.listeningGoal = Math.max(30, +e.target.value || 210); save(); route(); };
    $('#lf', root).onsubmit = (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      S.listening.push({ id: uid(), date: f.get('date'), type: f.get('type'), minutes: +f.get('minutes'), title: f.get('title').trim(), notes: f.get('notes').trim() });
      save(); toast('Logged'); route();
    };
    const list = S.listening.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 100);
    $('#ll', root).innerHTML = list.map((l) => `<li><div style="flex:1;min-width:200px"><b>${esc(l.title)}</b> <span class="chip listening">${esc(l.type)}</span>
      <div class="small muted">${fmtDate(l.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${l.minutes} min${l.notes ? ' · ' + esc(l.notes) : ''}</div></div>
      <button class="btn sm ghost danger" data-dell="${l.id}">${icon('trash')}</button></li>`).join('') || '<li class="empty">Nothing logged yet.</li>';
    $$('[data-dell]', root).forEach((b) => b.onclick = () => { if (!confirm('Delete this entry?')) return; S.listening = S.listening.filter((x) => x.id !== b.dataset.dell); save(); route(); });
  };

  // WRITING
  const wr = { task: 'task2', idx: null, running: false, elapsed: 0, startedAt: 0, timer: null };
  VIEWS.writing = (root) => {
    const d = S.draft && S.draft.task === wr.task ? S.draft : null;
    const arr = D.writing[wr.task];
    if (d && wr.idx == null) wr.idx = d.idx;
    if (wr.idx == null || wr.idx >= arr.length) wr.idx = rand(arr.length);
    const p = arr[wr.idx]; const pText = typeof p === 'string' ? p : p.q;
    const limitMin = wr.task === 'task1' ? 20 : 40; const target = wr.task === 'task1' ? 150 : 250;
    root.innerHTML = `
      <div class="page-head"><div><h1>Writing practice</h1><p class="muted">Timed IELTS tasks with a word counter and a self-review checklist.</p></div></div>
      <div class="card">
        <div class="row"><div class="seg" id="wt"><button data-t="task1" class="${wr.task === 'task1' ? 'on' : ''}">Task 1 · 20 min</button><button data-t="task2" class="${wr.task === 'task2' ? 'on' : ''}">Task 2 · 40 min</button></div>
          <span class="spacer"></span><button class="btn" id="np">${icon('refresh')} New prompt</button></div>
        <p style="margin:16px 0 8px;font-weight:600">${esc(pText)}</p>
        ${p.table ? `<div class="table-wrap"><table class="data">${p.table.map((r, i) => `<tr>${r.map((c) => i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`).join('')}</tr>`).join('')}</table></div>` : ''}
        <p class="small muted" style="margin:8px 0 0">${wr.task === 'task1'
          ? 'Structure: Introduction (paraphrase) → Overview (2 main trends) → Body 1 → Body 2. No opinions.'
          : 'Structure: Introduction + clear position → Body 1 (main idea + example) → Body 2 → Conclusion restating your view.'}</p>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:10px">
          <div><div class="timer-phase">Time</div><div class="timer" id="wclock" style="font-size:2rem">${fmtSec(limitMin * 60)}</div></div>
          <button class="btn primary" id="wgo">${wr.running ? 'Pause' : 'Start'}</button><button class="btn" id="wreset">Reset</button>
          <span class="spacer"></span>
          <div style="text-align:right"><div class="timer-phase">Words</div><div class="timer" id="wc" style="font-size:2rem">0</div><div class="small muted">target ${target}+</div></div>
        </div>
        <textarea id="txt" rows="16" placeholder="Start writing here… (your draft is saved automatically)">${esc(d ? d.text : '')}</textarea>
      </div>
      <div class="card"><h2>Self-review checklist</h2>
        <div id="chk">${D.writing.checklist.map(([k, l]) => `<label class="task" style="padding:9px 12px"><input type="checkbox" class="check" data-c="${k}" ${d?.checks?.[k] ? 'checked' : ''}><span class="small">${esc(l)}</span></label>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="wsave">Save to history</button><span class="small muted">Saves the essay, word count and time spent (counts toward Writing minutes).</span></div>
      </div>
      <div class="card"><h2>History</h2><div id="wh"></div></div>`;

    const txt = $('#txt', root), wc = $('#wc', root), clock = $('#wclock', root), go = $('#wgo', root);
    const elapsed = () => wr.elapsed + (wr.running ? (Date.now() - wr.startedAt) / 1000 : 0);
    const draw = () => {
      const left = limitMin * 60 - elapsed();
      clock.textContent = (left < 0 ? '+' : '') + fmtSec(Math.abs(left));
      clock.style.color = left < 0 ? 'var(--danger)' : left < 300 ? 'var(--warn)' : '';
    };
    const count = () => { const n = wordCount(txt.value); wc.textContent = n; wc.style.color = n >= target ? 'var(--ok)' : ''; };
    let keepDraft = true;
    const persist = () => {
      if (!keepDraft) return;
      const checks = {}; $$('[data-c]', root).forEach((c) => { if (c.checked) checks[c.dataset.c] = true; });
      S.draft = { task: wr.task, idx: wr.idx, text: txt.value, checks }; save();
    };
    count(); draw();
    if (wr.running) wr.timer = setInterval(draw, 500);
    txt.oninput = () => { count(); clearTimeout(wr.st); wr.st = setTimeout(persist, 400); };
    $$('[data-c]', root).forEach((c) => c.onchange = persist);
    go.onclick = () => {
      if (wr.running) { wr.elapsed = elapsed(); wr.running = false; clearInterval(wr.timer); go.textContent = 'Resume'; }
      else { wr.startedAt = Date.now(); wr.running = true; wr.timer = setInterval(draw, 500); go.textContent = 'Pause'; txt.focus(); }
    };
    $('#wreset', root).onclick = () => { clearInterval(wr.timer); wr.running = false; wr.elapsed = 0; go.textContent = 'Start'; draw(); };
    const switchTo = (fn) => {
      if (txt.value.trim() && !confirm('Discard the current draft?')) return;
      S.draft = null; keepDraft = false; save(); clearInterval(wr.timer); wr.running = false; wr.elapsed = 0; fn(); route();
    };
    $$('#wt button', root).forEach((b) => b.onclick = () => b.dataset.t !== wr.task && switchTo(() => { wr.task = b.dataset.t; wr.idx = null; }));
    $('#np', root).onclick = () => switchTo(() => { wr.idx = (wr.idx + 1 + rand(arr.length - 1)) % arr.length; });
    $('#wsave', root).onclick = () => {
      if (!txt.value.trim()) return toast('Write something first');
      const checks = {}; $$('[data-c]', root).forEach((c) => { if (c.checked) checks[c.dataset.c] = true; });
      let minutes = Math.round(elapsed() / 60);
      if (!minutes) minutes = +prompt('How many minutes did you spend?', String(limitMin)) || 0;
      S.writing.push({ id: uid(), date: today(), task: wr.task, prompt: pText, text: txt.value, words: wordCount(txt.value), minutes, checks });
      S.draft = null; keepDraft = false; clearInterval(wr.timer); wr.running = false; wr.elapsed = 0; wr.idx = null; save(); toast('Saved to history'); route();
    };
    const hist = S.writing.slice().reverse();
    $('#wh', root).innerHTML = hist.length ? hist.map((w) => `<details style="border-bottom:1px solid var(--border);padding:10px 0">
        <summary>${fmtDate(w.date)} · ${w.task === 'task1' ? 'Task 1' : 'Task 2'} · ${w.words} words · ${w.minutes} min · ✓ ${Object.keys(w.checks || {}).length}/${D.writing.checklist.length}</summary>
        <p class="small muted" style="margin-top:8px">${esc(w.prompt)}</p><div style="white-space:pre-wrap" class="small">${esc(w.text)}</div>
        <button class="btn sm danger" data-delw="${w.id}" style="margin-top:8px">${icon('trash')} Delete</button></details>`).join('') : '<div class="empty">No essays yet.</div>';
    $$('[data-delw]', root).forEach((b) => b.onclick = () => { if (!confirm('Delete this essay?')) return; S.writing = S.writing.filter((x) => x.id !== b.dataset.delw); save(); route(); });
    onLeave(() => { if (wr.running) { wr.elapsed = elapsed(); wr.startedAt = Date.now(); } clearInterval(wr.timer); persist(); });
  };

  // STATS
  const BANDS = [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9];
  const overall = (o) => { const a = (o.listening + o.reading + o.writing + o.speaking) / 4; const f = Math.floor(a); const r = a - f; return r < 0.25 ? f : r < 0.75 ? f + 0.5 : f + 1; };
  function barChart(weeks) {
    const W = 640, H = 240, L = 36, B = 28, T = 10, R = 8;
    const totals = weeks.map((w) => SKILLS.reduce((a, s) => a + w.m[s], 0));
    const max = Math.max(60, ...totals); const step = max > 600 ? 200 : max > 300 ? 100 : 60;
    const top = Math.ceil(max / step) * step; const y = (v) => T + (H - T - B) * (1 - v / top);
    const bw = (W - L - R) / weeks.length;
    let g = '';
    for (let v = 0; v <= top; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`;
    weeks.forEach((w, i) => {
      let acc = 0; const x = L + i * bw + bw * 0.18; const width = bw * 0.64;
      SKILLS.forEach((s) => {
        const v = w.m[s]; if (!v) return;
        const y0 = y(acc), y1 = y(acc + v); acc += v;
        g += `<rect x="${x}" y="${y1}" width="${width}" height="${Math.max(0, y0 - y1 - 1)}" rx="2" fill="var(--c-${s})"><title>${fmtDate(w.start)} week — ${SKILL_LABEL[s]}: ${v} min</title></rect>`;
      });
      g += `<text x="${x + width / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="var(--muted)">${fmtDate(w.start)}</text>`;
      if (totals[i]) g += `<text x="${x + width / 2}" y="${y(totals[i]) - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${totals[i]}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Minutes per skill per week">${g}</svg>`;
  }
  function lineChart(points) {
    const W = 640, H = 240, L = 36, B = 28, T = 12, R = 16; const lo = 4, hi = 9;
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (points.length - 1));
    let g = '';
    for (let v = lo; v <= hi; v++) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)" ${v === 7 ? 'stroke-dasharray="4 4" stroke="var(--accent)"' : ''}/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`;
    g += `<text x="${W - R}" y="${y(7) - 5}" text-anchor="end" font-size="10" fill="var(--accent)">C1 ≈ 7.0</text>`;
    ['listening', 'reading', 'writing', 'speaking'].forEach((s) => {
      g += `<polyline fill="none" stroke="var(--c-${s})" stroke-width="2.5" stroke-linejoin="round" points="${points.map((p, i) => `${x(i)},${y(p[s])}`).join(' ')}"/>`;
      points.forEach((p, i) => { g += `<circle cx="${x(i)}" cy="${y(p[s])}" r="3.5" fill="var(--c-${s})"><title>${p.label} — ${SKILL_LABEL[s]}: ${p[s]}</title></circle>`; });
    });
    points.forEach((p, i) => { g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(p.label)}</text>`; });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Self-rated band per skill by month">${g}</svg>`;
  }
  VIEWS.stats = (root) => {
    const t = today(); const st = streaks();
    const n = 10; const thisWeek = weekStartOf(t);
    const weeks = Array.from({ length: n }, (_, i) => {
      const start = addDays(thisWeek, -7 * (n - 1 - i)); const m = Object.fromEntries(SKILLS.map((s) => [s, 0]));
      for (let d = 0; d < 7; d++) { const dm = dayMinutes(addDays(start, d)); SKILLS.forEach((s) => { m[s] += dm[s]; }); }
      return { start, m };
    });
    const allMin = activeDates().reduce((a, d) => { const dm = dayMinutes(d); return a + SKILLS.reduce((x, s) => x + dm[s], 0); }, 0);
    const learned = allVocab().filter((v) => isLearned(v.id)).length;
    const month = t.slice(0, 7);
    const sc = S.selfChecks.find((x) => x.month === month) || {};
    const pts = [{ label: 'Start', ...S.baseline }].concat(S.selfChecks.slice().sort((a, b) => (a.month < b.month ? -1 : 1)).map((c) => ({ ...c, label: parseYmd(c.month + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) })));
    const last = pts[pts.length - 1];
    // last 12 weeks of completed days
    const gridStart = addDays(thisWeek, -7 * 11);
    root.innerHTML = `
      <div class="page-head"><div><h1>Stats</h1><p class="muted">Your effort and your progress, all in one place.</p></div></div>
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="card stat"><div class="num">🔥 ${st.cur}</div><div class="lbl">current streak · best ${st.best}</div></div>
        <div class="card stat"><div class="num">${Math.floor(allMin / 60)}<span class="small muted">h</span> ${allMin % 60}<span class="small muted">m</span></div><div class="lbl">total study time</div></div>
        <div class="card stat"><div class="num">${learned}</div><div class="lbl">words learned</div></div>
        <div class="card stat"><div class="num" id="recN">${recCount}</div><div class="lbl">speaking & shadowing recordings</div></div>
      </div>
      <div class="card"><h2>Minutes per skill per week</h2>${barChart(weeks)}
        <div class="legend">${SKILLS.map((s) => `<span><i class="dot" style="background:var(--c-${s})"></i>${SKILL_LABEL[s]}</span>`).join('')}</div>
        <p class="small muted" style="margin:8px 0 0">Counted from ticked daily tasks, the listening log, timed speaking and saved essays (whichever is larger per day, so nothing is counted twice).</p></div>
      <div class="card"><h2>Consistency · last 12 weeks</h2>
        <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:4px;max-width:420px">${Array.from({ length: 12 }, (_, w) => `<div style="display:grid;gap:4px">${Array.from({ length: 7 }, (_, d) => {
          const day = addDays(gridStart, w * 7 + d); const c = dayDoneCount(day); const fut = day > t;
          const bg = fut ? 'transparent' : c >= 4 ? 'var(--ok)' : c > 0 ? 'color-mix(in srgb, var(--ok) 40%, var(--surface-2))' : 'var(--surface-2)';
          return `<div title="${fmtDate(day)}: ${c} tasks" style="aspect-ratio:1;border-radius:3px;background:${bg}"></div>`;
        }).join('')}</div>`).join('')}</div>
        <div class="legend"><span><i class="dot" style="background:var(--surface-2)"></i>none</span><span><i class="dot" style="background:color-mix(in srgb, var(--ok) 40%, var(--surface-2))"></i>some</span><span><i class="dot" style="background:var(--ok)"></i>streak day (4+)</span></div></div>
      <div class="card"><h2>Monthly self-check</h2>
        <p class="small muted">Once a month, rate yourself honestly (IELTS band). Best after a practice test. Overall now: <b>${overall(last)}</b> (start: ${overall(S.baseline)}, goal: 7.0).</p>
        ${lineChart(pts)}
        <div class="legend">${['listening', 'reading', 'writing', 'speaking'].map((s) => `<span><i class="dot" style="background:var(--c-${s})"></i>${SKILL_LABEL[s]}</span>`).join('')}</div>
        <form id="scf" class="stack" style="margin-top:16px">
          <div class="form-grid">
            <label class="field">Month<input type="month" name="month" value="${month}" required></label>
            ${['listening', 'reading', 'writing', 'speaking'].map((s) => `<label class="field">${SKILL_LABEL[s]}<select name="${s}">${BANDS.map((b) => `<option ${b === (sc[s] ?? last[s]) ? 'selected' : ''}>${b.toFixed(1)}</option>`).join('')}</select></label>`).join('')}
          </div>
          <label class="field">Notes (what improved, what's still hard)<input type="text" name="note" value="${esc(sc.note || '')}"></label>
          <button class="btn primary">Save self-check</button>
        </form>
        <ul class="list" style="margin-top:10px">${S.selfChecks.slice().sort((a, b) => (a.month < b.month ? 1 : -1)).map((c) => `<li><b>${parseYmd(c.month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</b>
          <span class="small">L ${c.listening} · R ${c.reading} · W ${c.writing} · S ${c.speaking} · <b>Overall ${overall(c)}</b></span>
          <span class="spacer"></span><button class="btn sm ghost danger" data-dels="${c.month}">${icon('trash')}</button>${c.note ? `<span class="small muted" style="flex-basis:100%">${esc(c.note)}</span>` : ''}</li>`).join('')}</ul>
      </div>`;
    refreshRecCount().then(() => { const el = $('#recN'); if (el) el.textContent = recCount; });
    $('#scf', root).onsubmit = (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      const entry = { month: f.get('month'), note: f.get('note').trim() };
      ['listening', 'reading', 'writing', 'speaking'].forEach((s) => { entry[s] = +f.get(s); });
      S.selfChecks = S.selfChecks.filter((x) => x.month !== entry.month).concat(entry); save(); toast('Self-check saved'); route();
    };
    $$('[data-dels]', root).forEach((b) => b.onclick = () => { if (!confirm('Delete this self-check?')) return; S.selfChecks = S.selfChecks.filter((x) => x.month !== b.dataset.dels); save(); route(); });
  };

  // SETTINGS & BACKUP
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
  const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  const dataURLToBlob = (u) => { const [h, b64] = u.split(','); const mime = (h.match(/data:([^;]+)/) || [])[1] || 'audio/webm'; const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: mime }); };
  function applyTheme() { if (S.settings.theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = S.settings.theme; }
  VIEWS.settings = (root) => {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    root.innerHTML = `
      <div class="page-head"><div><h1>Backup & settings</h1><p class="muted">Everything is saved in this browser only. Export a backup regularly — and before clearing browser data or changing phones.</p></div></div>
      <div class="card"><h2>Backup</h2>
        <p class="small muted">Last export: ${S.lastExport ? new Date(S.lastExport).toLocaleString('en-US') : 'never'}</p>
        <label class="row small" style="gap:6px;margin-bottom:10px"><input type="checkbox" id="withAudio" checked> Include voice recordings (bigger file)</label>
        <div class="row"><button class="btn primary" id="exp">${icon('download')} Export backup</button>
          <label class="btn">Import backup<input type="file" id="imp" accept="application/json,.json" hidden></label></div>
        <p class="small muted" style="margin:10px 0 0">Import replaces the data in this browser with the backup file.</p></div>
      <div class="card"><h2>Plan</h2>
        <div class="form-grid">
          <label class="field">Start date (week 1)<input type="date" id="start" value="${S.startDate}"></label>
          <label class="field">Weekly listening goal (min)<input type="number" id="lg" min="30" step="30" value="${S.settings.listeningGoal}"></label>
          <label class="field">New words per day<input type="number" id="npd" min="0" max="50" value="${S.settings.newPerDay}"></label>
          <label class="field">Theme<select id="theme">${['auto', 'light', 'dark'].map((x) => `<option ${x === S.settings.theme ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        </div>
        <h3 style="margin-top:16px">Starting scores (IELTS)</h3>
        <div class="form-grid">${['listening', 'reading', 'writing', 'speaking'].map((s) => `<label class="field">${SKILL_LABEL[s]}<select data-base="${s}">${BANDS.map((b) => `<option ${b === S.baseline[s] ? 'selected' : ''}>${b.toFixed(1)}</option>`).join('')}</select></label>`).join('')}</div>
      </div>
      <div class="card"><h2>Install the app</h2>
        ${standalone ? '<p class="small">✅ Running as an installed app. Works offline.</p>' : `
        <p class="small">Install it on your phone or computer for quick access and offline use.</p>
        <button class="btn" id="inst" ${installEvt ? '' : 'hidden'}>Install Road to C1</button>
        <ul class="small muted" style="padding-left:18px;margin:8px 0 0"><li><b>iPhone/iPad (Safari):</b> Share → Add to Home Screen</li><li><b>Android (Chrome):</b> ⋮ menu → Install app / Add to Home screen</li><li><b>Desktop (Chrome/Edge):</b> install icon in the address bar</li></ul>`}
      </div>
      <div class="card"><h2>Danger zone</h2><button class="btn danger" id="reset">${icon('trash')} Erase all data</button></div>
      <p class="small muted" style="text-align:center">Road to C1 · works offline · your data never leaves this device</p>`;
    $('#start', root).onchange = (e) => { if (e.target.value) { S.startDate = e.target.value; save(); toast('Start date saved'); } };
    $('#lg', root).onchange = (e) => { S.settings.listeningGoal = Math.max(30, +e.target.value || 210); save(); };
    $('#npd', root).onchange = (e) => { S.settings.newPerDay = Math.max(0, Math.min(50, +e.target.value || 0)); save(); };
    $('#theme', root).onchange = (e) => { S.settings.theme = e.target.value; save(); applyTheme(); };
    $$('[data-base]', root).forEach((s) => s.onchange = () => { S.baseline[s.dataset.base] = +s.value; save(); });
    const inst = $('#inst', root); if (inst) inst.onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; route(); };
    $('#exp', root).onclick = async () => {
      const btn = $('#exp', root); btn.disabled = true; btn.textContent = 'Preparing…';
      try {
        S.lastExport = new Date().toISOString(); save();
        const data = { app: 'road-to-c1', exportedAt: S.lastExport, state: S, recordings: [] };
        if ($('#withAudio', root).checked) {
          for (const r of await idb.all()) data.recordings.push({ ...r, blob: await blobToDataURL(r.blob) });
        }
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `road-to-c1-backup-${today()}.json`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast('Backup downloaded');
      } catch (e) { toast('Export failed: ' + e.message); }
      route();
    };
    $('#imp', root).onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.app !== 'road-to-c1' || !data.state) throw new Error('Not a Road to C1 backup');
        if (!confirm(`Replace all current data with the backup from ${new Date(data.exportedAt).toLocaleString('en-US')}?`)) return;
        S = Object.assign(defaultState(), data.state); S.settings = Object.assign(defaultState().settings, S.settings); save();
        if (data.recordings?.length) { await idb.clear(); for (const r of data.recordings) await idb.put({ ...r, blob: dataURLToBlob(r.blob) }); }
        await refreshRecCount(); applyTheme(); toast('Backup restored'); location.hash = '#today'; route();
      } catch (err) { toast('Import failed: ' + err.message); }
    };
    $('#reset', root).onclick = async () => {
      if (!confirm('Erase ALL your progress, words, logs and recordings? This cannot be undone.')) return;
      if (prompt('Type ERASE to confirm') !== 'ERASE') return;
      localStorage.removeItem(STORE_KEY); await idb.clear().catch(() => {}); load(); recCount = 0; applyTheme(); toast('All data erased'); location.hash = '#today';
    };
  };

  // ---------- boot ----------
  applyTheme();
  if (!localStorage.getItem(STORE_KEY)) save();
  refreshRecCount();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  route();
})();
