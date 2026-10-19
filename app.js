(function(){
  // The page and this script are cached separately, so right after an update a browser can pair
  // an old cached page with this script. Reload once to get the matching page rather than run
  // against markup this script doesn't know. Keep BUILD equal to data-build in index.html.
  const BUILD = '2';
  try {
    if(document.documentElement.getAttribute('data-build') !== BUILD){
      // A reload has just re-checked the page with the server, so another one can't help
      const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      if((!nav || nav.type !== 'reload') && sessionStorage.getItem('alist_build_reload') !== BUILD){
        sessionStorage.setItem('alist_build_reload', BUILD);
        location.reload();
        return;
      }
    } else {
      sessionStorage.removeItem('alist_build_reload');
    }
  } catch(e){ /* sessionStorage blocked: carry on without the safety reload */ }

  const LS_MOVIES = 'alist_ledger_movies';
  const LS_SUB = 'alist_ledger_subscription';
  const LS_KEY = 'alist_ledger_tmdb_key';
  const LS_THEME = 'alist_ledger_theme';
  const TMDB_BASE = 'https://api.themoviedb.org/3';
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w200';
  const DEFAULT_MONTHLY_PRICE = 23.95;

  const $ = (id) => document.getElementById(id);
  const fmtMoney = (n) => `$${n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
  const fmtHours = (totalMinutes) => {
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  };
  const fmtTime = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  let selectedMovie = null; // holds TMDB metadata for the movie currently in the form
  let searchDebounce = null;
  let searchSeq = 0;  // bumped to make any pending or in-flight title search stale
  let pickSeq = 0;    // bumped to make a pending search pick's details stale
  let activeSuggestions = [];
  let activeIndex = -1;
  const searchCache = new Map();  // query (lowercased) -> results array
  const detailCache = new Map();  // tmdb id -> detail object

  let editingId = null;         // id of the stub loaded into the form for editing
  let preEditTheater = null;    // theater field value to restore once editing ends
  let seatTheaterKey = null;    // theater currently shown in the seat heatmap
  let subDraft = [];            // billing periods being edited, saved on "Save Subscription Info"

  function getTmdbKey(){ return (localStorage.getItem(LS_KEY) || '').trim(); }

  $('settingsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('settingsDropdown');
    const isOpen = dd.classList.toggle('open');
    $('settingsBtn').setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if(isOpen && pendingImport) renderImportReview(); // this device's movies may have changed since the file was picked
  });
  document.addEventListener('click', (e) => {
    if(!e.target.closest('#settingsDropdown') && !e.target.closest('#settingsBtn')){
      $('settingsDropdown').classList.remove('open');
      $('settingsBtn').setAttribute('aria-expanded', 'false');
    }
  });

  function getTheme(){
    const stored = localStorage.getItem(LS_THEME);
    return stored === 'dark' ? 'dark' : 'light'; // light is the default
  }
  function applyTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-theme-value') === theme);
    });
  }
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-theme-value');
      localStorage.setItem(LS_THEME, theme);
      applyTheme(theme);
    });
  });
  applyTheme(getTheme());

  $('saveKeyBtn').addEventListener('click', () => {
    localStorage.setItem(LS_KEY, $('tmdbKey').value.trim());
    $('saveKeyBtn').textContent = 'Saved ✓';
    setTimeout(() => $('saveKeyBtn').textContent = 'Save Key', 1200);
  });
  (function initKeyField(){ $('tmdbKey').value = getTmdbKey(); })();

  async function searchMovies(query){
    const key = getTmdbKey();
    if(!key || !query.trim()) return [];
    const cacheKey = query.trim().toLowerCase();
    if(searchCache.has(cacheKey)) return searchCache.get(cacheKey);
    const url = `${TMDB_BASE}/search/movie?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&include_adult=false`;
    let res;
    try {
      res = await fetch(url);
    } catch(networkErr){
      throw new Error('NETWORK: could not reach TMDB — check your connection, or an ad-blocker/privacy extension may be blocking the request.');
    }
    if(!res.ok){
      if(res.status === 401){
        throw new Error('AUTH: TMDB rejected the API key (401 Unauthorized). Double-check the key saved below, or it may not be active yet.');
      }
      throw new Error(`HTTP: TMDB returned an error (status ${res.status}).`);
    }
    const data = await res.json();
    const results = (data.results || []).slice(0, 8);
    searchCache.set(cacheKey, results);
    return results;
  }

  async function fetchMovieDetail(id){
    if(detailCache.has(id)) return detailCache.get(id);
    const key = getTmdbKey();
    const [detailRes, creditsRes] = await Promise.all([
      fetch(`${TMDB_BASE}/movie/${id}?api_key=${encodeURIComponent(key)}`),
      fetch(`${TMDB_BASE}/movie/${id}/credits?api_key=${encodeURIComponent(key)}`)
    ]);
    const detail = detailRes.ok ? await detailRes.json() : {};
    const credits = creditsRes.ok ? await creditsRes.json() : {};
    const director = (credits.crew || []).find(c => c.job === 'Director');
    const result = {
      tmdbId: id,
      title: detail.title || '',
      posterPath: detail.poster_path || '',
      releaseDate: detail.release_date || '',
      runtime: detail.runtime || null,
      genres: (detail.genres || []).map(g => g.name),
      rating: detail.vote_average || null,
      director: director ? director.name : ''
    };
    detailCache.set(id, result);
    return result;
  }

  function renderDropdown(results){
    activeSuggestions = results;
    activeIndex = -1;
    const dd = $('titleDropdown');
    if(!results.length){
      dd.innerHTML = getTmdbKey()
        ? '<div class="dd-empty">No matches found.</div>'
        : '<div class="dd-empty">Add a TMDB API key below to enable search.</div>';
      dd.classList.add('open');
      return;
    }
    dd.innerHTML = results.map((r, i) => {
      const year = (r.release_date || '').slice(0,4);
      const img = r.poster_path
        ? `<img src="${TMDB_IMG}${r.poster_path}" alt="" loading="lazy">`
        : `<div class="dd-noimg"></div>`;
      return `<div class="dd-item" data-index="${i}">
        ${img}
        <div>
          <div class="dd-title">${escapeHtml(r.title)}</div>
          <div class="dd-year">${year || '—'}</div>
        </div>
      </div>`;
    }).join('');
    dd.classList.add('open');
    dd.querySelectorAll('.dd-item').forEach(el => {
      el.addEventListener('click', () => selectSuggestion(Number(el.getAttribute('data-index'))));
    });
  }

  function renderDropdownError(message){
    const dd = $('titleDropdown');
    dd.innerHTML = `<div class="dd-empty" style="color:var(--red-dark);">${escapeHtml(message)}</div>`;
    dd.classList.add('open');
    activeSuggestions = []; // so Enter can't pick a suggestion that is no longer shown
    activeIndex = -1;
  }

  function cancelPendingSearch(){
    clearTimeout(searchDebounce);
    searchSeq++;
  }

  function closeDropdown(){
    $('titleDropdown').classList.remove('open');
    $('titleDropdown').innerHTML = '';
  }

  async function selectSuggestion(index){
    const picked = activeSuggestions[index];
    if(!picked) return;
    cancelPendingSearch(); // a search still running for the typed text would reopen the list
    closeDropdown();
    $('movieTitle').value = picked.title;
    // Drop the old details right away, so saving before the new ones load can't mix the two movies
    selectedMovie = null;
    renderSelectedMeta();
    const seq = ++pickSeq;
    const detail = await fetchMovieDetail(picked.id);
    // A slow answer is ignored once a newer pick, a save, another stub, or add-mode typing replaced it
    if(seq !== pickSeq) return;
    selectedMovie = detail;
    renderSelectedMeta();
  }

  function renderSelectedMeta(){
    const box = $('selectedMeta');
    if(!selectedMovie){
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    const m = selectedMovie;
    const img = m.posterPath ? `<img src="${TMDB_IMG}${m.posterPath}" alt="" loading="lazy">` : '';
    const bits = [];
    if(m.director) bits.push(`<strong>Dir.</strong> ${escapeHtml(m.director)}`);
    if(m.genres.length) bits.push(escapeHtml(m.genres.join(', ')));
    if(m.runtime) bits.push(`${m.runtime} min`);
    if(m.rating) bits.push(`★ ${m.rating.toFixed(1)}`);
    if(m.releaseDate) bits.push(m.releaseDate.slice(0,4));
    box.style.display = 'flex';
    box.innerHTML = `${img}<div class="selected-meta-text">${bits.join(' · ')}</div>
      <button type="button" class="selected-meta-clear" id="clearMetaBtn">clear</button>`;
    $('clearMetaBtn').addEventListener('click', () => {
      selectedMovie = null;
      renderSelectedMeta();
    });
  }

  $('movieTitle').addEventListener('input', () => {
    // Typing invalidates a previous pick, but a stub being edited keeps its details
    // until another movie is picked from search or "clear" is pressed
    if(!editingId){
      selectedMovie = null;
      pickSeq++;
      renderSelectedMeta();
    }
    const query = $('movieTitle').value;
    cancelPendingSearch();
    if(!query.trim()){ closeDropdown(); return; }
    const seq = searchSeq;
    searchDebounce = setTimeout(async () => {
      try {
        const results = await searchMovies(query);
        if(seq !== searchSeq) return; // newer typing, a pick, or a save made this search stale
        renderDropdown(results);
      } catch(err){
        console.error('TMDB search failed:', err);
        if(seq !== searchSeq) return;
        renderDropdownError(err.message.replace(/^(NETWORK|AUTH|HTTP): /, ''));
      }
    }, 350);
  });

  $('movieTitle').addEventListener('keydown', (e) => {
    const dd = $('titleDropdown');
    if(!dd.classList.contains('open')) return;
    const items = dd.querySelectorAll('.dd-item');
    if(e.key === 'ArrowDown'){
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      items.forEach((el,i) => el.classList.toggle('active', i === activeIndex));
    } else if(e.key === 'ArrowUp'){
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      items.forEach((el,i) => el.classList.toggle('active', i === activeIndex));
    } else if(e.key === 'Enter' && activeIndex >= 0){
      e.preventDefault();
      selectSuggestion(activeIndex);
    } else if(e.key === 'Escape'){
      closeDropdown();
    }
  });

  document.addEventListener('click', (e) => {
    if(!e.target.closest('#movieTitle') && !e.target.closest('#titleDropdown')){
      closeDropdown();
    }
  });

  function updateSubmitLabel(){
    $('addMovieBtn').textContent = editingId ? 'Save Changes' : 'Add Ticket Stub';
  }

  // Tickets print seats like "F12", so accept that typed straight into the row box
  function splitSeatInput(){
    const raw = $('seatRow').value;
    const match = /^\s*([A-Za-z]{1,2})\s*-?\s*(\d{1,2})\s*$/.exec(raw);
    if(match){
      $('seatRow').value = match[1].toUpperCase();
      $('seatNumber').value = match[2];
    } else {
      $('seatRow').value = raw.trim().toUpperCase();
    }
  }
  $('seatRow').addEventListener('change', splitSeatInput);

  function loadMovies(){
    try { return JSON.parse(localStorage.getItem(LS_MOVIES)) || []; }
    catch(e){ return []; }
  }
  function saveMovies(movies){
    localStorage.setItem(LS_MOVIES, JSON.stringify(movies));
  }
  function loadSub(){
    let raw;
    try { raw = JSON.parse(localStorage.getItem(LS_SUB)); }
    catch(e){ raw = null; }
    return subFromRaw(raw);
  }
  function subFromRaw(raw){
    if(raw && Array.isArray(raw.periods)) return { periods: raw.periods };
    // Older saves held one monthly cost, assumed billed every month since a single start date
    if(raw && (raw.startDate || raw.monthlyCost != null)){
      return { periods: [{ start: raw.startDate || '', end: '', price: Number(raw.monthlyCost) || 0 }] };
    }
    return { periods: [] };
  }
  function saveSub(sub){
    localStorage.setItem(LS_SUB, JSON.stringify(sub));
  }

  // Parses YYYY-MM-DD as a local date (new Date('YYYY-MM-DD') would read it as UTC midnight)
  function parseDate(str){
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function billDateInMonth(year, month, day){
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(day, daysInMonth)); // Jan 31 bills on Feb 28
  }

  // Counts monthly bills from a period's start through its end (or today, if still active)
  function periodCycles(period){
    const start = parseDate(period.start);
    if(!start) return { count: 0, last: null };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = parseDate(period.end);
    const limit = end && end < today ? end : today;
    if(start > limit) return { count: 0, last: null };
    let count = (limit.getFullYear() - start.getFullYear()) * 12 + (limit.getMonth() - start.getMonth());
    const billThisMonth = billDateInMonth(limit.getFullYear(), limit.getMonth(), start.getDate());
    if(limit >= billThisMonth) count += 1; // count the cycle billed in the limit's month once its day arrives
    const last = billDateInMonth(start.getFullYear(), start.getMonth() + count - 1, start.getDate());
    return { count, last };
  }

  function subscriptionCost(periods){
    return periods.reduce((sum, p) => sum + (parseFloat(p.price) || 0) * periodCycles(p).count, 0);
  }

  // Returns the draft indexes of the first two periods that bill the same stretch of time
  function findOverlap(periods){
    const spans = periods
      .map((p, i) => ({ i, start: parseDate(p.start), last: periodCycles(p).last }))
      .filter(s => s.start && s.last)
      .sort((a, b) => a.start - b.start);
    let reach = spans[0];
    for(let k = 1; k < spans.length; k++){
      if(spans[k].start <= reach.last) return [reach.i, spans[k].i].sort((a, b) => a - b);
      if(spans[k].last > reach.last) reach = spans[k];
    }
    return null;
  }

  // Drops untouched rows and sorts oldest first so the saved list reads in order
  function normalizePeriods(periods){
    return periods
      .filter(p => p.start || p.end)
      .map(p => ({ start: p.start || '', end: p.end || '', price: parseFloat(p.price) || 0 }))
      .sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));
  }

  function initSubDraft(){
    subDraft = loadSub().periods.map(p => ({ ...p }));
    if(!subDraft.length) subDraft.push({ start: '', end: '', price: DEFAULT_MONTHLY_PRICE });
  }

  function renderPeriodEditor(){
    const list = $('periodList');
    list.innerHTML = subDraft.map((p, i) => `
      <div class="period">
        <div class="period-head">
          <span class="period-title">Period ${i + 1}</span>
          ${subDraft.length > 1 ? `<button type="button" class="period-remove" data-remove="${i}">Remove</button>` : ''}
        </div>
        <div class="row-2">
          <div class="field">
            <label for="periodStart${i}">From</label>
            <input type="date" id="periodStart${i}" data-index="${i}" data-field="start" value="${escapeAttr(p.start || '')}">
          </div>
          <div class="field">
            <label for="periodEnd${i}">To</label>
            <input type="date" id="periodEnd${i}" data-index="${i}" data-field="end" value="${escapeAttr(p.end || '')}">
          </div>
        </div>
        <div class="field">
          <label for="periodPrice${i}">Monthly price ($)</label>
          <input type="number" id="periodPrice${i}" data-index="${i}" data-field="price" step="0.01" min="0" placeholder="${DEFAULT_MONTHLY_PRICE}" value="${escapeAttr(String(p.price ?? ''))}">
        </div>
        <div class="period-summary" id="periodSummary${i}"></div>
      </div>`).join('');

    list.querySelectorAll('[data-field]').forEach(input => {
      input.addEventListener('input', () => {
        subDraft[Number(input.getAttribute('data-index'))][input.getAttribute('data-field')] = input.value;
        updatePeriodSummaries();
      });
    });
    list.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        subDraft.splice(Number(btn.getAttribute('data-remove')), 1);
        renderPeriodEditor();
      });
    });
    updatePeriodSummaries();
  }

  function updatePeriodSummaries(){
    subDraft.forEach((p, i) => {
      const el = $(`periodSummary${i}`);
      if(!el) return;
      const start = parseDate(p.start);
      const end = parseDate(p.end);
      const { count } = periodCycles(p);
      if(!start) el.textContent = 'Pick the date of your first bill in this period.';
      else if(end && end < start) el.textContent = 'The To date is before the From date.';
      else if(!count) el.textContent = 'Starts in the future, so nothing billed yet.';
      else el.textContent = `${plural(count, 'cycle')} · ${fmtMoney(count * (parseFloat(p.price) || 0))}${p.end ? '' : ' · active'}`;
    });

    const hint = $('cyclesHint');
    const overlap = findOverlap(subDraft);
    const unsaved = JSON.stringify(normalizePeriods(subDraft)) !== JSON.stringify(normalizePeriods(loadSub().periods));
    const totalCycles = subDraft.reduce((sum, p) => sum + periodCycles(p).count, 0);
    let text = totalCycles
      ? `${plural(totalCycles, 'billing cycle')} so far · ${fmtMoney(subscriptionCost(subDraft))} total.`
      : '';
    if(overlap) text = `Periods ${overlap[0] + 1} and ${overlap[1] + 1} overlap, so those months are billed twice. ${text}`;
    if(unsaved) text = `${text} Not saved yet.`.trim();
    hint.textContent = text;
    hint.classList.toggle('hint-warn', Boolean(overlap));
  }

  $('addPeriodBtn').addEventListener('click', () => {
    const last = subDraft[subDraft.length - 1];
    subDraft.push({ start: '', end: '', price: last ? last.price : DEFAULT_MONTHLY_PRICE });
    renderPeriodEditor();
    $(`periodStart${subDraft.length - 1}`).focus();
  });

  function theaterKey(name){ return (name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

  // Groups movies by the theater they were watched at, most-visited first
  function computeLocationStats(movies){
    const theaters = new Map(); // theaterKey -> { key, name, count, value }
    let unset = 0;
    movies.forEach(m => {
      const key = theaterKey(m.theater);
      if(!key){ unset += 1; return; }
      const t = theaters.get(key) || { key, name: '', count: 0, value: 0 };
      t.name = m.theater.trim(); // most recently logged spelling wins
      t.count += 1;
      t.value += Number(m.price || 0) + Number(m.fee || 0);
      theaters.set(key, t);
    });
    const sorted = [...theaters.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { theaters: sorted, unset };
  }

  function renderLocationStats(movies){
    const box = $('locationStats');
    const { theaters, unset } = computeLocationStats(movies);
    if(!theaters.length){
      box.innerHTML = movies.length
        ? '<div class="empty-state">None of your movies have a location yet. Use Edit on a ticket stub to add the theater you saw it at.</div>'
        : '<div class="empty-state">Log a movie with its theater to see where you watch the most.</div>';
      return;
    }

    const topCount = theaters[0].count;
    const top = theaters.filter(t => t.count === topCount);
    let topName;
    let topDetail;
    if(top.length === 1){
      topName = escapeHtml(top[0].name);
      topDetail = `${plural(topCount, 'movie')} · ${fmtMoney(top[0].value)} in tickets`;
    } else {
      topName = top.length === 2
        ? `${escapeHtml(top[0].name)} &amp; ${escapeHtml(top[1].name)}`
        : `${top.length} theaters tied`;
      topDetail = `${plural(topCount, 'movie')} each`;
    }

    const rows = theaters.map(t => ({ name: t.name, count: t.count, isTop: t.count === topCount }));
    const max = topCount;

    box.innerHTML = `
      <div class="highlight">
        <div class="highlight-label">Most visited theater</div>
        <div class="highlight-name">${topName}</div>
        <div class="highlight-detail">${topDetail}</div>
      </div>
      <div class="loc-list">
        ${rows.map(r => `
          <div class="loc-row" title="${escapeAttr(r.name)}: ${plural(r.count, 'movie')}">
            <div class="loc-name">${escapeHtml(r.name)}</div>
            <div class="loc-bar-line">
              <div class="loc-bar${r.isTop ? ' top' : ''}" style="width:${(r.count / max) * 85}%"></div>
              <span class="loc-count">${r.count}</span>
            </div>
          </div>`).join('')}
      </div>
      ${unset ? `<div class="hint" style="margin-top:14px;">${plural(unset, 'movie')} ${unset === 1 ? 'has' : 'have'} no location yet. Use Edit on a ticket stub to add one.</div>` : ''}
    `;
  }

  // Row letters count like spreadsheet columns: A=1 ... Z=26, AA=27
  function rowToIndex(letters){
    return letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  }
  function indexToRow(n){
    let s = '';
    while(n > 0){
      s = String.fromCharCode(65 + (n - 1) % 26) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function seatLabel(m){ return m.seatRow && m.seatNumber ? `${m.seatRow}${m.seatNumber}` : ''; }

  // Seat counts per theater; each grid spans row A..furthest row and seat 1..highest seat logged there
  function computeSeatData(movies){
    const byTheater = new Map();
    movies.forEach(m => {
      const key = theaterKey(m.theater);
      if(!key || !seatLabel(m)) return;
      const t = byTheater.get(key) || { key, name: '', seats: new Map(), total: 0, maxRow: 0, maxSeat: 0 };
      t.name = m.theater.trim();
      t.seats.set(seatLabel(m), (t.seats.get(seatLabel(m)) || 0) + 1);
      t.total += 1;
      t.maxRow = Math.max(t.maxRow, rowToIndex(m.seatRow));
      t.maxSeat = Math.max(t.maxSeat, Number(m.seatNumber));
      byTheater.set(key, t);
    });
    return [...byTheater.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  function renderSeatMap(movies){
    const theaters = computeSeatData(movies);
    const select = $('seatTheater');
    const box = $('seatMap');
    if(!theaters.length){
      select.style.display = 'none';
      seatTheaterKey = null;
      box.innerHTML = '<div class="empty-state">Add the row and seat number from your ticket when you log a theater movie to see where you sit the most.</div>';
      return;
    }

    if(!theaters.some(t => t.key === seatTheaterKey)) seatTheaterKey = theaters[0].key;
    select.innerHTML = '';
    theaters.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.name;
      select.appendChild(opt);
    });
    select.value = seatTheaterKey;
    // Only offer the picker once there's more than one theater to switch between
    select.style.display = theaters.length > 1 ? '' : 'none';

    const t = theaters.find(x => x.key === seatTheaterKey);
    const max = Math.max(...t.seats.values());
    const lastRow = indexToRow(t.maxRow);
    const labelEvery = t.maxSeat > 20 ? 5 : t.maxSeat > 12 ? 2 : 1; // keep seat numbers from colliding

    let cells = `<div></div><div class="seat-screen" style="grid-column:2 / span ${t.maxSeat};">Screen</div>`;
    for(let r = 1; r <= t.maxRow; r++){
      const row = indexToRow(r);
      cells += `<div class="seat-row-label">${row}</div>`;
      for(let s = 1; s <= t.maxSeat; s++){
        const count = t.seats.get(`${row}${s}`) || 0;
        const level = count ? Math.max(1, Math.ceil((count / max) * 4)) : 0;
        cells += `<div class="seat-cell" data-level="${level}" title="Seat ${row}${s}${count ? `: ${plural(count, 'movie')}` : ''}"></div>`;
      }
    }
    cells += '<div></div>';
    for(let s = 1; s <= t.maxSeat; s++){
      cells += `<div class="seat-num-label">${s === 1 || s % labelEvery === 0 ? s : ''}</div>`;
    }

    const topSeats = [...t.seats.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))
      .slice(0, 6);

    box.innerHTML = `
      <div class="seat-caption">${escapeHtml(t.name)} · ${plural(t.total, 'seat')} logged · rows A-${lastRow}, seats 1-${t.maxSeat}</div>
      <div class="seat-scroll">
        <div class="seat-grid" style="grid-template-columns:22px repeat(${t.maxSeat}, minmax(10px, 26px));">${cells}</div>
      </div>
      <div class="seat-legend">
        <span>Fewer</span><i data-level="1"></i><i data-level="2"></i><i data-level="3"></i><i data-level="4"></i><span>More</span>
        <span class="seat-legend-note">darkest = ${plural(max, 'movie')} in one seat</span>
      </div>
      <div class="seat-top">
        <div class="seat-top-label">${max > 1 ? 'Most-used seats' : 'Seats logged'}</div>
        ${topSeats.map(([label, count]) => `<span class="seat-chip"><strong>${label}</strong> ${plural(count, 'movie')}</span>`).join('')}
      </div>
      <div class="hint">Row A is the front. The grid grows as you log seats further back or further along a row.</div>
    `;
  }
  $('seatTheater').addEventListener('change', () => {
    seatTheaterKey = $('seatTheater').value;
    renderSeatMap(loadMovies());
  });

  function renderTheaterOptions(movies){
    const list = $('theaterList');
    list.innerHTML = '';
    computeLocationStats(movies).theaters.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      list.appendChild(opt);
    });
  }

  const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  let selectedYear = null; // currently displayed year in the month chart

  function computeYearData(movies){
    const byYear = {};
    movies.forEach(m => {
      if(!m.date) return;
      const parts = m.date.split('-').map(Number);
      if(parts.length !== 3 || parts.some(isNaN)) return;
      const [year, month] = parts;
      const monthIndex = month - 1;
      if(monthIndex < 0 || monthIndex > 11) return;
      if(!byYear[year]) byYear[year] = new Array(12).fill(0);
      byYear[year][monthIndex] += 1;
    });
    const years = Object.keys(byYear).map(Number).sort((a, b) => b - a); // most recent first
    return { byYear, years };
  }

  function renderMonthChart(movies){
    const { byYear, years } = computeYearData(movies);
    const nav = $('yearNav');

    if(years.length === 0){
      $('monthChart').innerHTML = '<div class="empty-state">No dated movies logged yet — add a "date seen" to see this chart.</div>';
      $('yearLabel').textContent = '—';
      nav.style.display = 'none';
      selectedYear = null;
      return;
    }

    if(selectedYear === null || !years.includes(selectedYear)){
      selectedYear = years[0]; // default to most recent year with data
    }
    const idx = years.indexOf(selectedYear);
    const counts = byYear[selectedYear];
    const total = counts.reduce((s, c) => s + c, 0);
    const max = Math.max(...counts, 1);

    $('monthChart').innerHTML = counts.map((c, i) => {
      const heightPct = c > 0 ? Math.max((c / max) * 100, 6) : 2;
      return `<div class="month-bar-col" title="${MONTH_LABELS[i]} ${selectedYear}: ${c} movie${c === 1 ? '' : 's'}">
        <div class="month-bar-count">${c || ''}</div>
        <div class="month-bar" style="height:${heightPct}%"></div>
        <div class="month-bar-label">${MONTH_LABELS[i]}</div>
      </div>`;
    }).join('');

    $('yearLabel').textContent = `${selectedYear} · ${total} movie${total === 1 ? '' : 's'}`;

    // Only show the arrows at all once there's more than one year of data to switch between
    nav.style.display = years.length > 1 ? 'flex' : 'none';
    $('yearPrevBtn').disabled = idx >= years.length - 1; // already at the oldest year
    $('yearNextBtn').disabled = idx <= 0; // already at the newest year
  }

  $('yearPrevBtn').addEventListener('click', () => {
    const { years } = computeYearData(loadMovies());
    const idx = years.indexOf(selectedYear);
    if(idx < years.length - 1){
      selectedYear = years[idx + 1];
      renderMonthChart(loadMovies());
    }
  });
  $('yearNextBtn').addEventListener('click', () => {
    const { years } = computeYearData(loadMovies());
    const idx = years.indexOf(selectedYear);
    if(idx > 0){
      selectedYear = years[idx - 1];
      renderMonthChart(loadMovies());
    }
  });

  // Showtimes before 5 AM count toward the night before, so a 12:30 AM show sits after 11 PM
  const DAY_START_HOUR = 5;
  const TIME_SLOTS = [
    { name: 'Morning', range: 'before 12 PM', until: 12 },
    { name: 'Afternoon', range: '12-5 PM', until: 17 },
    { name: 'Evening', range: '5-9 PM', until: 21 },
    { name: 'Late night', range: '9 PM and later', until: 24 + DAY_START_HOUR }
  ];

  function showtimeHour(time){
    if(!/^\d{2}:\d{2}/.test(time || '')) return null;
    const h = Number(time.slice(0, 2));
    return h < DAY_START_HOUR ? h + 24 : h;
  }
  function fmtHour(h){
    const hh = h % 24;
    return `${hh % 12 || 12} ${hh < 12 ? 'AM' : 'PM'}`;
  }
  // "7 and 8 PM", or "11 AM and 12 PM" when the hour crosses noon or midnight
  function fmtHourSpan(h){
    const [startNum, startPeriod] = fmtHour(h).split(' ');
    const end = fmtHour(h + 1);
    return end.endsWith(startPeriod) ? `${startNum} and ${end}` : `${fmtHour(h)} and ${end}`;
  }

  function renderShowtimeStats(movies){
    const box = $('showtimeStats');
    const hours = movies.map(m => showtimeHour(m.time)).filter(h => h !== null);
    if(!hours.length){
      box.innerHTML = movies.length
        ? '<div class="empty-state">None of your movies have a showtime yet. Use Edit on a ticket stub to add one.</div>'
        : '<div class="empty-state">Add a showtime when you log a movie to see what time you like to watch.</div>';
      return;
    }

    const counts = {};
    hours.forEach(h => { counts[h] = (counts[h] || 0) + 1; });
    const slotCounts = TIME_SLOTS.map(() => 0);
    hours.forEach(h => { slotCounts[TIME_SLOTS.findIndex(s => h < s.until)] += 1; });

    const topSlotCount = Math.max(...slotCounts);
    const topSlots = TIME_SLOTS.filter((s, i) => slotCounts[i] === topSlotCount);
    const peakCount = Math.max(...Object.values(counts));
    const peakHours = Object.keys(counts).map(Number).filter(h => counts[h] === peakCount);

    const favorite = topSlots.length > 2 ? 'No favorite yet' : topSlots.map(s => s.name).join(' & ');
    const details = [topSlots.length === 1
      ? `${topSlotCount} of ${plural(hours.length, 'showtime')} ${topSlotCount === 1 ? 'is' : 'are'} ${topSlots[0].range}`
      : `${plural(topSlotCount, 'showtime')} each`];
    if(peakHours.length === 1 && peakCount > 1) details.push(`most often between ${fmtHourSpan(peakHours[0])}`);

    // Always cover 10 AM to 11 PM so the axis stays put, stretching for earlier or later shows
    const first = Math.min(10, ...hours);
    const last = Math.max(23, ...hours);
    let cols = '';
    for(let h = first; h <= last; h++){
      const c = counts[h] || 0;
      const heightPct = c > 0 ? Math.max((c / peakCount) * 100, 6) : 2;
      const hh = h % 24;
      cols += `<div class="month-bar-col" title="Between ${fmtHourSpan(h)}: ${plural(c, 'movie')}">
        <div class="month-bar-count">${c || ''}</div>
        <div class="month-bar${c === peakCount ? '' : ' muted'}" style="height:${heightPct}%"></div>
        <div class="month-bar-label${(h - first) % 2 ? ' alt' : ''}">${hh % 12 || 12}${hh < 12 ? 'a' : 'p'}</div>
      </div>`;
    }

    const missing = movies.length - hours.length;
    box.innerHTML = `
      <div class="highlight">
        <div class="highlight-label">Favorite time to watch</div>
        <div class="highlight-name">${favorite}</div>
        <div class="highlight-detail">${details.join(' · ')}</div>
      </div>
      <div class="month-chart hour-chart">${cols}</div>
      <div class="time-slots">
        ${TIME_SLOTS.map((s, i) => `
          <div class="time-slot${slotCounts[i] === topSlotCount ? ' top' : ''}">
            <span class="num">${slotCounts[i]}</span>
            <span class="lbl">${s.name}</span>
            <span class="range">${s.range}</span>
          </div>`).join('')}
      </div>
      ${missing ? `<div class="hint" style="margin-top:14px;">${plural(missing, 'movie')} ${missing === 1 ? 'has' : 'have'} no showtime yet. Use Edit on a ticket stub to add one.</div>` : ''}
    `;
  }

  function render(){
    const movies = loadMovies();
    const sub = loadSub();

    const ticketValue = movies.reduce((sum, m) => sum + Number(m.price || 0) + Number(m.fee || 0), 0);
    const subCost = subscriptionCost(sub.periods);
    const net = ticketValue - subCost;
    const totalMinutes = movies.reduce((sum, m) => sum + (Number(m.runtime) || 0), 0);
    const moviesMissingRuntime = movies.filter(m => !m.runtime).length;

    $('statMovies').textContent = movies.length;
    $('statHours').textContent = fmtHours(totalMinutes);
    $('statHours').title = moviesMissingRuntime
      ? `${moviesMissingRuntime} logged movie(s) have no runtime data (not matched to a TMDB title), so this is a minimum.`
      : '';
    $('statTicketValue').textContent = fmtMoney(ticketValue);
    $('statSubCost').textContent = fmtMoney(subCost);
    renderMonthChart(movies);
    renderShowtimeStats(movies);
    renderLocationStats(movies);
    renderSeatMap(movies);
    renderTheaterOptions(movies);

    const headline = $('headlineNumber');
    const headlineSub = $('headlineSub');
    const headlineCalc = $('headlineCalc');
    if(movies.length === 0){
      headline.textContent = '$0';
      headline.classList.remove('negative');
      headlineSub.textContent = 'log a movie to get started';
      headlineCalc.textContent = '';
    } else if(net >= 0){
      headline.textContent = fmtMoney(net);
      headline.classList.remove('negative');
      headlineSub.textContent = `saved vs. paying per ticket`;
      headlineCalc.textContent = `${fmtMoney(ticketValue)} − ${fmtMoney(subCost)}`;
      document.title = `${fmtMoney(net)} saved — A-List Ledger`;
    } else {
      headline.textContent = `-${fmtMoney(Math.abs(net))}`;
      headline.classList.add('negative');
      headlineSub.textContent = `you're behind — watch a few more!`;
      headlineCalc.textContent = `${fmtMoney(ticketValue)} − ${fmtMoney(subCost)}`;
    }

    // Render stubs, newest first
    const list = $('stubList');
    if(movies.length === 0){
      list.innerHTML = '<div class="empty-state">No movies logged yet. Add your first ticket stub on the left.</div>';
      return;
    }
    const watchedAt = (m) => `${m.date || ''} ${m.time || ''}`;
    const sorted = [...movies].sort((a,b) => watchedAt(b).localeCompare(watchedAt(a)));
    list.innerHTML = sorted.map(m => {
      const poster = m.posterPath ? `<img class="stub-poster" src="${TMDB_IMG}${m.posterPath}" alt="" loading="lazy">` : '';
      const metaBits = [];
      metaBits.push(m.date || '—');
      if(m.time) metaBits.push(fmtTime(m.time));
      if(m.runtime) metaBits.push(`${m.runtime} min`);
      if(m.director) metaBits.push(`Dir. ${escapeHtml(m.director)}`);
      if(m.rating) metaBits.push(`★ ${Number(m.rating).toFixed(1)}`);
      const locationBits = [];
      if(m.theater) locationBits.push(escapeHtml(m.theater));
      if(seatLabel(m)) locationBits.push(`Seat ${seatLabel(m)}`);
      const locationLine = locationBits.length ? `<div class="stub-meta">${locationBits.join(' · ')}</div>` : '';
      const genreLine = (m.genres && m.genres.length) ? `<div class="stub-meta">${escapeHtml(m.genres.join(', '))}</div>` : '';
      return `
      <div class="stub${String(m.id) === String(editingId) ? ' editing' : ''}" data-id="${m.id}">
        <div class="stub-main">
          <div class="stub-title-row">
            ${poster}
            <div>
              <div class="stub-title">${escapeHtml(m.title || 'Untitled')}</div>
              <div class="stub-meta">${metaBits.join(' · ')}</div>
              ${locationLine}
              ${genreLine}
            </div>
          </div>
        </div>
        <div class="stub-amount">
          <span class="val">${fmtMoney(Number(m.price || 0) + Number(m.fee || 0))}</span>
          ${m.fee ? `<span class="stub-fee-note">incl. ${fmtMoney(Number(m.fee))} fee</span>` : ''}
          <div class="stub-actions">
            <button class="stub-edit" data-edit="${m.id}">Edit</button>
            <button class="stub-del" data-del="${m.id}">Remove</button>
          </div>
        </div>
      </div>
    `;
    }).join('');

    list.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => startEdit(btn.getAttribute('data-edit')));
    });
    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del');
        const updated = loadMovies().filter(m => String(m.id) !== String(id));
        saveMovies(updated);
        if(String(id) === String(editingId)){
          resetMovieForm();
          exitEdit();
        }
        render();
      });
    });
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  function escapeAttr(str){ return escapeHtml(str).replace(/"/g, '&quot;'); }

  function resetMovieForm(){
    cancelPendingSearch();
    pickSeq++;
    $('movieTitle').value = '';
    $('movieDate').value = '';
    $('movieTime').value = '';
    $('moviePrice').value = '';
    $('movieFee').value = '';
    $('seatRow').value = '';
    $('seatNumber').value = '';
    selectedMovie = null;
    renderSelectedMeta();
  }

  // Loads a logged movie into the Box Office Window so its details (like location or seat) can be changed
  function startEdit(id){
    const m = loadMovies().find(x => String(x.id) === String(id));
    if(!m) return;
    if(!editingId) preEditTheater = $('movieTheater').value;
    cancelPendingSearch();
    pickSeq++;
    editingId = m.id;
    $('movieTitle').value = m.title || '';
    $('movieDate').value = m.date || '';
    $('movieTime').value = m.time || '';
    $('moviePrice').value = m.price || '';
    $('movieFee').value = m.fee || '';
    $('movieTheater').value = m.theater || '';
    $('seatRow').value = m.seatRow || '';
    $('seatNumber').value = m.seatNumber || '';
    const hasMeta = m.posterPath || m.director || m.runtime || m.rating || m.releaseDate || (m.genres && m.genres.length);
    selectedMovie = hasMeta ? {
      title: m.title || '',
      posterPath: m.posterPath || '',
      director: m.director || '',
      genres: m.genres || [],
      runtime: m.runtime || null,
      rating: m.rating || null,
      releaseDate: m.releaseDate || ''
    } : null;
    closeDropdown();
    renderSelectedMeta();
    $('editBannerText').textContent = `Editing "${m.title || 'Untitled'}"`;
    $('editBanner').style.display = 'flex';
    updateSubmitLabel();
    render();
    $('boxOfficePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function exitEdit(){
    editingId = null;
    $('editBanner').style.display = 'none';
    if(preEditTheater !== null){
      $('movieTheater').value = preEditTheater;
      preEditTheater = null;
    }
    updateSubmitLabel();
  }
  $('cancelEditBtn').addEventListener('click', () => {
    resetMovieForm();
    exitEdit();
    render();
  });

  $('addMovieBtn').addEventListener('click', () => {
    const title = $('movieTitle').value.trim();
    const date = $('movieDate').value;
    const time = $('movieTime').value;
    const price = parseFloat($('moviePrice').value);
    const fee = parseFloat($('movieFee').value) || 0;
    const theater = $('movieTheater').value.trim().replace(/\s+/g, ' ');

    splitSeatInput();
    const seatRow = $('seatRow').value;
    const seatNumberRaw = $('seatNumber').value.trim();
    let seatNumber = null;
    if(seatRow || seatNumberRaw){
      if(!/^[A-Z]{1,2}$/.test(seatRow)){
        $('seatRow').focus();
        return;
      }
      seatNumber = parseInt(seatNumberRaw, 10);
      if(!(seatNumber >= 1 && seatNumber <= 99)){
        $('seatNumber').focus();
        return;
      }
    }
    if(!price || price <= 0){
      $('moviePrice').focus();
      return;
    }

    const movies = loadMovies();
    const meta = editingId
      ? selectedMovie // the details shown under the title while editing are the ones saved
      : (selectedMovie && selectedMovie.title.toLowerCase() === title.toLowerCase() ? selectedMovie : null);
    const entry = {
      id: editingId || (Date.now() + '-' + Math.random().toString(36).slice(2,7)),
      title: title || 'Untitled',
      date: date || '',
      time: time || '',
      price: price,
      fee: fee,
      theater: theater,
      seatRow: seatRow,
      seatNumber: seatNumber,
      posterPath: meta ? meta.posterPath : '',
      director: meta ? meta.director : '',
      genres: meta ? meta.genres : [],
      runtime: meta ? meta.runtime : null,
      rating: meta ? meta.rating : null,
      releaseDate: meta ? meta.releaseDate : ''
    };
    const existingIndex = editingId ? movies.findIndex(m => String(m.id) === String(editingId)) : -1;
    if(existingIndex >= 0) movies[existingIndex] = entry;
    else movies.push(entry);
    saveMovies(movies);

    // The theater stays filled in, since the next movie is usually at the same place
    resetMovieForm();
    if(editingId) exitEdit();
    $('movieTitle').focus();
    render();
  });

  $('saveSubBtn').addEventListener('click', () => {
    saveSub({ periods: normalizePeriods(subDraft) });
    initSubDraft();
    renderPeriodEditor();
    render();
    $('saveSubBtn').textContent = 'Saved ✓';
    setTimeout(() => $('saveSubBtn').textContent = 'Save Subscription Info', 1200);
  });

  // Allow Enter key to submit movie form from any of its fields. The theater box is left out
  // so picking a suggestion from its list with Enter doesn't submit the form early.
  ['movieTitle','movieDate','movieTime','moviePrice','movieFee','seatRow','seatNumber'].forEach(id => {
    $(id).addEventListener('keydown', (e) => {
      // An Enter that picked a search suggestion was already handled by the dropdown
      if(e.key === 'Enter' && !e.defaultPrevented){ e.preventDefault(); $('addMovieBtn').click(); }
    });
  });

  // Start with the theater from the most recently logged movie
  function prefillTheater(){
    const last = [...loadMovies()].reverse().find(m => m.theater);
    if(last) $('movieTheater').value = last.theater;
  }

  // Draw the saved data before wiring the Your Data section below, so the page still shows it
  // (and Save Subscription Info can't store an empty list) even if that wiring ever fails
  prefillTheater();
  initSubDraft();
  renderPeriodEditor();
  render();

  const BACKUP_APP = 'alist-savings';
  const BACKUP_VERSION = 1;
  let pendingImport = null; // checked backup waiting for Replace, Merge or Cancel
  if(!$('exportBtn')) return; // an old cached page without the Your Data section; everything above already works

  function setDataStatus(message, isError){
    $('dataStatus').textContent = message;
    $('dataStatus').classList.toggle('hint-warn', Boolean(isError));
    if(message) $('dataStatus').scrollIntoView({ block: 'nearest' });
  }

  $('exportBtn').addEventListener('click', () => {
    const backup = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      movies: loadMovies(),
      subscription: loadSub(),
      tmdbKey: getTmdbKey()
    };
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `alist-savings-backup-${stamp}.json`;
    $('settingsDropdown').appendChild(link); // inside the menu, so this click doesn't close it
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); // generous, since mobile Safari reads the file late
    setDataStatus(`Saved a backup with ${plural(backup.movies.length, 'movie')}. Send the file to your other device and use Import Backup there.`
      + (backup.tmdbKey ? ' The file includes your TMDB key, so keep it private.' : ''));
  });

  // A backup file can come from anywhere, so every field is coerced back to the shape
  // this app saves. Several fields are later placed into the page as HTML.
  // Format checks only run on real strings: test() would quietly turn ["2024-01-01"] into a match
  const text = (v) => typeof v === 'string' ? v : '';
  const isoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(text(v)) ? v : '';
  function cleanMovie(m, index){
    const number = (v) => (v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
    const hasSeat = /^[A-Z]{1,2}$/.test(text(m.seatRow)) && Number.isInteger(m.seatNumber) && m.seatNumber >= 1 && m.seatNumber <= 99;
    return {
      id: /^[\w.-]{1,64}$/.test(String(m.id ?? '')) ? String(m.id) : `imported-${Date.now()}-${index}`,
      title: text(m.title).trim() || 'Untitled',
      date: isoDate(m.date),
      time: /^\d{2}:\d{2}$/.test(text(m.time)) ? m.time : '',
      price: number(m.price) || 0,
      fee: number(m.fee) || 0,
      theater: text(m.theater).trim().replace(/\s+/g, ' '),
      seatRow: hasSeat ? m.seatRow : '',
      seatNumber: hasSeat ? m.seatNumber : null,
      posterPath: /^\/[\w.-]+$/.test(text(m.posterPath)) ? m.posterPath : '',
      director: text(m.director),
      genres: Array.isArray(m.genres) ? m.genres.filter(g => typeof g === 'string') : [],
      runtime: number(m.runtime),
      rating: number(m.rating),
      releaseDate: isoDate(m.releaseDate)
    };
  }
  function cleanPeriod(p){
    const price = Number(p.price);
    return { start: isoDate(p.start), end: isoDate(p.end), price: Number.isFinite(price) ? price : 0 };
  }
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // Returns the backup's contents, or throws a message that can be shown as is
  function parseBackup(text){
    let raw = null;
    try { raw = JSON.parse(text); } catch(e){ /* reported below */ }
    if(!isObject(raw) || raw.app !== BACKUP_APP || !Array.isArray(raw.movies)){
      throw new Error("That file isn't an A-List Savings backup. Pick a file made with Export Backup.");
    }
    if(Number(raw.version) > BACKUP_VERSION){
      throw new Error('That backup was made by a newer version of this app. Reload this page to update it, then import again.');
    }
    return {
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      movies: raw.movies.filter(isObject).map(cleanMovie),
      // Same rules as Save: blank rows dropped, oldest first
      periods: normalizePeriods(subFromRaw(raw.subscription).periods.filter(isObject).map(cleanPeriod)),
      tmdbKey: typeof raw.tmdbKey === 'string' ? raw.tmdbKey.trim() : ''
    };
  }

  $('importBtn').addEventListener('click', () => {
    $('importFile').value = ''; // so picking the same file again still fires "change"
    $('importFile').click();
  });
  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files[0];
    if(!file) return;
    try {
      pendingImport = parseBackup(await file.text());
      setDataStatus('');
    } catch(err){
      pendingImport = null;
      setDataStatus(err.message, true);
    }
    renderImportReview();
  });

  function hasLocalData(){ return loadMovies().length > 0 || loadSub().periods.length > 0; }

  function renderImportReview(){
    const box = $('importReview');
    if(!pendingImport){
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    const b = pendingImport;
    const exported = new Date(b.exportedAt);
    const when = b.exportedAt && !isNaN(exported)
      ? exported.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
      : 'an unknown date';
    const localMovies = loadMovies().length;
    const deviceHasData = hasLocalData();
    box.style.display = 'block';
    box.innerHTML = `
      <div class="import-title">Backup from ${escapeHtml(when)}</div>
      <div class="import-counts">${plural(b.movies.length, 'movie')} · ${plural(b.periods.length, 'billing period')}</div>
      ${deviceHasData ? `
        <div class="hint">This device has ${plural(localMovies, 'movie')}. Replace makes it match the backup exactly. Merge keeps the movies from both and never removes any.</div>
        <button type="button" class="btn-primary" data-import="replace">Replace This Device's Data</button>
        <button type="button" class="btn-ghost" data-import="merge">Merge Both</button>
      ` : '<button type="button" class="btn-primary" data-import="replace">Import</button>'}
      <button type="button" class="import-cancel" data-import="cancel">Cancel</button>`;
    box.querySelectorAll('[data-import]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // the button is gone after re-render, which would read as a click outside the menu
        const mode = btn.getAttribute('data-import');
        if(mode === 'cancel'){
          pendingImport = null;
          renderImportReview();
          $('importBtn').focus({ preventScroll: true });
        } else if(hasLocalData() !== deviceHasData){
          renderImportReview(); // another tab changed this device's data, so offer the right choices first
        } else {
          applyImport(mode);
        }
      });
    });
    box.scrollIntoView({ block: 'nearest' }); // on phones the review starts below the visible part of the menu
  }

  function applyImport(mode){
    const b = pendingImport;
    const localMovies = loadMovies();
    let movies = b.movies;
    let periods = b.periods;
    if(mode === 'merge'){
      // Movies are matched by id; one on both devices takes the backup's version
      const byId = new Map(localMovies.map(m => [String(m.id), m]));
      b.movies.forEach(m => byId.set(m.id, m));
      movies = [...byId.values()];
      if(!periods.some(p => p.start)) periods = loadSub().periods; // periods without a start bill nothing
    }
    saveMovies(movies);
    saveSub({ periods });
    if(b.tmdbKey && (mode === 'replace' || !getTmdbKey())) localStorage.setItem(LS_KEY, b.tmdbKey);

    pendingImport = null;
    renderImportReview();
    if(editingId){
      resetMovieForm();
      exitEdit();
    }
    $('tmdbKey').value = getTmdbKey();
    if(!$('movieTheater').value.trim()) prefillTheater();
    initSubDraft();
    renderPeriodEditor();
    render();
    $('importBtn').focus({ preventScroll: true });
    setDataStatus(mode === 'merge'
      ? `Merged. This device now has ${plural(movies.length, 'movie')}, ${movies.length - localMovies.length} of them new.`
      : `Imported. This device now has the backup's ${plural(movies.length, 'movie')}.`);
  }
})();
