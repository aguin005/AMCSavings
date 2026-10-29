(function(){
  // The page and this script are cached separately, so right after an update a browser can pair
  // an old cached page with this script. Reload once to get the matching page rather than run
  // against markup this script doesn't know. Keep BUILD equal to data-build in index.html.
  const BUILD = '7';
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

  $('settingsBtn').addEventListener('click', () => {
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
    // Browser bar color matches the top of the page (same values as the early script in index.html)
    document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#20141B' : '#FDF0F2');
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
  // Briefly confirms a save on the button itself, since on a phone the new stub is far down the page
  let submitFlashTimer = null;
  function flashSubmit(text){
    $('addMovieBtn').textContent = text;
    clearTimeout(submitFlashTimer);
    submitFlashTimer = setTimeout(updateSubmitLabel, 1400);
  }

  // iPhone Safari shows an empty date field as a blank box, so its box shows "Pick a date" until one is set
  function syncDateBoxes(){
    document.querySelectorAll('.date-box input[type=date]').forEach(input => {
      input.parentElement.classList.toggle('empty', !input.value);
    });
  }
  ['input', 'change'].forEach(type => document.addEventListener(type, (e) => {
    if(e.target.matches && e.target.matches('.date-box input[type=date]')) syncDateBoxes();
  }));
  window.addEventListener('pageshow', syncDateBoxes); // Back/Forward can bring back typed-in dates

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
            <div class="date-box">
              <input type="date" id="periodStart${i}" data-index="${i}" data-field="start" value="${escapeAttr(p.start || '')}">
              <span class="date-placeholder" aria-hidden="true">Pick a date</span>
            </div>
          </div>
          <div class="field">
            <label for="periodEnd${i}">To</label>
            <div class="date-box">
              <input type="date" id="periodEnd${i}" data-index="${i}" data-field="end" value="${escapeAttr(p.end || '')}">
              <span class="date-placeholder" aria-hidden="true">Pick a date</span>
            </div>
          </div>
        </div>
        <div class="field">
          <label for="periodPrice${i}">Monthly price ($)</label>
          <input type="number" id="periodPrice${i}" data-index="${i}" data-field="price" step="0.01" min="0" inputmode="decimal" placeholder="${DEFAULT_MONTHLY_PRICE}" value="${escapeAttr(String(p.price ?? ''))}">
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
    syncDateBoxes();
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
    const picker = $('seatTheaterWrap');
    const box = $('seatMap');
    if(!theaters.length){
      picker.style.display = 'none';
      seatTheaterKey = null;
      box.innerHTML = '<div class="empty-state">Add the row and seat number from your ticket when you log a theater movie to see where you sit the most.</div>';
      return;
    }

    if(!theaters.some(t => t.key === seatTheaterKey)) seatTheaterKey = theaters[0].key;
    // Only offer the picker once there's more than one theater to switch between
    picker.style.display = theaters.length > 1 ? '' : 'none';

    const t = theaters.find(x => x.key === seatTheaterKey);
    $('seatTheaterName').textContent = t.name;
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
  function highlightMatch(text, query){
    const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if(i < 0) return escapeHtml(text);
    return escapeHtml(text.slice(0, i)) + '<mark>' + escapeHtml(text.slice(i, i + query.length)) + '</mark>' + escapeHtml(text.slice(i + query.length));
  }

  // A styled pop-up list under a field, shared by the Theater box and the Seat Heatmap theater button.
  // getOptions(query) returns [{ value, label, html?, meta?, selected?, isNew? }]; onChoose(option) runs on a pick.
  function makeListPicker(trigger, list, getOptions, onChoose){
    const LIST_MAX = 264; // tallest the list gets, in px
    let options = [];
    let active = -1;
    let openedAt = 0;
    const isOpen = () => list.classList.contains('open');
    // Scroll inside the list only (scrollIntoView would also scroll the page)
    function reveal(el, center){
      const top = el.offsetTop, bottom = top + el.offsetHeight;
      if(center) list.scrollTop = top - (list.clientHeight - el.offsetHeight) / 2;
      else if(top < list.scrollTop) list.scrollTop = top;
      else if(bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
    // Keep the list on screen: scroll the page just enough to show it (when asked), and cap its height
    // to the visible space, which shrinks when a phone keyboard opens
    function fit(scrollPage){
      if(!isOpen()) return;
      const vv = window.visualViewport;
      const viewTop = vv ? vv.offsetTop : 0;
      const viewBottom = viewTop + (vv ? vv.height : window.innerHeight);
      if(scrollPage){
        const t = trigger.getBoundingClientRect();
        const overflow = t.bottom + 4 + Math.min(list.scrollHeight, LIST_MAX) + 12 - viewBottom;
        if(overflow > 0) window.scrollBy(0, Math.min(overflow, t.top - viewTop - 8));
      }
      list.style.maxHeight = Math.max(88, Math.min(LIST_MAX, viewBottom - trigger.getBoundingClientRect().bottom - 16)) + 'px';
    }
    // The keyboard appears just after focus, so re-fit then; later resizes (toolbars, zoom) only adjust the height
    if(window.visualViewport) window.visualViewport.addEventListener('resize', () => fit(Date.now() - openedAt < 1000));
    function draw(){
      list.innerHTML = options.map((o, i) => `
        <div class="pick-item${i === active ? ' active' : ''}${o.selected ? ' selected' : ''}${o.isNew ? ' is-new' : ''}"
          role="option" id="${list.id}-${i}" data-index="${i}" aria-selected="${o.selected ? 'true' : 'false'}">
          <span class="pick-label">${o.html || escapeHtml(o.label)}</span>
          ${o.meta ? `<span class="pick-meta">${escapeHtml(o.meta)}</span>` : ''}
        </div>`).join('');
      if(active >= 0){
        trigger.setAttribute('aria-activedescendant', `${list.id}-${active}`);
        if(isOpen()) reveal(list.children[active]);
      } else {
        trigger.removeAttribute('aria-activedescendant');
      }
    }
    function open(query){
      options = getOptions(query);
      if(!options.length){ close(); return; }
      // A button opens like a native select, on the current choice; a text box starts with nothing highlighted
      // so Enter still saves the form
      active = trigger.tagName === 'BUTTON' ? options.findIndex(o => o.selected) : -1;
      draw();
      list.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      openedAt = Date.now();
      fit(true);
      const current = list.querySelector('.active') || list.querySelector('.selected');
      if(current) reveal(current, true);
    }
    function close(){
      list.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function choose(index){
      const option = options[index];
      close();
      if(option) onChoose(option);
    }
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field while picking
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.pick-item');
      if(item) choose(Number(item.getAttribute('data-index')));
    });
    trigger.addEventListener('keydown', (e) => {
      if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        if(!isOpen()){
          open(trigger.tagName === 'INPUT' ? trigger.value : '');
          if(options.length && active < 0){
            active = Math.max(0, options.findIndex(o => o.selected));
            draw();
          }
          return;
        }
        const step = e.key === 'ArrowDown' ? 1 : -1;
        active = active < 0 ? (step > 0 ? 0 : options.length - 1) : (active + step + options.length) % options.length;
        draw();
      } else if((e.key === 'Enter' || (e.key === ' ' && trigger.tagName === 'BUTTON')) && isOpen() && active >= 0){
        e.preventDefault(); // also tells the form's Enter-to-save handler this key was used
        choose(active);
      } else if(e.key === 'Escape' && isOpen()){
        e.preventDefault();
        close();
      } else if(e.key === 'Tab'){
        close();
      }
    });
    // Leaving the field (like Next on a phone keyboard) closes the list; picks keep focus via mousedown above
    trigger.addEventListener('blur', close);
    // The list's wrapper holds the field and its own buttons (like the clear x), so clicks there aren't "outside"
    // pointerdown too: iPhone Safari often sends no click to the page for taps on plain, non-button areas
    const root = list.parentElement;
    ['pointerdown', 'click'].forEach(type => document.addEventListener(type, (e) => {
      if(isOpen() && !root.contains(e.target)) close();
    }));
    return { open, close, isOpen };
  }

  // Theater box: saved theaters, most visited first, narrowed to what's typed, plus the typed name if it's new
  const theaterPicker = makeListPicker($('movieTheater'), $('theaterList'), (query) => {
    const typed = (query || '').trim().replace(/\s+/g, ' ');
    const key = theaterKey(typed);
    const current = theaterKey($('movieTheater').value);
    const theaters = computeLocationStats(loadMovies()).theaters;
    const options = theaters
      .filter(t => !key || t.key.includes(key))
      .map(t => ({ value: t.name, label: t.name, html: highlightMatch(t.name, typed), meta: plural(t.count, 'movie'), selected: t.key === current }));
    if(key && theaters.length && !theaters.some(t => t.key === key)){
      options.push({ value: typed, label: typed, isNew: true, html: `+ Add &ldquo;${escapeHtml(typed)}&rdquo; as a new theater` });
    }
    return options;
  }, (option) => {
    $('movieTheater').value = option.value;
  });
  $('movieTheater').addEventListener('focus', () => theaterPicker.open('')); // show every saved theater first
  $('movieTheater').addEventListener('click', () => { if(!theaterPicker.isOpen()) theaterPicker.open(''); });
  $('movieTheater').addEventListener('input', () => theaterPicker.open($('movieTheater').value));
  $('theaterClear').addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the box
  $('theaterClear').addEventListener('click', () => {
    $('movieTheater').value = '';
    $('movieTheater').focus();
    theaterPicker.open('');
  });

  // Seat Heatmap theater button: same list, showing how many seats were logged at each theater
  const seatPicker = makeListPicker($('seatTheater'), $('seatTheaterList'), () =>
    computeSeatData(loadMovies()).map(t => ({ value: t.key, label: t.name, meta: plural(t.total, 'seat'), selected: t.key === seatTheaterKey })),
    (option) => {
      seatTheaterKey = option.value;
      renderSeatMap(loadMovies());
      $('seatTheater').focus();
    });
  $('seatTheater').addEventListener('click', () => seatPicker.isOpen() ? seatPicker.close() : seatPicker.open());

  // Showtime picker: hour and minute grids plus AM/PM, writing "HH:MM" into the hidden #movieTime
  let timePm = true;        // AM/PM to use before an hour is picked; most showtimes are in the evening
  let draftMinute = null;   // a minute picked before any hour
  const timeIsOpen = () => $('timePanel').classList.contains('open');

  function timeParts(){
    const v = $('movieTime').value;
    if(!/^\d{2}:\d{2}$/.test(v)) return null;
    const h = Number(v.slice(0, 2));
    return { hour: h % 12 || 12, minute: Number(v.slice(3)), pm: h >= 12 };
  }
  function setShowtime(value){
    $('movieTime').value = value || '';
    $('movieTimeText').textContent = value ? fmtTime(value) : 'Pick a time';
    $('movieTimeText').classList.toggle('time-placeholder', !value);
    syncTimePanel();
  }
  function setTimeParts(hour, minute, pm){
    const h24 = (hour % 12) + (pm ? 12 : 0);
    setShowtime(`${String(h24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }
  const setPressed = (btn, on) => {
    btn.classList.toggle('selected', Boolean(on));
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  function syncTimePanel(){
    const panel = $('timePanel');
    const p = timeParts();
    const minute = p ? p.minute : draftMinute;
    panel.querySelectorAll('[data-hour]').forEach(b => setPressed(b, p && Number(b.dataset.hour) === p.hour));
    panel.querySelectorAll('[data-minute]').forEach(b => setPressed(b, minute !== null && Number(b.dataset.minute) === minute));
    panel.querySelectorAll('[data-pm]').forEach(b => setPressed(b, (b.dataset.pm === '1') === (p ? p.pm : timePm)));
    panel.querySelectorAll('[data-usual]').forEach(b => setPressed(b, $('movieTime').value === b.dataset.usual));
  }
  function openTimePanel(){
    // Usual times: the 4 most frequent (ties go to the most recently used), shown in time-of-day order
    const stats = {};
    loadMovies().forEach(m => {
      if(!/^\d{2}:\d{2}$/.test(m.time || '')) return;
      const s = stats[m.time] || (stats[m.time] = { count: 0, last: '' });
      s.count += 1;
      const when = `${m.date || ''} ${m.time}`;
      if(when > s.last) s.last = when;
    });
    const usual = Object.keys(stats)
      .sort((a, b) => stats[b].count - stats[a].count || stats[b].last.localeCompare(stats[a].last))
      .slice(0, 4)
      .sort((a, b) => showtimeHour(a) - showtimeHour(b) || a.localeCompare(b));
    const p = timeParts();
    timePm = p ? p.pm : true;
    draftMinute = null;
    const panel = $('timePanel');
    panel.innerHTML = `
      ${usual.length ? `<div class="time-head" id="timeUsualHead">Your usual times</div>
        <div class="time-usual" role="group" aria-labelledby="timeUsualHead">${usual.map(t => `<button type="button" class="time-chip" data-usual="${t}">${fmtTime(t)}</button>`).join('')}</div>` : ''}
      <div class="time-head" id="timeHourHead">Hour</div>
      <div class="time-grid" role="group" aria-labelledby="timeHourHead">${[...Array(12)].map((_, i) => `<button type="button" class="time-chip" data-hour="${i + 1}">${i + 1}</button>`).join('')}</div>
      <div class="time-head" id="timeMinuteHead">Minute</div>
      <div class="time-grid" role="group" aria-labelledby="timeMinuteHead">${[...Array(12)].map((_, i) => `<button type="button" class="time-chip" data-minute="${i * 5}">:${String(i * 5).padStart(2, '0')}</button>`).join('')}</div>
      <div class="time-foot">
        <div class="time-ampm" role="group" aria-label="AM or PM">
          <button type="button" class="time-chip" data-pm="0">AM</button>
          <button type="button" class="time-chip" data-pm="1">PM</button>
        </div>
        <button type="button" class="time-clear" data-action="clear">Clear</button>
        <button type="button" class="time-done" data-action="done">Done</button>
      </div>`;
    panel.classList.add('open');
    $('movieTimeBtn').setAttribute('aria-expanded', 'true');
    syncTimePanel();
    panel.scrollIntoView({ block: 'nearest' });
    (panel.querySelector('[data-hour].selected') || panel.querySelector('[data-hour]')).focus({ preventScroll: true });
  }
  function closeTimePanel(returnFocus){
    if(!timeIsOpen()) return;
    $('timePanel').classList.remove('open');
    $('movieTimeBtn').setAttribute('aria-expanded', 'false');
    if(returnFocus) $('movieTimeBtn').focus();
  }
  $('movieTimeBtn').addEventListener('click', () => timeIsOpen() ? closeTimePanel(true) : openTimePanel());
  // The panel's buttons are only restyled, never re-drawn, while it is open, so a click's target stays in the page
  $('timePanel').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if(!btn) return;
    const p = timeParts();
    if(btn.dataset.usual){
      setShowtime(btn.dataset.usual);
      closeTimePanel(true);
    } else if(btn.dataset.hour){
      const minuteFirst = !p && draftMinute !== null;
      setTimeParts(Number(btn.dataset.hour), p ? p.minute : (draftMinute ?? 0), p ? p.pm : timePm);
      draftMinute = null;
      if(minuteFirst) closeTimePanel(true); // hour and minute are both picked now
    } else if(btn.dataset.minute){
      if(p){
        setTimeParts(p.hour, Number(btn.dataset.minute), p.pm);
        closeTimePanel(true);
      } else {
        draftMinute = Number(btn.dataset.minute);
        syncTimePanel();
      }
    } else if(btn.dataset.pm){
      const pm = btn.dataset.pm === '1';
      if(p) setTimeParts(p.hour, p.minute, pm);
      else { timePm = pm; syncTimePanel(); }
    } else if(btn.dataset.action === 'clear'){
      draftMinute = null;
      setShowtime('');
      closeTimePanel(true);
    } else if(btn.dataset.action === 'done'){
      closeTimePanel(true);
    }
  });
  [$('timePanel'), $('movieTimeBtn')].forEach(el => el.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && timeIsOpen()){ e.preventDefault(); closeTimePanel(true); }
  }));
  ['pointerdown', 'click'].forEach(type => document.addEventListener(type, (e) => {
    if(timeIsOpen() && !e.target.closest('#timePanel, #movieTimeBtn')) closeTimePanel(false);
  }));
  // Tabbing (or any focus move) to something outside closes it, so it never hides the focused field.
  // focusin rather than focusout: Safari doesn't focus buttons on tap, so chip taps never trigger this.
  document.addEventListener('focusin', (e) => {
    if(timeIsOpen() && !e.target.closest('#timePanel, #movieTimeBtn')) closeTimePanel(false);
  });
  setShowtime($('movieTime').value); // in case the browser restored the hidden field on a reload

  const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // Movies by Month and When You Watch: hover a bar (or reach it with Tab) for a quick look at its titles,
  // click or tap it to pin the full list under the chart. bars holds each bar's movies by its data-key.
  const barCharts = {
    month: { selected: null, bars: new Map(), detailId: 'monthDetail' },
    hour: { selected: null, bars: new Map(), detailId: 'hourDetail' }
  };
  const TIP_MAX = 6; // titles listed in a hover tip before "+ N more"
  const newestFirst = (list) => [...list].sort((a, b) => `${b.date || ''} ${b.time || ''}`.localeCompare(`${a.date || ''} ${a.time || ''}`));
  const fmtDay = (iso, withYear) => {
    const d = parseDate(iso);
    return d ? d.toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  };

  // One chart column. A column with movies is a button; the whole column, not just the bar, is its target.
  function barColumn(chart, key, count, heightPct, barClass, axisLabel, labelClass, name){
    const inner = `<div class="month-bar-count">${count || ''}</div>
        <div class="month-bar${barClass}" style="height:${heightPct}%"></div>
        <div class="month-bar-label${labelClass}">${axisLabel}</div>`;
    return count
      ? `<button type="button" class="month-bar-col bar-hit" data-chart="${chart}" data-key="${key}" aria-expanded="false"
          aria-controls="${barCharts[chart].detailId}" aria-label="${escapeAttr(`${name}: ${plural(count, 'movie')}`)}">${inner}</button>`
      : `<div class="month-bar-col">${inner}</div>`;
  }

  // Marks the chosen bar, dims the rest, and fills in (or hides) the list under the chart
  function applyBarSelection(name){
    const chart = barCharts[name];
    const bar = chart.selected !== null ? chart.bars.get(chart.selected) : null;
    if(!bar) chart.selected = null; // its movies were deleted, moved, or are in another year
    const buttons = document.querySelectorAll(`.bar-hit[data-chart="${name}"]`);
    buttons.forEach(b => {
      const on = b.dataset.key === chart.selected;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    if(buttons.length) buttons[0].parentElement.classList.toggle('has-selection', Boolean(bar));
    const box = $(chart.detailId);
    if(!box) return;
    if(!bar){
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="bar-detail-head">
        <div class="bar-detail-heading"><strong>${plural(bar.movies.length, 'movie')}</strong> ${escapeHtml(bar.phrase)}</div>
        <button type="button" class="bar-detail-close" data-close="${name}" aria-label="Close this list">&times;</button>
      </div>
      <ul class="bar-detail-list">${bar.movies.map(m => {
        const poster = m.posterPath ? `<img src="${TMDB_IMG}${m.posterPath}" alt="" loading="lazy">` : '<span class="bar-detail-noposter"></span>';
        const meta = [fmtDay(m.date, name === 'hour'), m.time ? fmtTime(m.time) : '', m.theater || ''].filter(Boolean).map(escapeHtml).join(' · ');
        return `<li>${poster}<div class="bar-detail-text">
          <div class="bar-detail-title">${escapeHtml(m.title || 'Untitled')}</div>
          ${meta ? `<div class="bar-detail-meta">${meta}</div>` : ''}
        </div></li>`;
      }).join('')}</ul>`;
  }
  function selectBar(name, key){
    const chart = barCharts[name];
    chart.selected = chart.selected === key ? null : key;
    hideBarTip();
    applyBarSelection(name);
    const box = $(chart.detailId);
    if(chart.selected && box) box.scrollIntoView({ block: 'nearest' }); // on a phone the list can open below the screen
  }

  // The hover tip: one for both charts, built with textContent since titles are user data
  const barTip = document.createElement('div');
  barTip.className = 'bar-tip';
  barTip.setAttribute('role', 'tooltip');
  barTip.hidden = true;
  document.body.appendChild(barTip);
  let tipFor = null;
  function showBarTip(btn){
    const chart = barCharts[btn.dataset.chart];
    const bar = chart && chart.bars.get(btn.dataset.key);
    if(!bar){ hideBarTip(); return; }
    tipFor = btn;
    barTip.textContent = '';
    const add = (parent, tag, cls, text) => {
      const el = document.createElement(tag);
      if(cls) el.className = cls;
      el.textContent = text;
      parent.appendChild(el);
    };
    add(barTip, 'div', 'bar-tip-value', plural(bar.movies.length, 'movie'));
    add(barTip, 'div', 'bar-tip-label', bar.label);
    const list = document.createElement('ul');
    list.className = 'bar-tip-list';
    bar.movies.slice(0, TIP_MAX).forEach(m => add(list, 'li', '', m.title || 'Untitled'));
    if(bar.movies.length > TIP_MAX) add(list, 'li', 'bar-tip-more', `+ ${bar.movies.length - TIP_MAX} more`);
    barTip.appendChild(list);
    if(chart.selected !== btn.dataset.key) add(barTip, 'div', 'bar-tip-hint', 'Click for the full list');
    barTip.hidden = false;
    // Centered over the column, above its count, kept on screen; under the column if there's no room above
    const col = btn.getBoundingClientRect();
    const countTop = btn.querySelector('.month-bar-count').getBoundingClientRect().top;
    const w = barTip.offsetWidth, h = barTip.offsetHeight;
    const left = Math.max(8, Math.min(col.left + col.width / 2 - w / 2, window.innerWidth - w - 8));
    const top = countTop - h - 6 >= 8 ? countTop - h - 6 : col.bottom + 6;
    barTip.style.left = `${left}px`;
    barTip.style.top = `${top}px`;
  }
  function hideBarTip(){
    tipFor = null;
    barTip.hidden = true;
  }
  const isFocusVisible = (el) => { try { return el.matches(':focus-visible'); } catch(e){ return true; } };
  ['monthPanel', 'showtimeStats'].forEach(id => {
    const root = $(id);
    if(!root) return; // an older cached page without this panel's id
    // Mouse and pen only: a tap on a phone pins the list instead
    root.addEventListener('pointerover', (e) => {
      const btn = e.target.closest('.bar-hit');
      if(btn && btn !== tipFor && (e.pointerType === 'mouse' || e.pointerType === 'pen')) showBarTip(btn);
    });
    root.addEventListener('pointerout', (e) => {
      if(tipFor && e.target.closest('.bar-hit') === tipFor && !tipFor.contains(e.relatedTarget)) hideBarTip();
    });
    root.addEventListener('focusin', (e) => {
      const btn = e.target.closest('.bar-hit');
      if(btn && isFocusVisible(btn)) showBarTip(btn);
    });
    root.addEventListener('focusout', (e) => { if(e.target === tipFor) hideBarTip(); });
    root.addEventListener('click', (e) => {
      const close = e.target.closest('[data-close]');
      if(close){
        const name = close.dataset.close;
        const key = barCharts[name].selected;
        selectBar(name, key);
        const btn = document.querySelector(`.bar-hit[data-chart="${name}"][data-key="${key}"]`);
        if(btn) btn.focus({ preventScroll: true });
        return;
      }
      const btn = e.target.closest('.bar-hit');
      if(btn) selectBar(btn.dataset.chart, btn.dataset.key);
    });
    root.addEventListener('keydown', (e) => {
      if(e.key !== 'Escape') return;
      hideBarTip();
      const name = Object.keys(barCharts).find(n => barCharts[n].selected !== null && root.contains(document.querySelector(`.bar-hit[data-chart="${n}"]`)));
      if(!name) return;
      const key = barCharts[name].selected;
      selectBar(name, key);
      const btn = document.querySelector(`.bar-hit[data-chart="${name}"][data-key="${key}"]`);
      if(btn) btn.focus({ preventScroll: true });
    });
  });
  window.addEventListener('scroll', () => { if(tipFor) hideBarTip(); }, { passive: true });

  let selectedYear = null; // currently displayed year in the month chart

  function computeYearData(movies){
    const byYear = {};
    const lists = {}; // year -> 12 arrays of that month's movies
    movies.forEach(m => {
      if(!m.date) return;
      const parts = m.date.split('-').map(Number);
      if(parts.length !== 3 || parts.some(isNaN)) return;
      const [year, month] = parts;
      const monthIndex = month - 1;
      if(monthIndex < 0 || monthIndex > 11) return;
      if(!byYear[year]){
        byYear[year] = new Array(12).fill(0);
        lists[year] = [...Array(12)].map(() => []);
      }
      byYear[year][monthIndex] += 1;
      lists[year][monthIndex].push(m);
    });
    const years = Object.keys(byYear).map(Number).sort((a, b) => b - a); // most recent first
    return { byYear, years, lists };
  }

  function renderMonthChart(movies){
    const { byYear, years, lists } = computeYearData(movies);
    const nav = $('yearNav');
    barCharts.month.bars = new Map();

    if(years.length === 0){
      $('monthChart').innerHTML = '<div class="empty-state">No dated movies logged yet — add a "date seen" to see this chart.</div>';
      $('yearLabel').textContent = '—';
      nav.style.display = 'none';
      selectedYear = null;
      applyBarSelection('month');
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
      const key = `${selectedYear}-${String(i + 1).padStart(2, '0')}`;
      const name = `${MONTH_NAMES[i]} ${selectedYear}`;
      if(c) barCharts.month.bars.set(key, { label: name, phrase: `in ${name}`, movies: newestFirst(lists[selectedYear][i]) });
      return barColumn('month', key, c, heightPct, '', MONTH_LABELS[i], '', name);
    }).join('');
    applyBarSelection('month');

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
      barCharts.hour.selected = null;
      return;
    }

    const counts = {};
    hours.forEach(h => { counts[h] = (counts[h] || 0) + 1; });
    const byHour = {};
    movies.forEach(m => {
      const h = showtimeHour(m.time);
      if(h !== null) (byHour[h] = byHour[h] || []).push(m);
    });
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
    barCharts.hour.bars = new Map();
    let cols = '';
    for(let h = first; h <= last; h++){
      const c = counts[h] || 0;
      const heightPct = c > 0 ? Math.max((c / peakCount) * 100, 6) : 2;
      const hh = h % 24;
      const name = `Between ${fmtHourSpan(h)}`;
      if(c) barCharts.hour.bars.set(String(h), { label: name, phrase: `between ${fmtHourSpan(h)}`, movies: newestFirst(byHour[h]) });
      cols += barColumn('hour', h, c, heightPct, c === peakCount ? '' : ' muted', `${hh % 12 || 12}${hh < 12 ? 'a' : 'p'}`, (h - first) % 2 ? ' alt' : '', name);
    }

    const missing = movies.length - hours.length;
    box.innerHTML = `
      <div class="highlight">
        <div class="highlight-label">Favorite time to watch</div>
        <div class="highlight-name">${favorite}</div>
        <div class="highlight-detail">${details.join(' · ')}</div>
      </div>
      <div class="month-chart hour-chart">${cols}</div>
      <div id="hourDetail" class="bar-detail" hidden></div>
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
    applyBarSelection('hour');
  }

  // Money animation around the total: green and rising when ahead, red and falling when behind.
  // The chart line redraws whenever the total changes, like a stock tick.
  let shownTrend = null;
  function showTrend(trend, net){
    const wrap = $('headlineWrap');
    const key = `${trend} ${net.toFixed(2)}`;
    if(!wrap || key === shownTrend) return;
    shownTrend = key;
    $('headlineNumber').classList.toggle('gain', trend === 'up');
    wrap.setAttribute('data-trend', 'none');
    void wrap.offsetWidth; // let the browser see the reset, so the draw-in animation starts over
    wrap.setAttribute('data-trend', trend);
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
    } else {
      headline.textContent = `-${fmtMoney(Math.abs(net))}`;
      headline.classList.add('negative');
      headlineSub.textContent = `you're behind — watch a few more!`;
      headlineCalc.textContent = `${fmtMoney(ticketValue)} − ${fmtMoney(subCost)}`;
    }

    document.title = movies.length && net >= 0 ? `${fmtMoney(net)} saved | AMC Savings` : 'AMC Savings';
    showTrend(movies.length === 0 ? 'none' : (net >= 0 ? 'up' : 'down'), net);

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
    syncDateBoxes();
    setShowtime('');
    closeTimePanel(false);
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
    syncDateBoxes();
    setShowtime(m.time || '');
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
    const wasEditing = Boolean(editingId);
    resetMovieForm();
    if(editingId) exitEdit();
    // On a phone, focusing the title would bring the keyboard back up over the confirmation
    if(window.matchMedia('(pointer: coarse)').matches){ if(document.activeElement) document.activeElement.blur(); }
    else $('movieTitle').focus();
    render();
    flashSubmit(wasEditing ? 'Saved ✓' : 'Added ✓');
  });

  $('saveSubBtn').addEventListener('click', () => {
    saveSub({ periods: normalizePeriods(subDraft) });
    initSubDraft();
    renderPeriodEditor();
    render();
    $('saveSubBtn').textContent = 'Saved ✓';
    setTimeout(() => $('saveSubBtn').textContent = 'Save Subscription Info', 1200);
  });

  // Allow Enter key to submit movie form from any of its fields
  ['movieTitle','movieTheater','movieDate','moviePrice','movieFee','seatRow','seatNumber'].forEach(id => {
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
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(text(m.time)) ? m.time : '',
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
