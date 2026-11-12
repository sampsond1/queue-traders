(() => {
  "use strict";

  const config = window.QUEUE_EXCHANGE_CONFIG || {};
  if (!window.supabase || !config.supabaseUrl || !config.supabaseAnonKey) return;

  const client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const $ = (id) => document.getElementById(id);
  const state = { session: null, account: null, accountLoadError: false, portfolio: [], portfolioLoadError: false, portfolioBusy: false, selectedRide: null, signupMode: false };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function setAuthMessage(message, error = false) {
    const output = $("auth-message");
    output.textContent = message || "";
    output.classList.toggle("is-error", error);
  }

  function setUsernameMessage(message, error = false) {
    const output = $("username-message");
    output.textContent = message || "";
    output.classList.toggle("is-error", error);
  }

  async function callGameApi(body) {
    const { data, error } = await client.functions.invoke("game-api", { body });
    if (error) {
      let message = error.message || "Game service request failed.";
      if (error.context && typeof error.context.json === "function") {
        try {
          const responseBody = await error.context.json();
          if (responseBody?.error) message = responseBody.error;
        } catch { /* keep the SDK's error text */ }
      }
      throw new Error(message);
    }
    return data;
  }

  function renderAuth() {
    const signedIn = Boolean(state.session?.user);
    $("auth-open").hidden = signedIn;
    $("player-pill").hidden = !signedIn;
    if (signedIn) {
      $("player-name").textContent = state.account?.display_name || "Park rider";
      const credits = state.account?.credits;
      $("player-credits").textContent = Number.isFinite(Number(credits)) && credits !== null && credits !== undefined
        ? `${Number(credits).toLocaleString()} credits`
        : state.accountLoadError ? "Balance unavailable" : "Loading balance…";
    }
  }

  function credits(value, digits = 0) {
    return Number(value).toLocaleString([], { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function renderPortfolio() {
    const list = $("portfolio-list");
    const signedIn = Boolean(state.session?.user);
    const emptyMessage = !signedIn ? "Sign in to see your portfolio." : state.portfolioLoadError
      ? "Your portfolio could not be loaded. Try refreshing the page."
      : "No open positions yet. Pick a ride and buy your first share.";
    const cash = state.account ? Number(state.account.credits) : null;
    const shareValue = state.portfolio.reduce((total, position) => total + Number(position.market_value_credits || 0), 0);
    $("portfolio-cash").textContent = cash === null ? "—" : `${credits(cash)} cr`;
    $("portfolio-value").textContent = signedIn && !state.portfolioLoadError ? `${credits(shareValue)} cr` : "—";
    $("portfolio-net-worth").textContent = cash === null || state.portfolioLoadError ? "—" : `${credits(cash + shareValue)} cr`;
    list.replaceChildren();

    if (!state.portfolio.length) {
      const item = document.createElement("li");
      item.className = "portfolio-empty";
      item.textContent = emptyMessage;
      list.appendChild(item);
      return;
    }

    for (const position of state.portfolio) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const value = Number(position.market_value_credits || 0);
      const profit = Number(position.unrealized_profit_credits || 0);
      const operating = position.status === "OPERATING" && position.wait_minutes !== null;
      const parkName = position.park_slug === "disneyland" ? "Disneyland" : "California Adventure";
      const parkCode = position.park_slug === "disneyland" ? "DL" : "DCA";
      button.type = "button";
      button.className = "portfolio-position";
      button.innerHTML = `<span class="portfolio-ride"><span class="portfolio-park">${parkCode}</span><span class="portfolio-ride-name"><strong>${escapeHtml(position.ride_name)}</strong><small>${parkName} · ${Number(position.shares)} shares · avg ${credits(position.average_cost_credits, 1)} cr/share</small></span></span><span class="portfolio-market"><strong>${credits(value)} cr</strong><small>${operating ? `Latest wait ${credits(position.wait_minutes)} min` : escapeHtml((position.status || "No wait").replaceAll("_", " "))}</small></span><span class="portfolio-profit ${profit >= 0 ? "positive" : "negative"}"><strong>${profit >= 0 ? "+" : "−"}${credits(Math.abs(profit), 1)} cr</strong><small>unrealized</small></span>`;
      button.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("queue:show-ride", { detail: { slug: position.park_slug, rideName: position.ride_name } }));
      });
      item.appendChild(button);
      list.appendChild(item);
    }
  }

  function publishPortfolioRides(authenticated) {
    const rideKeys = state.portfolio.map((position) => `${position.park_slug}::${position.ride_name}`);
    window.dispatchEvent(new CustomEvent("queue:portfolio-updated", { detail: { authenticated, rideKeys } }));
  }

  async function refreshPortfolio() {
    if (!state.session?.user) {
      state.portfolio = [];
      state.portfolioLoadError = false;
      renderPortfolio();
      publishPortfolioRides(false);
      return;
    }
    if (state.portfolioBusy) return;
    const requestedUserId = state.session.user.id;
    state.portfolioBusy = true;
    try {
      const data = await callGameApi({ action: "portfolio" });
      if (!Array.isArray(data?.positions)) throw new Error("Portfolio response did not include a positions list.");
      if (state.session?.user?.id !== requestedUserId) return;
      state.portfolio = data.positions;
      state.portfolioLoadError = false;
    } catch (error) {
      console.error("Could not load game portfolio:", error.message);
      if (state.session?.user?.id === requestedUserId) state.portfolioLoadError = true;
    } finally {
      state.portfolioBusy = false;
      renderPortfolio();
      publishPortfolioRides(Boolean(state.session?.user));
      if (state.session?.user && state.session.user.id !== requestedUserId) void refreshPortfolio();
    }
  }

  async function refreshAccount() {
    if (!state.session?.user) return;
    const data = await callGameApi({ action: "claim_daily" });
    if (!data || !Number.isFinite(Number(data.credits))) {
      throw new Error("Game account response did not include a numeric credits value.");
    }
    state.account = data;
    state.accountLoadError = false;
    renderAuth();
    renderPortfolio();
    return data;
  }

  async function loadLeaderboard() {
    const list = $("leaderboard-list");
    let data;
    try {
      data = await callGameApi({ action: "leaderboard", limit: 10 });
    } catch {
      list.innerHTML = '<li class="leaderboard-empty">Leaderboard will appear after the game migration is applied.</li>';
      return;
    }
    if (!data?.players?.length) {
      list.innerHTML = '<li class="leaderboard-empty">Be the first to trade your way onto the board.</li>';
      return;
    }
    list.innerHTML = data.players.map((player, index) => `<li><span class="leader-rank">${index + 1}</span><span class="leader-name">${escapeHtml(player.display_name)}</span><strong>${Number(player.net_worth).toLocaleString()} cr</strong></li>`).join("");
  }

  function renderTradePanel() {
    const panel = $("trade-panel");
    if (!panel || !state.selectedRide) return;
    const { slug, rideName, status, waitMinutes, collectedAt } = state.selectedRide;
    const canTrade = Boolean(
      state.session?.user && status === "OPERATING" && Number.isInteger(waitMinutes) &&
      collectedAt && Date.now() - Date.parse(collectedAt) <= 180_000 && Date.parse(collectedAt) <= Date.now() + 30_000
    );

    if (!state.session?.user) {
      panel.innerHTML = '<div class="trade-signin"><span>Want to ride the market?</span><button type="button" class="trade-signin-button">Sign in to buy or sell</button></div>';
      panel.querySelector(".trade-signin-button").addEventListener("click", () => $("auth-dialog").showModal());
      return;
    }

    panel.innerHTML = `<div class="trade-bar"><div class="trade-current"><span>MARKET PRICE</span><strong>${status === "OPERATING" && waitMinutes !== null ? `${Math.max(1, waitMinutes)} cr / share` : "Unavailable"}</strong></div><div class="owned-shares" id="owned-shares">Checking shares…</div><label class="share-quantity">SHARES<input id="share-quantity" type="number" min="1" max="10000" step="1" value="1" inputmode="numeric"></label><div class="trade-buttons"><button type="button" class="buy-button" data-trade="buy" ${canTrade ? "" : "disabled"}>Buy</button><button type="button" class="sell-button" data-trade="sell" ${canTrade ? "" : "disabled"}>Sell</button></div></div><p class="trade-message" id="trade-message" aria-live="polite">${canTrade ? "Uses the latest wait at the moment you trade." : escapeHtml(status !== "OPERATING" ? `Trading is paused: ride status is ${status.toLowerCase()}.` : !collectedAt || Date.now() - Date.parse(collectedAt) > 180_000 ? "Trading is paused until a fresh wait arrives." : "Trading is paused while no numeric wait is available.")}</p>`;

    loadOwnedShares(slug, rideName);
    panel.querySelectorAll("[data-trade]").forEach((button) => button.addEventListener("click", () => {
      const quantity = Number.parseInt($("share-quantity").value, 10);
      executeTrade(button.dataset.trade, quantity, slug, rideName, panel);
    }));
  }

  async function loadOwnedShares(slug, rideName) {
    const output = $("owned-shares");
    if (!output || !state.session?.user) return;
    let data;
    try { data = await callGameApi({ action: "position", park_slug: slug, ride_name: rideName }); }
    catch (error) {
      if (output.isConnected) output.textContent = error.message || "Position unavailable";
      return;
    }
    if (!output.isConnected) return;
    const position = data?.position;
    output.textContent = position ? `You own ${position.shares} · avg ${Number(position.average_cost_credits).toFixed(1)} cr` : "You own 0 shares";
  }

  async function executeTrade(action, shares, slug, rideName, panel) {
    const message = $("trade-message");
    const buttons = [...panel.querySelectorAll("[data-trade]")];
    if (!Number.isInteger(shares) || shares < 1 || shares > 10000) {
      message.textContent = "Choose a whole number from 1 to 10,000 shares.";
      message.classList.add("is-error");
      return;
    }
    buttons.forEach((button) => { button.disabled = true; });
    message.textContent = "Sending trade…";
    message.classList.remove("is-error");
    try {
      const data = await callGameApi({ action: "trade", park_slug: slug, ride_name: rideName, side: action, shares });
      if (!data?.ok) {
        message.textContent = data?.message || "Trade was not completed.";
        message.classList.add("is-error");
      } else if (action === "buy") {
        message.textContent = `Bought ${shares} share${shares === 1 ? "" : "s"} at ${data.unit_price} credits each.`;
      } else {
        const profit = Number(data.realized_profit || 0);
        message.textContent = `Sold ${shares} share${shares === 1 ? "" : "s"}. Realized ${profit >= 0 ? "gain" : "loss"}: ${Math.abs(profit).toFixed(2)} credits.`;
      }
      await refreshAccount();
      await refreshPortfolio();
      await loadOwnedShares(slug, rideName);
      await loadLeaderboard();
    } catch (error) {
      message.textContent = error.message || "Trade failed. Please try again.";
      message.classList.add("is-error");
    } finally {
      const isTradeable = state.selectedRide?.status === "OPERATING" &&
        Number.isInteger(state.selectedRide.waitMinutes) && state.selectedRide.collectedAt &&
        Date.now() - Date.parse(state.selectedRide.collectedAt) <= 180_000;
      buttons.forEach((button) => { button.disabled = !isTradeable; });
    }
  }

  async function applySession(session) {
    state.session = session;
    state.account = null;
    state.accountLoadError = false;
    state.portfolio = [];
    state.portfolioLoadError = false;
    renderAuth();
    if (session?.user) {
      try {
        const account = await refreshAccount();
        if (account.daily_credits_awarded) {
          setAuthMessage(`${account.daily_credits_awarded} daily credits added.`, false);
        }
      } catch (error) {
        console.error("Could not load game account:", error.message);
        state.accountLoadError = true;
      }
    }
    renderAuth();
    await refreshPortfolio();
    renderTradePanel();
    await loadLeaderboard();
  }

  function initAuthDialog() {
    const dialog = $("auth-dialog");
    const form = $("auth-form");
    $("auth-open").addEventListener("click", () => { setAuthMessage(""); dialog.showModal(); });
    $("auth-close").addEventListener("click", () => dialog.close());
    $("sign-out").addEventListener("click", async () => {
      const { error } = await client.auth.signOut();
      if (error) console.error("Sign out failed:", error.message);
    });
    $("change-username").addEventListener("click", () => {
      $("username-input").value = state.account?.display_name || "";
      setUsernameMessage("");
      $("username-dialog").showModal();
    });
    $("username-close").addEventListener("click", () => $("username-dialog").close());
    $("username-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const displayName = $("username-input").value.trim();
      const submit = $("username-save");
      submit.disabled = true;
      setUsernameMessage("Saving username…");
      try {
        const result = await callGameApi({ action: "set_username", display_name: displayName });
        if (state.account) state.account.display_name = result.display_name;
        renderAuth();
        await loadLeaderboard();
        setUsernameMessage("Username saved.");
        window.setTimeout(() => $("username-dialog").close(), 500);
      } catch (error) {
        setUsernameMessage(error.message || "Could not save username.", true);
      } finally {
        submit.disabled = false;
      }
    });
    $("auth-mode").addEventListener("click", () => {
      state.signupMode = !state.signupMode;
      $("auth-title").textContent = state.signupMode ? "Create your park pass" : "Sign in to play";
      $("auth-submit").textContent = state.signupMode ? "Create account" : "Sign in";
      $("auth-mode").textContent = state.signupMode ? "Already have an account? Sign in" : "New here? Create an account";
      $("auth-password").autocomplete = state.signupMode ? "new-password" : "current-password";
      $("username-field").hidden = !state.signupMode;
      $("auth-username").required = state.signupMode;
      setAuthMessage("");
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = $("auth-email").value.trim();
      const password = $("auth-password").value;
      const displayName = $("auth-username").value.trim();
      const submit = $("auth-submit");
      submit.disabled = true;
      setAuthMessage(state.signupMode ? "Creating your account…" : "Signing in…");
      try {
        if (state.signupMode) {
          const { data, error } = await client.auth.signUp({
            email,
            password,
            options: { data: { display_name: displayName } },
          });
          if (error) throw error;
          if (!data.session) {
            setAuthMessage("Check your email to confirm the account, then come back to sign in.");
            return;
          }
        } else {
          const { error } = await client.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
        setAuthMessage("Welcome to the park!");
        dialog.close();
        form.reset();
      } catch (error) {
        let message = error.message || "Could not sign in. Check your details and try again.";
        if (state.signupMode && !/username|display name/i.test(message)) {
          message += " The email may already be registered, or that username may be taken.";
        }
        setAuthMessage(message, true);
      } finally {
        submit.disabled = false;
      }
    });
  }

  function init() {
    initAuthDialog();
    window.addEventListener("queue:ride-selected", (event) => {
      state.selectedRide = event.detail;
      renderTradePanel();
    });
    client.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => { void applySession(session); }, 0);
    });
    client.auth.getSession().then(({ data, error }) => {
      if (error) console.error("Could not restore sign-in:", error.message);
      else void applySession(data.session);
    });
    void loadLeaderboard();
    window.setInterval(() => { void loadLeaderboard(); }, 60_000);
    window.setInterval(() => { if (state.session?.user) void refreshPortfolio(); }, 60_000);
  }

  init();
})();
