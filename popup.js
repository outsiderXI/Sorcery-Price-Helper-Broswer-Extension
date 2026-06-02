const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const reloadBtn = document.getElementById("reload");

init();

async function init() {
  await renderStatus();

  refreshBtn.addEventListener("click", async () => {
    await withBusy(refreshBtn, "Refreshing…", async () => {
      const response = await chrome.runtime.sendMessage({ type: "REFRESH_PRICE_INDEX" });
      if (!response?.ok) throw new Error(response?.error || "Refresh failed.");
      await renderStatus("Refreshed price data.");
    });
  });

  clearBtn.addEventListener("click", async () => {
    await withBusy(clearBtn, "Clearing…", async () => {
      const response = await chrome.runtime.sendMessage({ type: "CLEAR_PRICE_CACHE" });
      if (!response?.ok) throw new Error(response?.error || "Clear failed.");
      await renderStatus("Cleared cached price data.");
    });
  });

  reloadBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.reload(tab.id);
    window.close();
  });
}

async function renderStatus(prefix = "") {
  const response = await chrome.runtime.sendMessage({ type: "GET_CACHE_STATUS" });
  if (!response?.ok) {
    statusEl.textContent = response?.error || "Could not read cache status.";
    return;
  }

  const meta = response.meta;
  if (!meta) {
    statusEl.textContent = `${prefix ? `${prefix}\n\n` : ""}No price cache yet. Open a Curiosa deck page or click refresh.`;
    return;
  }

  const fetchedAt = meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleString() : "Unknown";
  const expiresAt = meta.expiresAt ? new Date(meta.expiresAt).toLocaleString() : "Unknown";

  statusEl.textContent = [
    prefix,
    `Cached cards: ${meta.cardCount || 0}`,
    `Priced names: ${meta.pricedNameCount || 0}`,
    `Fetched: ${fetchedAt}`,
    `Expires: ${expiresAt}`,
    meta.dataVersion ? `Data version: ${meta.dataVersion}` : "Data version: fallback cache key"
  ].filter(Boolean).join("\n");
}

async function withBusy(button, label, task) {
  const original = button.textContent;
  setButtonsDisabled(true);
  button.textContent = label;

  try {
    await task();
  } catch (error) {
    statusEl.textContent = error?.message || String(error);
  } finally {
    button.textContent = original;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  refreshBtn.disabled = disabled;
  clearBtn.disabled = disabled;
  reloadBtn.disabled = disabled;
}
