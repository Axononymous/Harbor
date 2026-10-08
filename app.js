(() => {
  "use strict";

  const REPOSITORY = "Axononymous/Harbor";
  const BRANCH = "main";
  const API_GAMES_URL = `https://api.github.com/repos/${REPOSITORY}/contents/games?ref=${BRANCH}`;
  const API_TREE_URL = `https://api.github.com/repos/${REPOSITORY}/git/trees/${BRANCH}?recursive=1`;
  const CDN_GAMES_URL = `https://cdn.jsdelivr.net/gh/${REPOSITORY}@${BRANCH}/games/`;
  const CACHE_KEY = "harbor.library.v1";
  const PREFERENCES_KEY = "harbor.preferences.v1";
  const FAVORITES_KEY = "harbor.favorites.v1";
  const RECENTS_KEY = "harbor.recents.v1";
  const METADATA_KEY = "harbor.metadata.v1";
  const CACHE_MAX_AGE = 6 * 60 * 60 * 1000;
  const MAX_RECENTS = 24;
  const REQUEST_TIMEOUT = 12000;
  const HTML_PRIORITY = ["index.html", "index.htm", "game.html", "game.htm", "play.html", "main.html", "start.html"];
  const METADATA_PRIORITY = ["metadata.json", "game.json", "info.json"];
  const DEFAULT_SETTINGS = Object.freeze({
    theme: "dark",
    accent: "violet",
    animations: true,
    reducedMotion: false,
    sidebarCollapsed: false,
    launchMode: "harbor",
  });

  const MARKUP = {
    mark: '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M8 11.5 20 5l12 6.5v17L20 35 8 28.5v-17Z"/><path d="M14 23.5V16l6-3.2 6 3.2v7.5l-6 3.2-6-3.2Z"/><path d="M8.5 12 20 18.3 31.5 12M20 18.5v15"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.8 2.5 5.1 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.8Z"/></svg>',
  };

  const dom = {
    root: document.documentElement,
    shell: document.querySelector("#app-shell"),
    boot: document.querySelector("#boot-screen"),
    bootCaption: document.querySelector("#boot-caption"),
    sidebar: document.querySelector("#sidebar"),
    scrim: document.querySelector("#mobile-scrim"),
    search: document.querySelector("#game-search"),
    settings: document.querySelector("#settings-dialog"),
    toast: document.querySelector("#toast"),
    status: document.querySelector(".library-status"),
    refresh: document.querySelector(".refresh-button"),
    notice: document.querySelector("#library-notice"),
    frame: document.querySelector("#game-frame"),
    stage: document.querySelector("#player-stage"),
    playerLoading: document.querySelector("#player-loading"),
    playerLoadingCopy: document.querySelector("#player-loading-copy"),
    playerError: document.querySelector("#player-error"),
    playerErrorTitle: document.querySelector("#player-error-title"),
    playerErrorCopy: document.querySelector("#player-error-copy"),
    playerTitle: document.querySelector("#player-title"),
    views: [...document.querySelectorAll("[data-view]")],
  };

  const state = {
    games: [],
    gameById: new Map(),
    favorites: new Set(readStringArray(FAVORITES_KEY)),
    recents: readStringArray(RECENTS_KEY),
    settings: readSettings(),
    metadata: readRecord(METADATA_KEY),
    metadataRequested: new Set(),
    metadataObserver: null,
    page: "home",
    query: "",
    currentGame: null,
    loadToken: 0,
    loadTimeout: 0,
    refreshPromise: null,
    isLoading: false,
    loadError: "",
    cacheTimestamp: 0,
    toastTimeout: 0,
  };

  function readStorage(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (value === null) return fallback;
      const parsed = JSON.parse(value);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function readStringArray(key) {
    const value = readStorage(key, []);
    return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 200) : [];
  }

  function readRecord(key) {
    const value = readStorage(key, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      showToast("Browser storage is unavailable. Your changes may not be saved.");
      return false;
    }
  }

  function readSettings() {
    const stored = readStorage(PREFERENCES_KEY, {});
    const settings = { ...DEFAULT_SETTINGS, ...(stored && typeof stored === "object" ? stored : {}) };
    if (!["dark", "light"].includes(settings.theme)) settings.theme = DEFAULT_SETTINGS.theme;
    if (!["violet", "blue", "mint", "amber"].includes(settings.accent)) settings.accent = DEFAULT_SETTINGS.accent;
    if (!["harbor", "tab"].includes(settings.launchMode)) settings.launchMode = DEFAULT_SETTINGS.launchMode;
    for (const key of ["animations", "reducedMotion", "sidebarCollapsed"]) settings[key] = Boolean(settings[key]);
    return settings;
  }

  function persistSettings() {
    writeStorage(PREFERENCES_KEY, state.settings);
    applySettings();
  }

  function applySettings() {
    dom.root.dataset.theme = state.settings.theme;
    dom.root.dataset.accent = state.settings.accent;
    dom.root.dataset.motion = state.settings.animations && !state.settings.reducedMotion ? "on" : "off";
    dom.shell.dataset.sidebar = state.settings.sidebarCollapsed ? "collapsed" : "expanded";
    syncSettingsControls();
    const collapseButton = document.querySelector(".sidebar-collapse");
    if (collapseButton) {
      const collapsed = state.settings.sidebarCollapsed;
      collapseButton.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
      collapseButton.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    }
  }

  function syncSettingsControls() {
    const controls = {
      "#setting-theme": state.settings.theme,
      "#setting-accent": state.settings.accent,
      "#setting-animations": state.settings.animations,
      "#setting-reduced-motion": state.settings.reducedMotion,
      "#setting-sidebar": state.settings.sidebarCollapsed,
      "#setting-launch-mode": state.settings.launchMode,
    };
    for (const [selector, value] of Object.entries(controls)) {
      const control = document.querySelector(selector);
      if (!control) continue;
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
    }
  }

  function isMobileLayout() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  function safeRepoPath(value) {
    if (typeof value !== "string" || !value.startsWith("games/")) return false;
    const segments = value.split("/");
    return segments.length > 1 && segments.every((part) => part && part !== "." && part !== "..");
  }

  function encodeRepoPath(path) {
    if (!safeRepoPath(path)) throw new Error("The repository returned an invalid game path.");
    return path.split("/").slice(1).map(encodeURIComponent).join("/");
  }

  function cdnURL(path) {
    return `${CDN_GAMES_URL}${encodeRepoPath(path)}`;
  }

  function displayName(value) {
    const base = value.split("/").pop().replace(/\.(html?|json)$/i, "");
    const spaced = base.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim();
    return spaced.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()) || "Untitled game";
  }

  function isHtmlPath(path) {
    return /\.html?$/i.test(path);
  }

  function preferredHtmlPath(paths) {
    const htmlPaths = [...new Set(paths.filter((path) => safeRepoPath(path) && isHtmlPath(path)))];
    htmlPaths.sort((a, b) => {
      const aName = a.split("/").pop().toLowerCase();
      const bName = b.split("/").pop().toLowerCase();
      const aRank = HTML_PRIORITY.indexOf(aName);
      const bRank = HTML_PRIORITY.indexOf(bName);
      const rankA = aRank < 0 ? HTML_PRIORITY.length : aRank;
      const rankB = bRank < 0 ? HTML_PRIORITY.length : bRank;
      const depthA = a.split("/").length;
      const depthB = b.split("/").length;
      return rankA - rankB || depthA - depthB || a.localeCompare(b);
    });
    return htmlPaths[0] || "";
  }

  function preferredMetadataPath(paths) {
    const candidates = paths.filter((path) => safeRepoPath(path) && METADATA_PRIORITY.includes(path.split("/").pop().toLowerCase()));
    candidates.sort((a, b) => {
      const rankA = METADATA_PRIORITY.indexOf(a.split("/").pop().toLowerCase());
      const rankB = METADATA_PRIORITY.indexOf(b.split("/").pop().toLowerCase());
      return rankA - rankB || a.split("/").length - b.split("/").length || a.localeCompare(b);
    });
    return candidates[0] || "";
  }

  function createGameRecords(rootEntries, filePaths) {
    const groups = new Map();
    for (const entry of rootEntries) {
      if (entry?.type === "dir" && typeof entry.name === "string") {
        const folderPath = `games/${entry.name}`;
        if (safeRepoPath(folderPath)) groups.set(folderPath, { id: folderPath, path: folderPath, folder: true, label: entry.name, files: [] });
      } else if (entry?.type === "file" && typeof entry.path === "string" && isHtmlPath(entry.path) && safeRepoPath(entry.path)) {
        groups.set(entry.path, { id: entry.path, path: entry.path, folder: false, label: entry.name || entry.path.split("/").pop(), files: [entry.path] });
      }
    }

    for (const filePath of filePaths) {
      if (!safeRepoPath(filePath)) continue;
      const relative = filePath.slice("games/".length);
      const segments = relative.split("/");
      if (segments.length < 2) {
        if (isHtmlPath(filePath)) {
          const existing = groups.get(filePath);
          if (existing && !existing.files.includes(filePath)) existing.files.push(filePath);
        }
        continue;
      }
      const folderPath = `games/${segments[0]}`;
      const group = groups.get(folderPath);
      if (group && !group.files.includes(filePath)) group.files.push(filePath);
    }

    const games = [];
    for (const group of groups.values()) {
      const htmlPath = preferredHtmlPath(group.files);
      if (!htmlPath) continue;
      const metadataPath = preferredMetadataPath(group.files);
      const title = displayName(group.label);
      const directoryPath = group.folder ? group.path : "games";
      games.push({
        id: group.id,
        path: group.path,
        directoryPath,
        htmlPath,
        metadataPath,
        title,
        description: "Launch from your Harbor library.",
        genre: "",
        artwork: "",
        metadataLoaded: false,
      });
    }
    games.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));
    return games;
  }

  async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("The request timed out. Check your connection and try again.");
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function fetchApiJson(url) {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!response.ok) {
      const error = new Error(apiErrorMessage(response));
      error.status = response.status;
      error.rateLimited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      throw error;
    }
    return response.json();
  }

  function apiErrorMessage(response) {
    if (response.status === 404) return "GitHub could not find the public games folder. Check that the repository and games/ directory are available.";
    if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const resetText = reset ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : " Try again shortly.";
      return `GitHub's unauthenticated API limit was reached.${resetText}`;
    }
    if (response.status === 403) return "GitHub denied access. Confirm the repository is public and available, then retry.";
    if (response.status >= 500) return "GitHub is temporarily unavailable. Your saved library can still be used.";
    return `GitHub returned an unexpected response (${response.status}). Please try again.`;
  }

  async function collectByContents(rootEntries) {
    const queue = rootEntries
      .filter((entry) => entry?.type === "dir" && typeof entry.name === "string")
      .map((entry) => ({ path: `games/${entry.name}`, depth: 0 }));
    const found = [];
    let requests = 0;
    const maxRequests = 80;

    async function worker() {
      while (queue.length && requests < maxRequests) {
        const current = queue.shift();
        if (!current || current.depth > 5) continue;
        requests += 1;
        const url = `https://api.github.com/repos/${REPOSITORY}/contents/${current.path.split("/").map(encodeURIComponent).join("/")}?ref=${BRANCH}`;
        try {
          const entries = await fetchApiJson(url);
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (entry?.type === "file" && typeof entry.path === "string" && safeRepoPath(entry.path)) found.push(entry.path);
            else if (entry?.type === "dir" && typeof entry.path === "string" && safeRepoPath(entry.path) && current.depth < 5) queue.push({ path: entry.path, depth: current.depth + 1 });
          }
        } catch (error) {
          if (error?.rateLimited) throw error;
        }
      }
    }

    await Promise.all([worker(), worker(), worker(), worker()]);
    if (requests >= maxRequests && queue.length) throw new Error("The repository has an unusually deep game folder. Try again after the library has been simplified.");
    return found;
  }

  async function discoverGames() {
    const rootEntries = await fetchApiJson(API_GAMES_URL);
    if (!Array.isArray(rootEntries)) throw new Error("GitHub returned an unreadable games folder. Please try again.");
    const rootHtml = rootEntries
      .filter((entry) => entry?.type === "file" && typeof entry.path === "string" && isHtmlPath(entry.path) && safeRepoPath(entry.path))
      .map((entry) => entry.path);
    const directories = rootEntries.filter((entry) => entry?.type === "dir");
    let allFilePaths = [...rootHtml];

    if (directories.length) {
      let treeRead = false;
      try {
        const tree = await fetchApiJson(API_TREE_URL);
        if (tree && Array.isArray(tree.tree) && tree.truncated !== true) {
          allFilePaths.push(...tree.tree
            .filter((entry) => entry?.type === "blob" && typeof entry.path === "string" && entry.path.startsWith("games/") && safeRepoPath(entry.path))
            .map((entry) => entry.path));
          treeRead = true;
        }
      } catch (error) {
        if (error?.rateLimited) throw error;
      }
      if (!treeRead) allFilePaths.push(...await collectByContents(rootEntries));
    }

    return createGameRecords(rootEntries, allFilePaths);
  }

  function validCachedGames(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((game) => game && typeof game === "object" && safeRepoPath(game.path) && safeRepoPath(game.htmlPath) && typeof game.id === "string")
      .map((game) => ({
        id: game.id,
        path: game.path,
        directoryPath: safeRepoPath(game.directoryPath) ? game.directoryPath : "games",
        htmlPath: game.htmlPath,
        metadataPath: safeRepoPath(game.metadataPath) ? game.metadataPath : "",
        title: typeof game.title === "string" ? game.title.slice(0, 120) : displayName(game.path),
        description: typeof game.description === "string" ? game.description.slice(0, 300) : "Launch from your Harbor library.",
        genre: typeof game.genre === "string" ? game.genre.slice(0, 80) : "",
        artwork: typeof game.artwork === "string" ? game.artwork.slice(0, 1000) : "",
        metadataLoaded: Boolean(game.metadataLoaded),
      }));
  }

  function hydrateMetadataCache() {
    for (const game of state.games) {
      const data = state.metadata[game.id];
      if (data && typeof data === "object") applyMetadata(game, data, false);
    }
  }

  function setGames(games) {
    state.games = validCachedGames(games);
    state.gameById = new Map(state.games.map((game) => [game.id, game]));
    state.metadataRequested.clear();
    hydrateMetadataCache();
    renderAll();
  }

  function cacheGames(games) {
    const cacheSafe = games.map(({ id, path, directoryPath, htmlPath, metadataPath, title, description, genre, artwork }) => ({
      id, path, directoryPath, htmlPath, metadataPath, title, description, genre, artwork,
    }));
    writeStorage(CACHE_KEY, { savedAt: Date.now(), games: cacheSafe });
  }

  function validCache() {
    const saved = readStorage(CACHE_KEY, null);
    if (!saved || typeof saved !== "object" || !Array.isArray(saved.games)) return null;
    return { savedAt: Number(saved.savedAt) || 0, games: validCachedGames(saved.games) };
  }

  async function refreshLibrary() {
    if (state.refreshPromise) return state.refreshPromise;
    state.isLoading = true;
    renderStatus();
    renderNotice();
    if (dom.boot && !dom.shell.classList.contains("is-ready")) dom.bootCaption.textContent = "Finding games in the repository";
    dom.refresh?.classList.add("is-loading");
    if (dom.refresh) dom.refresh.setAttribute("aria-label", "Refreshing game library");

    state.refreshPromise = (async () => {
      try {
        const games = await discoverGames();
        setGames(games);
        state.cacheTimestamp = Date.now();
        state.loadError = "";
        cacheGames(games);
        renderAll();
        renderStatus();
        renderNotice();
        return games;
      } catch (error) {
        state.loadError = error instanceof Error ? error.message : "The game library could not be loaded.";
        renderAll();
        renderStatus();
        renderNotice();
        return null;
      } finally {
        state.isLoading = false;
        state.refreshPromise = null;
        dom.refresh?.classList.remove("is-loading");
        if (dom.refresh) dom.refresh.setAttribute("aria-label", "Refresh game library");
        renderStatus();
      }
    })();
    return state.refreshPromise;
  }

  function setApplicationReady() {
    dom.shell.classList.add("is-ready");
    dom.shell.setAttribute("aria-hidden", "false");
    dom.shell.removeAttribute("inert");
    dom.boot.classList.add("is-done");
    if (window.parent !== window) window.parent.postMessage({ type: "harbor-ready", version: 1 }, "*");
    window.setTimeout(() => dom.boot?.remove(), 650);
  }

  function saveFavorites() {
    writeStorage(FAVORITES_KEY, [...state.favorites]);
  }

  function saveRecents() {
    writeStorage(RECENTS_KEY, state.recents);
  }

  function getFavoriteGames() {
    return state.games.filter((game) => state.favorites.has(game.id));
  }

  function getRecentGames() {
    return state.recents.map((id) => state.gameById.get(id)).filter(Boolean);
  }

  function matchesQuery(game) {
    const query = state.query.trim().toLocaleLowerCase();
    if (!query) return true;
    return [game.title, game.description, game.genre, game.path].some((value) => String(value || "").toLocaleLowerCase().includes(query));
  }

  function setPage(page, persist = true) {
    const validPages = ["home", "games", "favorites", "recent"];
    if (!validPages.includes(page)) page = "home";
    if (state.currentGame) {
      stopGameSession();
      state.currentGame = null;
    }
    state.page = page;
    for (const view of dom.views) {
      const active = view.dataset.view === page;
      view.classList.toggle("is-visible", active);
      view.setAttribute("aria-hidden", String(!active));
    }
    for (const button of document.querySelectorAll(".nav-item[data-page]")) {
      button.classList.toggle("is-active", button.dataset.page === page);
    }
    const titles = { home: "Home", games: "All games", favorites: "Favorites", recent: "Recently played" };
    document.querySelector("#context-title").textContent = titles[page];
    if (persist) writeStorage("harbor.last-page.v1", page);
    closeMobileNav();
    renderPage(page);
  }

  function showPlayerView() {
    for (const view of dom.views) {
      const active = view.dataset.view === "player";
      view.classList.toggle("is-visible", active);
      view.setAttribute("aria-hidden", String(!active));
    }
    document.querySelector("#context-title").textContent = "Now playing";
    closeMobileNav();
  }

  function closeMobileNav() {
    dom.shell.classList.remove("is-nav-open");
    document.querySelector(".mobile-menu")?.setAttribute("aria-expanded", "false");
    dom.sidebar.setAttribute("aria-hidden", String(isMobileLayout()));
  }

  function toggleMobileNav() {
    const open = !dom.shell.classList.contains("is-nav-open");
    dom.shell.classList.toggle("is-nav-open", open);
    document.querySelector(".mobile-menu")?.setAttribute("aria-expanded", String(open));
    dom.sidebar.setAttribute("aria-hidden", String(isMobileLayout() && !open));
  }

  function createGameCard(game, index = 0) {
    const article = document.createElement("article");
    article.className = "game-card";
    article.dataset.gameId = game.id;
    article.style.setProperty("--card-delay", `${Math.min(index, 12) * 38}ms`);

    const artButton = document.createElement("button");
    artButton.className = "card-art";
    artButton.type = "button";
    artButton.dataset.action = "launch-game";
    artButton.dataset.gameId = game.id;
    artButton.setAttribute("aria-label", `Launch ${game.title}`);
    const placeholder = document.createElement("span");
    placeholder.className = "card-placeholder";
    placeholder.innerHTML = MARKUP.mark;
    const image = document.createElement("img");
    image.className = "card-image";
    image.alt = "";
    image.loading = "lazy";
    image.hidden = true;
    image.dataset.artwork = "true";
    const favoriteButton = document.createElement("button");
    favoriteButton.className = `card-favorite${state.favorites.has(game.id) ? " is-favorite" : ""}`;
    favoriteButton.type = "button";
    favoriteButton.dataset.action = "toggle-favorite";
    favoriteButton.dataset.gameId = game.id;
    favoriteButton.setAttribute("aria-label", state.favorites.has(game.id) ? `Remove ${game.title} from favorites` : `Add ${game.title} to favorites`);
    favoriteButton.setAttribute("aria-pressed", String(state.favorites.has(game.id)));
    favoriteButton.innerHTML = MARKUP.star;
    artButton.append(placeholder, image);

    const content = document.createElement("div");
    content.className = "card-content";
    const details = document.createElement("div");
    details.className = "card-details";
    const title = document.createElement("h3");
    title.className = "card-title";
    title.dataset.cardTitle = "true";
    title.textContent = game.title;
    const description = document.createElement("p");
    description.className = "card-description";
    description.dataset.cardDescription = "true";
    description.textContent = game.genre || game.description;
    details.append(title, description);
    const playButton = document.createElement("button");
    playButton.className = "card-play";
    playButton.type = "button";
    playButton.dataset.action = "launch-game";
    playButton.dataset.gameId = game.id;
    playButton.setAttribute("aria-label", `Play ${game.title}`);
    playButton.innerHTML = MARKUP.play;
    content.append(details, playButton);
    article.append(artButton, favoriteButton, content);

    if (game.artwork) setCardArtwork(article, game);
    else if (game.metadataPath) observeMetadata(article, game);
    return article;
  }

  function createCards(games, limit = Infinity) {
    const fragment = document.createDocumentFragment();
    const visible = games.slice(0, limit);
    visible.forEach((game, index) => fragment.append(createGameCard(game, index)));
    return fragment;
  }

  function observeMetadata(card, game) {
    if (!game.metadataPath || game.metadataLoaded || state.metadataRequested.has(game.id)) return;
    if (!state.metadataObserver && "IntersectionObserver" in window) {
      state.metadataObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target;
          state.metadataObserver.unobserve(target);
          const targetGame = state.gameById.get(target.dataset.gameId);
          if (targetGame) loadMetadata(targetGame);
        }
      }, { rootMargin: "100px" });
    }
    if (state.metadataObserver) state.metadataObserver.observe(card);
    else loadMetadata(game);
  }

  function normalizeMetadata(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const take = (...keys) => {
      for (const key of keys) if (typeof raw[key] === "string" && raw[key].trim()) return raw[key].trim().slice(0, 600);
      return "";
    };
    return {
      title: take("title", "name"),
      description: take("description", "summary", "about"),
      genre: take("genre", "category"),
      artwork: take("thumbnail", "image", "icon", "cover"),
    };
  }

  function resolveArtwork(game, value) {
    if (!value) return "";
    try {
      const absolute = new URL(value, window.location.href);
      if (["https:", "http:"].includes(absolute.protocol) && /^(https?:)?\/\//i.test(value)) return absolute.href;
    } catch {
      return "";
    }
    const relative = value.replace(/^\.\//, "").replace(/^\/+/, "");
    const parts = relative.split("/");
    if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) return "";
    const base = game.directoryPath === "games" ? "" : `${game.directoryPath.slice("games/".length)}/`;
    return `${CDN_GAMES_URL}${base}${parts.map(encodeURIComponent).join("/")}`;
  }

  function applyMetadata(game, metadata, save = true) {
    if (!metadata || typeof metadata !== "object") return;
    if (typeof metadata.title === "string" && metadata.title.trim()) game.title = metadata.title.trim().slice(0, 120);
    if (typeof metadata.description === "string" && metadata.description.trim()) game.description = metadata.description.trim().slice(0, 300);
    if (typeof metadata.genre === "string") game.genre = metadata.genre.trim().slice(0, 80);
    if (typeof metadata.artwork === "string") game.artwork = resolveArtwork(game, metadata.artwork);
    game.metadataLoaded = true;
    if (save) {
      state.metadata[game.id] = metadata;
      writeStorage(METADATA_KEY, state.metadata);
      renderAll();
    }
  }

  async function loadMetadata(game) {
    if (!game.metadataPath || state.metadataRequested.has(game.id)) return;
    state.metadataRequested.add(game.id);
    const cached = state.metadata[game.id];
    if (cached && typeof cached === "object") {
      applyMetadata(game, cached, false);
      return;
    }
    try {
      const response = await fetchWithTimeout(cdnURL(game.metadataPath), { cache: "force-cache" }, 8000);
      if (!response.ok) return;
      const raw = await response.json();
      const metadata = normalizeMetadata(raw);
      if (metadata) applyMetadata(game, metadata, true);
    } catch {
      // Metadata is optional; the derived name and artwork fallback remain usable.
    }
  }

  function setCardArtwork(card, game) {
    const image = card.querySelector("[data-artwork]");
    if (!image || !game.artwork) return;
    image.onload = () => { image.hidden = false; };
    image.onerror = () => { image.hidden = true; };
    image.src = game.artwork;
  }

  function updateCardMetadata(game) {
    for (const card of document.querySelectorAll(".game-card")) {
      if (card.dataset.gameId !== game.id) continue;
      const title = card.querySelector("[data-card-title]");
      const description = card.querySelector("[data-card-description]");
      const artButton = card.querySelector(".card-art");
      const favorite = card.querySelector(".card-favorite");
      const play = card.querySelector(".card-play");
      if (title) title.textContent = game.title;
      if (description) description.textContent = game.genre || game.description;
      if (artButton) artButton.setAttribute("aria-label", `Launch ${game.title}`);
      if (favorite) favorite.setAttribute("aria-label", state.favorites.has(game.id) ? `Remove ${game.title} from favorites` : `Add ${game.title} to favorites`);
      if (play) play.setAttribute("aria-label", `Play ${game.title}`);
      setCardArtwork(card, game);
    }
  }

  function renderGameList(containerId, games, limit = Infinity) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.replaceChildren(createCards(games, limit));
  }

  function renderFeature() {
    const container = document.querySelector("#featured-game");
    if (!container) return;
    const game = state.games.find(matchesQuery) || state.games[0];
    container.replaceChildren();
    container.classList.remove("has-image");
    if (!game) {
      container.hidden = true;
      delete container.dataset.gameId;
      return;
    }
    container.hidden = false;
    container.dataset.gameId = game.id;
    const mark = document.createElement("span");
    mark.className = "featured-mark";
    mark.innerHTML = MARKUP.mark;
    const copy = document.createElement("div");
    copy.className = "featured-copy";
    const details = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = "From your library";
    const title = document.createElement("strong");
    title.textContent = game.title;
    details.append(label, title);
    const launch = document.createElement("button");
    launch.className = "featured-launch";
    launch.type = "button";
    launch.dataset.action = "launch-game";
    launch.dataset.gameId = game.id;
    launch.setAttribute("aria-label", `Launch ${game.title}`);
    launch.innerHTML = MARKUP.play;
    copy.append(details, launch);
    container.append(mark, copy);
    if (game.artwork) {
      container.classList.add("has-image");
      const image = document.createElement("img");
      image.className = "hero-feature-image";
      image.alt = "";
      image.src = game.artwork;
      image.onerror = () => {
        image.remove();
        container.classList.remove("has-image");
      };
      container.prepend(image);
    } else {
      container.classList.remove("has-image");
    }
    if (game.metadataPath && !game.artwork) loadMetadata(game);
  }

  function setSectionVisible(id, visible) {
    const section = document.getElementById(id);
    if (section) section.hidden = !visible;
  }

  function renderHome() {
    const filtered = state.games.filter(matchesQuery);
    const recent = getRecentGames().filter(matchesQuery);
    const favorites = getFavoriteGames().filter(matchesQuery);
    setSectionVisible("recent-section", recent.length > 0);
    setSectionVisible("favorites-section", favorites.length > 0);
    renderGameList("home-recent-grid", recent, 4);
    renderGameList("home-favorites-grid", favorites, 4);
    renderGameList("home-games-grid", filtered, 8);
    renderFeature();

    const empty = document.querySelector("#home-empty");
    empty.hidden = filtered.length > 0;
    document.querySelector("#home-games-grid").hidden = filtered.length === 0;
    document.querySelector("#home-empty-title").textContent = state.loadError ? "Your library could not be reached" : state.query ? "No games match that search" : "Your library is ready for games";
    document.querySelector("#home-empty-copy").textContent = state.loadError || (state.query ? "Try another title, or clear your search to see the full library." : "Harbor checks the repository's games folder and will show every playable game here.");
    document.querySelector("#hero-game-count").textContent = String(state.games.length);
  }

  function renderGamesPage() {
    const filtered = state.games.filter(matchesQuery);
    renderGameList("games-grid", filtered);
    document.querySelector("#games-grid").hidden = filtered.length === 0;
    document.querySelector("#games-empty").hidden = filtered.length > 0;
    document.querySelector("#games-result-count").textContent = `${filtered.length} ${filtered.length === 1 ? "title" : "titles"}`;
    document.querySelector("#games-subtitle").textContent = state.query ? `Search results for “${state.query.trim()}”.` : "Every game available in the Harbor repository.";
    document.querySelector("#games-empty-title").textContent = state.loadError && state.games.length === 0 ? "The game library is unavailable" : state.query ? "No games found" : "No playable games found";
    document.querySelector("#games-empty-copy").textContent = state.loadError && state.games.length === 0 ? state.loadError : state.query ? "Try a different search, or refresh the library." : "The games folder does not contain any HTML game pages yet. Refresh after adding a game.";
    const clearButton = document.querySelector("#games-empty [data-action='clear-search']");
    clearButton.hidden = !state.query;
  }

  function renderCollectionPage(type) {
    const isFavorites = type === "favorites";
    const source = isFavorites ? getFavoriteGames() : getRecentGames();
    const filtered = source.filter(matchesQuery);
    const containerId = isFavorites ? "favorites-grid" : "recent-grid";
    const emptyId = isFavorites ? "favorites-empty" : "recent-empty";
    renderGameList(containerId, filtered);
    document.getElementById(containerId).hidden = filtered.length === 0;
    document.getElementById(emptyId).hidden = filtered.length > 0;
    if (isFavorites) {
      document.querySelector("#favorites-empty-title").textContent = state.query ? "No favorites match that search" : "No favorites yet";
      document.querySelector("#favorites-empty-copy").textContent = state.query ? "Try a different search to find a saved game." : "Save a game with the star button and it will be waiting here.";
      document.querySelector("#favorites-empty [data-page='games']").hidden = Boolean(state.query);
    }
  }

  function renderPage(page) {
    if (page === "home") renderHome();
    else if (page === "games") renderGamesPage();
    else if (page === "favorites" || page === "recent") renderCollectionPage(page);
  }

  function renderCounts() {
    document.querySelector("#game-count").textContent = String(state.games.length);
    document.querySelector("#favorite-count").textContent = String(getFavoriteGames().length);
  }

  function renderStatus() {
    const libraryStatus = dom.status;
    if (!libraryStatus) return;
    libraryStatus.classList.remove("is-online", "is-offline");
    if (state.isLoading) {
      document.querySelector("#status-title").textContent = state.games.length ? "Updating library" : "Connecting";
      document.querySelector("#status-detail").textContent = state.games.length ? `${state.games.length} games cached` : "Checking the repository";
    } else if (state.loadError) {
      libraryStatus.classList.add("is-offline");
      document.querySelector("#status-title").textContent = state.games.length ? "Using saved library" : "Not connected";
      document.querySelector("#status-detail").textContent = state.games.length ? `${state.games.length} games available` : "Could not reach GitHub";
    } else {
      libraryStatus.classList.add("is-online");
      document.querySelector("#status-title").textContent = state.games.length ? "Library ready" : "No games yet";
      document.querySelector("#status-detail").textContent = state.games.length ? `${state.games.length} games discovered` : "Waiting for game pages";
    }
    renderCounts();
  }

  function renderNotice() {
    if (!state.loadError) {
      dom.notice.hidden = true;
      dom.notice.replaceChildren();
      return;
    }
    dom.notice.hidden = false;
    dom.notice.replaceChildren();
    const copy = document.createElement("span");
    copy.className = "notice-copy";
    const heading = document.createElement("strong");
    heading.textContent = state.games.length ? "Library refresh failed. " : "Library unavailable. ";
    copy.append(heading, document.createTextNode(state.games.length ? `Showing your saved games. ${state.loadError}` : state.loadError));
    const retry = document.createElement("button");
    retry.className = "notice-action";
    retry.type = "button";
    retry.dataset.action = "refresh";
    retry.textContent = "Retry";
    dom.notice.append(copy, retry);
  }

  function renderAll() {
    state.metadataObserver?.disconnect();
    state.metadataObserver = null;
    renderCounts();
    renderPage("home");
    renderPage("games");
    renderPage("favorites");
    renderPage("recent");
    renderStatus();
    renderNotice();
  }

  function addRecent(game) {
    state.recents = [game.id, ...state.recents.filter((id) => id !== game.id)].slice(0, MAX_RECENTS);
    saveRecents();
    renderAll();
  }

  function toggleFavorite(game) {
    if (state.favorites.has(game.id)) {
      state.favorites.delete(game.id);
      showToast(`${game.title} removed from favorites.`);
    } else {
      state.favorites.add(game.id);
      showToast(`${game.title} added to favorites.`);
    }
    saveFavorites();
    renderAll();
  }

  function showToast(message) {
    if (!dom.toast) return;
    window.clearTimeout(state.toastTimeout);
    dom.toast.textContent = message;
    dom.toast.classList.add("is-visible");
    state.toastTimeout = window.setTimeout(() => dom.toast.classList.remove("is-visible"), 2800);
  }

  function setSearch(value) {
    state.query = value;
    if (state.currentGame) exitPlayer();
    if (value.trim() && state.page !== "games") setPage("games");
    else renderPage(state.page);
  }

  function normalizeLaunchError(error) {
    if (error?.status === 404) return "The game file is missing from the jsDelivr copy of the repository. It may have been renamed or not yet synced.";
    if (error?.status >= 500) return "jsDelivr is temporarily unavailable. Wait a moment and try again.";
    return error?.message || "The game could not be reached. Check your connection and try again.";
  }

  function openInNewTab(url, description = "game") {
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      showToast("Your browser blocked the new tab. Allow pop-ups and try again.");
      return false;
    }
    try {
      popup.opener = null;
      popup.location.replace(url);
      return true;
    } catch {
      try { popup.location.href = url; } catch { /* The browser may have closed the tab. */ }
      showToast(`Opening ${description} in a new tab.`);
      return true;
    }
  }

  function launchGame(game) {
    if (!game || !safeRepoPath(game.htmlPath)) {
      showToast("This repository entry does not contain a usable HTML game page.");
      return;
    }
    const url = cdnURL(game.htmlPath);
    addRecent(game);
    if (state.settings.launchMode === "tab") {
      openInNewTab(url, game.title);
      return;
    }

    state.currentGame = game;
    state.loadToken += 1;
    const token = state.loadToken;
    window.clearTimeout(state.loadTimeout);
    dom.playerTitle.textContent = game.title;
    dom.playerLoading.hidden = false;
    dom.playerLoadingCopy.textContent = "Checking the game file on jsDelivr";
    dom.playerError.hidden = true;
    dom.frame.hidden = true;
    showPlayerView();

    const checkAndOpen = async () => {
      try {
        const response = await fetchWithTimeout(url, { method: "HEAD", mode: "cors", cache: "no-store" }, REQUEST_TIMEOUT);
        if (!response.ok) {
          const error = new Error(`The game server returned ${response.status}.`);
          error.status = response.status;
          throw error;
        }
        if (token !== state.loadToken) return;
        dom.playerLoadingCopy.textContent = "Starting a secure game session";
        dom.frame.hidden = false;
        dom.frame.title = `${game.title} game player`;
        dom.frame.onload = () => {
          if (token !== state.loadToken) return;
          window.clearTimeout(state.loadTimeout);
          dom.playerLoading.hidden = true;
        };
        dom.frame.onerror = () => {
          if (token === state.loadToken) showPlayerError(game, "Your browser could not load this game frame. Try opening it in a separate tab.");
        };
        dom.frame.src = url;
        state.loadTimeout = window.setTimeout(() => {
          if (token === state.loadToken && !dom.playerLoading.hidden) showPlayerError(game, "The game took too long to respond. The CDN may be slow, or the page may not be a playable HTML file.");
        }, 20000);
      } catch (error) {
        if (token === state.loadToken) showPlayerError(game, normalizeLaunchError(error));
      }
    };
    checkAndOpen();
  }

  function showPlayerError(game, message) {
    window.clearTimeout(state.loadTimeout);
    dom.playerLoading.hidden = true;
    dom.frame.hidden = true;
    dom.playerErrorTitle.textContent = `Couldn't open ${game.title}`;
    dom.playerErrorCopy.textContent = message;
    dom.playerError.hidden = false;
  }

  function reloadGame() {
    if (state.currentGame) launchGame(state.currentGame);
  }

  function openCurrentGameInTab() {
    if (!state.currentGame) return;
    openInNewTab(cdnURL(state.currentGame.htmlPath), state.currentGame.title);
  }

  function exitPlayer() {
    stopGameSession();
    state.currentGame = null;
    setPage(state.page, false);
  }

  function stopGameSession() {
    state.loadToken += 1;
    window.clearTimeout(state.loadTimeout);
    dom.frame.onload = null;
    dom.frame.onerror = null;
    dom.frame.src = "about:blank";
    dom.frame.hidden = true;
    dom.playerLoading.hidden = true;
    dom.playerError.hidden = true;
  }

  async function enterFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await dom.stage.requestFullscreen();
    } catch {
      showToast("Fullscreen is unavailable in this browser.");
    }
  }

  function openSettings() {
    syncSettingsControls();
    if (!dom.settings.open) dom.settings.showModal();
  }

  function closeSettings() {
    if (dom.settings.open) dom.settings.close();
  }

  function clearRecent() {
    state.recents = [];
    saveRecents();
    renderAll();
    showToast("Recently played history cleared.");
  }

  function clearFavorites() {
    state.favorites.clear();
    saveFavorites();
    renderAll();
    showToast("Favorites cleared.");
  }

  function resetSettings() {
    state.settings = { ...DEFAULT_SETTINGS };
    persistSettings();
    showToast("Harbor settings reset.");
  }

  function handleSettingsChange(event) {
    const control = event.target;
    const mapping = {
      "setting-theme": "theme",
      "setting-accent": "accent",
      "setting-animations": "animations",
      "setting-reduced-motion": "reducedMotion",
      "setting-sidebar": "sidebarCollapsed",
      "setting-launch-mode": "launchMode",
    };
    const key = mapping[control.id];
    if (!key) return;
    state.settings[key] = control.type === "checkbox" ? control.checked : control.value;
    persistSettings();
  }

  function handleClick(event) {
    const target = event.target.closest("[data-action], [data-page], [data-page-link]");
    if (!target) return;
    if (target.matches("a[data-page-link]")) event.preventDefault();
    const action = target.dataset.action;
    const page = target.dataset.page || target.dataset.pageLink;
    const game = target.dataset.gameId ? state.gameById.get(target.dataset.gameId) : null;

    if (page) {
      setPage(page);
      return;
    }
    switch (action) {
      case "toggle-sidebar":
        if (isMobileLayout()) closeMobileNav();
        else {
          state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
          persistSettings();
        }
        break;
      case "open-mobile-nav": toggleMobileNav(); break;
      case "close-mobile-nav": closeMobileNav(); break;
      case "open-settings": openSettings(); break;
      case "close-settings": closeSettings(); break;
      case "refresh": refreshLibrary(); break;
      case "clear-search":
        dom.search.value = "";
        setSearch("");
        break;
      case "toggle-favorite": if (game) toggleFavorite(game); break;
      case "launch-game": if (game) launchGame(game); break;
      case "exit-player": exitPlayer(); break;
      case "reload-game": reloadGame(); break;
      case "open-game-tab": openCurrentGameInTab(); break;
      case "fullscreen": enterFullscreen(); break;
      case "clear-recent":
      case "clear-recent-page": clearRecent();
        if (action === "clear-recent-page") setPage("recent", false);
        break;
      case "clear-favorites": clearFavorites(); break;
      case "reset-settings": resetSettings(); break;
      default: break;
    }
  }

  function handleKeyboard(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      dom.search.focus();
    }
    if (event.key === "Escape" && dom.shell.classList.contains("is-nav-open")) closeMobileNav();
  }

  function onFullscreenChange() {
    const button = document.querySelector("[data-action='fullscreen']");
    const active = Boolean(document.fullscreenElement);
    button?.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    if (button) button.title = active ? "Exit fullscreen" : "Fullscreen";
  }

  async function initialize() {
    applySettings();
    syncSettingsControls();
    const cached = validCache();
    const savedPage = readStorage("harbor.last-page.v1", "home");
    if (["home", "games", "favorites", "recent"].includes(savedPage)) state.page = savedPage;

    if (cached) {
      state.cacheTimestamp = cached.savedAt;
      setGames(cached.games);
      setPage(state.page, false);
      setApplicationReady();
      if (Date.now() - cached.savedAt > CACHE_MAX_AGE) refreshLibrary();
      else {
        state.loadError = "";
        renderStatus();
      }
      return;
    }

    await refreshLibrary();
    setPage(state.page, false);
    setApplicationReady();
  }

  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleSettingsChange);
  document.addEventListener("keydown", handleKeyboard);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  dom.search.addEventListener("input", (event) => setSearch(event.target.value));
  window.addEventListener("resize", () => {
    if (!isMobileLayout()) {
      dom.shell.classList.remove("is-nav-open");
      dom.sidebar.setAttribute("aria-hidden", "false");
    } else {
      dom.sidebar.setAttribute("aria-hidden", String(!dom.shell.classList.contains("is-nav-open")));
    }
  });
  dom.settings.addEventListener("click", (event) => {
    if (event.target === dom.settings) closeSettings();
  });

    initialize();
})();
