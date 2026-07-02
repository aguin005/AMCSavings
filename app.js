(function(){
  const LS_MOVIES = 'alist_ledger_movies';
  const LS_SUB = 'alist_ledger_subscription';
  const LS_KEY = 'alist_ledger_tmdb_key';
  const TMDB_BASE = 'https://api.themoviedb.org/3';
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w200';

  const $ = (id) => document.getElementById(id);
  const fmtMoney = (n) => `$${n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
  const fmtHours = (totalMinutes) => {
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  };

  let selectedMovie = null; // holds TMDB metadata for the movie currently in the form
  let searchDebounce = null;
  let activeSuggestions = [];
  let activeIndex = -1;
  const searchCache = new Map();  // query (lowercased) -> results array
  const detailCache = new Map();  // tmdb id -> detail object

  function getTmdbKey(){ return (localStorage.getItem(LS_KEY) || '').trim(); }

  $('settingsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('settingsDropdown');
    const isOpen = dd.classList.toggle('open');
    $('settingsBtn').setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if(!e.target.closest('#settingsDropdown') && !e.target.closest('#settingsBtn')){
      $('settingsDropdown').classList.remove('open');
      $('settingsBtn').setAttribute('aria-expanded', 'false');
    }
  });

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
    dd.innerHTML = `<div class="dd-empty" style="color:var(--velvet);">${escapeHtml(message)}</div>`;
    dd.classList.add('open');
  }

  function closeDropdown(){
    $('titleDropdown').classList.remove('open');
    $('titleDropdown').innerHTML = '';
  }

  async function selectSuggestion(index){
    const picked = activeSuggestions[index];
    if(!picked) return;
    closeDropdown();
    $('movieTitle').value = picked.title;
    const detail = await fetchMovieDetail(picked.id);
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
    selectedMovie = null; // typing invalidates a previous selection
    renderSelectedMeta();
    const query = $('movieTitle').value;
    clearTimeout(searchDebounce);
    if(!query.trim()){ closeDropdown(); return; }
    searchDebounce = setTimeout(async () => {
      try {
        const results = await searchMovies(query);
        renderDropdown(results);
      } catch(err){
        console.error('TMDB search failed:', err);
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

  function loadMovies(){
    try { return JSON.parse(localStorage.getItem(LS_MOVIES)) || []; }
    catch(e){ return []; }
  }
  function saveMovies(movies){
    localStorage.setItem(LS_MOVIES, JSON.stringify(movies));
  }
  function loadSub(){
    try {
      return JSON.parse(localStorage.getItem(LS_SUB)) || { monthlyCost: 23.95, startDate: '' };
    } catch(e){
      return { monthlyCost: 23.95, startDate: '' };
    }
  }
  function saveSub(sub){
    localStorage.setItem(LS_SUB, JSON.stringify(sub));
  }

  function monthsBetween(startDateStr){
    if(!startDateStr) return 0;
    const start = new Date(startDateStr);
    const now = new Date();
    if(isNaN(start.getTime())) return 0;
    let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    if(now.getDate() >= start.getDate()) months += 1; // count current partial cycle as billed
    return Math.max(months, 1);
  }

  function render(){
    const movies = loadMovies();
    const sub = loadSub();

    // Populate subscription fields if not actively being edited
    if(document.activeElement !== $('monthlyCost')) $('monthlyCost').value = sub.monthlyCost ?? '';
    if(document.activeElement !== $('startDate')) $('startDate').value = sub.startDate ?? '';

    const cyclesToUse = monthsBetween(sub.startDate);
    $('cyclesHint').textContent = sub.startDate
      ? `Assuming you've been billed every month since ${sub.startDate} — that's ${cyclesToUse} cycle(s) so far.`
      : `Set your first billing date above — we'll assume a cycle every month since then.`;

    const ticketValue = movies.reduce((sum, m) => sum + Number(m.price || 0), 0);
    const subCost = (Number(sub.monthlyCost) || 0) * (cyclesToUse || 0);
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

    const headline = $('headlineNumber');
    const headlineSub = $('headlineSub');
    if(movies.length === 0){
      headline.textContent = '$0';
      headline.classList.remove('negative');
      headlineSub.textContent = 'log a movie to get started';
    } else if(net >= 0){
      headline.textContent = fmtMoney(net);
      headline.classList.remove('negative');
      headlineSub.textContent = `saved vs. paying per ticket`;
      document.title = `${fmtMoney(net)} saved — A-List Ledger`;
    } else {
      headline.textContent = `-${fmtMoney(Math.abs(net))}`;
      headline.classList.add('negative');
      headlineSub.textContent = `you're behind — watch a few more!`;
    }

    // Render stubs, newest first
    const list = $('stubList');
    if(movies.length === 0){
      list.innerHTML = '<div class="empty-state">No movies logged yet. Add your first ticket stub on the left.</div>';
      return;
    }
    const sorted = [...movies].sort((a,b) => (b.date || '').localeCompare(a.date || ''));
    list.innerHTML = sorted.map(m => {
      const poster = m.posterPath ? `<img class="stub-poster" src="${TMDB_IMG}${m.posterPath}" alt="" loading="lazy">` : '';
      const metaBits = [];
      metaBits.push(m.date || '—');
      if(m.runtime) metaBits.push(`${m.runtime} min`);
      if(m.director) metaBits.push(`Dir. ${escapeHtml(m.director)}`);
      if(m.rating) metaBits.push(`★ ${Number(m.rating).toFixed(1)}`);
      const genreLine = (m.genres && m.genres.length) ? `<div class="stub-meta">${escapeHtml(m.genres.join(', '))}</div>` : '';
      return `
      <div class="stub" data-id="${m.id}">
        <div class="stub-main">
          <div class="stub-title-row">
            ${poster}
            <div>
              <div class="stub-title">${escapeHtml(m.title || 'Untitled')}</div>
              <div class="stub-meta">${metaBits.join(' · ')}</div>
              ${genreLine}
            </div>
          </div>
        </div>
        <div class="stub-amount">
          <span class="val">${fmtMoney(Number(m.price || 0))}</span>
          <button class="stub-del" data-del="${m.id}">Remove</button>
        </div>
      </div>
    `;
    }).join('');

    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del');
        const updated = loadMovies().filter(m => String(m.id) !== String(id));
        saveMovies(updated);
        render();
      });
    });
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  $('addMovieBtn').addEventListener('click', () => {
    const title = $('movieTitle').value.trim();
    const date = $('movieDate').value;
    const price = parseFloat($('moviePrice').value);

    if(!price || price <= 0){
      $('moviePrice').focus();
      return;
    }
    const movies = loadMovies();
    const meta = selectedMovie && selectedMovie.title.toLowerCase() === title.toLowerCase() ? selectedMovie : null;
    movies.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2,7),
      title: title || 'Untitled',
      date: date || '',
      price: price,
      posterPath: meta ? meta.posterPath : '',
      director: meta ? meta.director : '',
      genres: meta ? meta.genres : [],
      runtime: meta ? meta.runtime : null,
      rating: meta ? meta.rating : null,
      releaseDate: meta ? meta.releaseDate : ''
    });
    saveMovies(movies);

    $('movieTitle').value = '';
    $('movieDate').value = '';
    $('moviePrice').value = '';
    selectedMovie = null;
    renderSelectedMeta();
    $('movieTitle').focus();
    render();
  });

  $('saveSubBtn').addEventListener('click', () => {
    const monthlyCost = parseFloat($('monthlyCost').value) || 0;
    const startDate = $('startDate').value || '';
    saveSub({ monthlyCost, startDate });
    render();
  });

  // Allow Enter key to submit movie form from any of its fields
  ['movieTitle','movieDate','moviePrice'].forEach(id => {
    $(id).addEventListener('keydown', (e) => {
      if(e.key === 'Enter'){ e.preventDefault(); $('addMovieBtn').click(); }
    });
  });

  render();
})();