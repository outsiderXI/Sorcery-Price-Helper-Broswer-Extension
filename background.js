/*
  Sorcery Curiosa Price Helper
  Background service worker

  Fetches and caches Sorcery card pricing data so content scripts do not need a backend server.
*/

const GAME_ID = "sorcery";
const DOTGG_BASE = "https://api.dotgg.gg";
const BUTTERFLY_BASE = "https://butterfly.dotgg.gg";
const CACHE_KEY = "dotggSorceryPriceIndexV1";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "GET_PRICE_INDEX": {
          const index = await getPriceIndex({ forceRefresh: Boolean(message.forceRefresh) });
          sendResponse({ ok: true, index });
          break;
        }

        case "GET_CARD_PRICE": {
          const index = await getPriceIndex({ forceRefresh: false });
          const result = lookupCard(index, message.name || "");
          sendResponse({ ok: true, result, meta: index.meta });
          break;
        }

        case "REFRESH_PRICE_INDEX": {
          const index = await getPriceIndex({ forceRefresh: true });
          sendResponse({ ok: true, meta: index.meta });
          break;
        }

        case "CLEAR_PRICE_CACHE": {
          await chrome.storage.local.remove(CACHE_KEY);
          sendResponse({ ok: true });
          break;
        }

        case "GET_CACHE_STATUS": {
          const cached = await getCachedIndex();
          sendResponse({ ok: true, meta: cached?.meta || null });
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (error) {
      console.error("Sorcery price helper error:", error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  // Required because we respond asynchronously.
  return true;
});

async function getPriceIndex({ forceRefresh = false } = {}) {
  const cached = await getCachedIndex();

  if (!forceRefresh && cached && !isCacheExpired(cached)) {
    return cached;
  }

  const fresh = await fetchDotGGIndex();
  await chrome.storage.local.set({ [CACHE_KEY]: fresh });
  return fresh;
}

async function getCachedIndex() {
  const result = await chrome.storage.local.get(CACHE_KEY);
  return result?.[CACHE_KEY] || null;
}

function isCacheExpired(index) {
  const fetchedAt = Number(index?.meta?.fetchedAt || 0);
  return !fetchedAt || Date.now() - fetchedAt > CACHE_TTL_MS;
}

async function fetchDotGGIndex() {
  const version = await fetchDataVersion();
  const cacheValue = version || dayCacheKey();
  const url = `${DOTGG_BASE}/cgfw/getcards?game=${encodeURIComponent(GAME_ID)}&mode=indexed&cache=${encodeURIComponent(cacheValue)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Price data request failed: ${response.status} ${response.statusText}`);
  }

  const raw = await response.json();
  const cards = normalizeDotGGCards(raw);
  const index = buildPriceIndex(cards);

  return {
    cardsByName: index.cardsByName,
    allNames: index.allNames,
    meta: {
      fetchedAt: Date.now(),
      expiresAt: Date.now() + CACHE_TTL_MS,
      source: "public-price-index",
      game: GAME_ID,
      dataVersion: version || null,
      cardCount: cards.length,
      pricedNameCount: Object.keys(index.cardsByName).length,
      endpoint: url
    }
  };
}

async function fetchDataVersion() {
  try {
    const url = `${BUTTERFLY_BASE}/?game=${encodeURIComponent(GAME_ID)}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) return null;

    const text = (await response.text()).trim();
    // Butterfly normally returns a simple number, but keep this defensive.
    return text && text.length <= 50 ? text : null;
  } catch (error) {
    console.warn("Could not fetch price data version; falling back to day cache key.", error);
    return null;
  }
}

function dayCacheKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function normalizeDotGGCards(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);

  // Indexed format: { names: [...], data: [[...], [...]] }
  if (raw && Array.isArray(raw.names) && Array.isArray(raw.data)) {
    return raw.data.map((row) => {
      const card = {};
      raw.names.forEach((fieldName, index) => {
        card[fieldName] = row[index];
      });
      return card;
    });
  }

  // Defensive handling for APIs that wrap responses.
  if (Array.isArray(raw?.cards)) return raw.cards;
  if (Array.isArray(raw?.data)) return raw.data;

  throw new Error("Unexpected card pricing response format.");
}

function buildPriceIndex(cards) {
  const cardsByName = {};
  const allNames = [];

  for (const card of cards) {
    if (!card || !card.name) continue;

    const name = String(card.name).trim();
    const key = normalizeName(name);
    if (!key) continue;

    const price = extractPrice(card);
    const entry = {
      name,
      normalizedName: key,
      price,
      id: card.id || card.cardid || card.cardId || "",
      slug: card.slug || "",
      setId: card.set_id || card.setId || card.set || "",
      rarity: card.rarity || "",
      type: card.type || card.card_type || "",
      image: card.image || card.img || ""
    };

    allNames.push({ name, normalizedName: key });

    const existing = cardsByName[key];
    if (!existing) {
      cardsByName[key] = {
        name,
        normalizedName: key,
        price,
        selected: entry,
        variants: [entry]
      };
      continue;
    }

    existing.variants.push(entry);

    // With no set/finish info available from the Curiosa page, show the lowest positive price
    // among known printings. If neither has a price, keep the first seen card.
    const existingPrice = Number(existing.price || 0);
    const newPrice = Number(price || 0);
    const shouldReplace =
      (newPrice > 0 && existingPrice <= 0) ||
      (newPrice > 0 && existingPrice > 0 && newPrice < existingPrice);

    if (shouldReplace) {
      existing.name = name;
      existing.price = price;
      existing.selected = entry;
    }
  }

  // Deduplicate names to keep the payload smaller.
  const seen = new Set();
  const dedupedNames = [];
  for (const n of allNames) {
    if (seen.has(n.normalizedName)) continue;
    seen.add(n.normalizedName);
    dedupedNames.push(n);
  }

  return { cardsByName, allNames: dedupedNames };
}

function extractPrice(card) {
  const candidates = [
    card.price,
    card.usdprice,
    card.usd_price,
    card.usd,
    card.marketPrice,
    card.market_price,
    card.lowPrice,
    card.low_price,
    card.tcgplayer_price,
    card.tcgplayerPrice,
    card.priceUsd,
    card.price_usd,
    card?.prices?.usd,
    card?.prices?.low,
    card?.prices?.market,
    card?.pricing?.usd,
    card?.pricing?.low,
    card?.pricing?.market
  ];

  for (const value of candidates) {
    const parsed = parsePrice(value);
    if (parsed > 0) return parsed;
  }

  return null;
}

function parsePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const cleaned = value.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;

  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function lookupCard(index, name) {
  const key = normalizeName(name);
  if (!key) return null;

  const exact = index?.cardsByName?.[key];
  if (exact) return exact;

  // Last-resort fallback: allow small punctuation/spacing differences.
  const compactKey = key.replace(/\s+/g, "");
  const values = Object.values(index?.cardsByName || {});
  const compactMatch = values.find((entry) => entry.normalizedName.replace(/\s+/g, "") === compactKey);
  return compactMatch || null;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9'\-\s]/g, " ")
    .replace(/[\-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
