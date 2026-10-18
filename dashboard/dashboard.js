(() => {
  "use strict";

  const PAGE_SIZE = 25;
  const STATUS_KEYS = ["Received", "Processing", "Completed", "Failed"];
  const byId = (id) => document.getElementById(id);
  const loginPanel = byId("login-panel");
  const dashboard = byId("dashboard");
  const loginForm = byId("login-form");
  const loginMessage = byId("login-message");
  const eventRows = byId("event-rows");
  const listMessage = byId("list-message");
  const detailMessage = byId("detail-message");
  const filter = byId("status-filter");
  const retryButton = byId("retry-button");
  let currentOffset = 0;
  let currentTotal = 0;
  let selectedEventId = null;
  let eventStream = null;
  let sessionCheckPending = false;
  let listLoading = false;
  let refreshQueued = false;
  let detailRequestId = 0;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { ...(options.headers || {}) }
    });
    let body = {};
    try { body = await response.json(); } catch { /* Keep the response error generic. */ }
    if (response.status === 401) {
      showLogin("Your dashboard session expired. Sign in again.");
      throw new Error("Dashboard session expired.");
    }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return { body, response };
  }

  function showLogin(message = "") {
    if (eventStream) {
      eventStream.close();
      eventStream = null;
    }
    dashboard.hidden = true;
    loginPanel.hidden = false;
    loginMessage.textContent = message;
    loginMessage.classList.toggle("error", Boolean(message));
  }

  function showDashboard() {
    loginPanel.hidden = true;
    dashboard.hidden = false;
    connectEventStream();
  }

  function connectEventStream() {
    if (eventStream) return;
    const stream = new EventSource("/api/dashboard/events/stream");
    eventStream = stream;
    stream.addEventListener("event-update", () => {
      if (document.visibilityState !== "visible") return;
      if (listLoading) {
        refreshQueued = true;
        return;
      }
      void loadEvents({ silent: true });
    });
    stream.addEventListener("auth-expired", () => {
      if (eventStream !== stream) return;
      stream.close();
      eventStream = null;
      showLogin("Your dashboard session expired. Sign in again.");
    });
    stream.onopen = () => {
      if (eventStream === stream && document.visibilityState === "visible") void loadEvents({ silent: true });
    };
    stream.onerror = () => {
      if (eventStream !== stream || sessionCheckPending) return;
      sessionCheckPending = true;
      api("/api/dashboard/session").then(({ body }) => {
        if (!body.configured) showLogin("Dashboard access is not configured. Set DASHBOARD_ACCESS_TOKEN on the server.");
        else if (!body.authenticated) showLogin("Your dashboard session expired. Sign in again.");
      }).catch(() => {
        // EventSource reconnects automatically for temporary network errors.
      }).finally(() => {
        sessionCheckPending = false;
      });
    };
  }

  function setMessage(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle("error", isError);
  }

  function statusClass(status) {
    return String(status || "").toLowerCase();
  }

  function formattedDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || "—") : date.toLocaleString();
  }

  function createCell(value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = value == null || value === "" ? "—" : String(value);
    if (className) cell.className = className;
    return cell;
  }

  function renderEvents(events) {
    eventRows.replaceChildren();
    for (const event of events) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.setAttribute("aria-selected", String(event.id === selectedEventId));
      row.append(createCell(event.id, "event-id"));

      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `status-badge ${statusClass(event.status)}`;
      badge.textContent = event.status;
      statusCell.append(badge);
      row.append(statusCell);
      row.append(createCell(formattedDate(event.createdAt)));
      row.append(createCell(event.attemptCount));
      row.append(createCell(event.failureReason, "failure-cell"));
      row.addEventListener("click", () => void loadDetail(event.id));
      row.addEventListener("keydown", (eventKey) => {
        if (eventKey.key === "Enter" || eventKey.key === " ") {
          eventKey.preventDefault();
          void loadDetail(event.id);
        }
      });
      eventRows.append(row);
    }
  }

  function renderSummary(summary = {}) {
    for (const status of STATUS_KEYS) byId(`count-${status.toLowerCase()}`).textContent = String(summary[status] || 0);
  }

  function renderPagination() {
    const first = currentTotal ? currentOffset + 1 : 0;
    const last = Math.min(currentOffset + PAGE_SIZE, currentTotal);
    byId("page-label").textContent = `${first}–${last} of ${currentTotal}`;
    byId("previous-button").disabled = currentOffset === 0;
    byId("next-button").disabled = currentOffset + PAGE_SIZE >= currentTotal;
  }

  async function loadEvents({ silent = false } = {}) {
    if (listLoading) return;
    listLoading = true;
    if (!silent) setMessage(listMessage, "Loading events…");
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(currentOffset) });
    if (filter.value) query.set("status", filter.value);
    try {
      const { body } = await api(`/api/dashboard/events?${query}`);
      renderSummary(body.summary);
      currentTotal = body.total;
      renderEvents(body.events);
      renderPagination();
      setMessage(listMessage, body.events.length ? "" : "No events match this view.");
      if (selectedEventId) {
        const stillVisible = body.events.some((event) => event.id === selectedEventId);
        if (stillVisible) await loadDetail(selectedEventId, { silent: true });
        else {
          selectedEventId = null;
          clearDetail("Choose an event to inspect its payload.");
        }
      }
    } catch (error) {
      if (error.message !== "Dashboard session expired.") setMessage(listMessage, error.message, true);
    } finally {
      listLoading = false;
      if (refreshQueued && document.visibilityState === "visible") {
        refreshQueued = false;
        queueMicrotask(() => void loadEvents({ silent: true }));
      }
    }
  }

  function clearDetail(message) {
    detailRequestId += 1;
    byId("detail-title").textContent = "Select an event";
    byId("event-metadata").hidden = true;
    byId("event-metadata").replaceChildren();
    byId("payload-heading").hidden = true;
    byId("event-payload").hidden = true;
    byId("event-payload").textContent = "";
    retryButton.hidden = true;
    setMessage(detailMessage, message);
  }

  function addMetadata(label, value) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value == null || value === "" ? "—" : String(value);
    byId("event-metadata").append(term, description);
  }

  async function loadDetail(id, { silent = false } = {}) {
    const changedSelection = selectedEventId !== id;
    selectedEventId = id;
    const requestId = ++detailRequestId;
    if (changedSelection) {
      byId("detail-title").textContent = "Loading event…";
      byId("event-metadata").hidden = true;
      byId("payload-heading").hidden = true;
      byId("event-payload").hidden = true;
      retryButton.hidden = true;
    }
    for (const row of eventRows.rows) row.setAttribute("aria-selected", String(row.cells[0].textContent === id));
    if (!silent) setMessage(detailMessage, "Loading event details…");
    try {
      const { body } = await api(`/api/dashboard/events/${encodeURIComponent(id)}`);
      if (requestId !== detailRequestId || selectedEventId !== id) return;
      const event = body.event;
      byId("detail-title").textContent = event.id;
      const metadata = byId("event-metadata");
      metadata.replaceChildren();
      addMetadata("Status", event.status);
      addMetadata("Created", formattedDate(event.createdAt));
      addMetadata("Attempts", event.attemptCount);
      if (event.failureReason) addMetadata("Failure", event.failureReason);
      metadata.hidden = false;
      byId("payload-heading").hidden = false;
      byId("event-payload").textContent = JSON.stringify(event.payload, null, 2);
      byId("event-payload").hidden = false;
      retryButton.hidden = event.status !== "Failed";
      retryButton.disabled = false;
      retryButton.dataset.eventId = event.id;
      setMessage(detailMessage, "");
    } catch (error) {
      if (requestId === detailRequestId && error.message !== "Dashboard session expired.") setMessage(detailMessage, error.message, true);
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const tokenInput = byId("access-token");
    const token = tokenInput.value;
    setMessage(loginMessage, "Signing in…");
    try {
      await api("/api/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });
      tokenInput.value = "";
      showDashboard();
      await loadEvents();
    } catch (error) {
      tokenInput.value = "";
      setMessage(loginMessage, error.message, true);
    }
  });

  byId("logout-button").addEventListener("click", async () => {
    try { await api("/api/dashboard/logout", { method: "POST" }); } catch { /* Always return to the login screen. */ }
    selectedEventId = null;
    clearDetail("Choose an event to inspect its payload.");
    showLogin("You have signed out.");
  });

  byId("refresh-button").addEventListener("click", () => void loadEvents());
  filter.addEventListener("change", () => {
    currentOffset = 0;
    selectedEventId = null;
    clearDetail("Choose an event to inspect its payload.");
    void loadEvents();
  });
  byId("previous-button").addEventListener("click", () => {
    currentOffset = Math.max(0, currentOffset - PAGE_SIZE);
    void loadEvents();
  });
  byId("next-button").addEventListener("click", () => {
    if (currentOffset + PAGE_SIZE < currentTotal) currentOffset += PAGE_SIZE;
    void loadEvents();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !dashboard.hidden) void loadEvents({ silent: true });
  });
  retryButton.addEventListener("click", async () => {
    const id = retryButton.dataset.eventId;
    if (!id) return;
    retryButton.disabled = true;
    setMessage(detailMessage, "Submitting retry…");
    try {
      const { body } = await api(`/api/webhooks/${encodeURIComponent(id)}/retry`, { method: "POST" });
      setMessage(detailMessage, `Retry accepted. Attempt ${body.attemptCount} is processing.`);
      await loadEvents({ silent: true });
      await loadDetail(id, { silent: true });
    } catch (error) {
      if (error.message !== "Dashboard session expired.") setMessage(detailMessage, error.message, true);
    } finally {
      retryButton.disabled = false;
    }
  });

  async function initialize() {
    try {
      const { body } = await api("/api/dashboard/session");
      if (!body.configured) {
        showLogin("Dashboard access is not configured. Set DASHBOARD_ACCESS_TOKEN on the server.");
      } else if (body.authenticated) {
        showDashboard();
        await loadEvents();
      } else {
        showLogin();
      }
    } catch (error) {
      showLogin(error.message);
    }
  }

  void initialize();
})();
