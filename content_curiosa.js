/*
  Sorcery Curiosa Price Helper
  Content script for https://curiosa.io/decks/*

  It loads a cached Sorcery price index from the background service worker, identifies likely
  Sorcery card names on the Curiosa deck page, and injects price badges.
*/

const EXT_ATTR = "data-sorcery-price-helper";
const BOUND_ATTR = "data-sorcery-price-bound";
const PRICE_ATTR = "data-sorcery-price";
const QTY_ATTR = "data-sorcery-qty";
const NAME_ATTR = "data-sorcery-card-name";
const SCAN_DEBOUNCE_MS = 500;

const CATEGORY_NAMES = new Set([
  "avatar",
  "artifact",
  "artifacts",
  "aura",
  "auras",
  "beast",
  "beasts",
  "collection",
  "conjuration",
  "conjurations",
  "magic",
  "minion",
  "minions",
  "site",
  "sites",
  "spell",
  "spells",
  "spellbook",
  "atlas",
  "sideboard"
]);

let state = {
  priceIndex: null,
  cardNameMap: new Map(),
  scanTimer: null,
  observer: null,
  isScanning: false,
  lastScanAt: 0
};

init();

async function init() {
  if (!location.href.startsWith("https://curiosa.io/decks/")) return;

  setPageStatus("Loading prices…");

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_PRICE_INDEX" });
    if (!response?.ok) throw new Error(response?.error || "Failed to load price index.");

    state.priceIndex = response.index;
    state.cardNameMap = buildCardNameMap(response.index);

    setPageStatus(`Prices loaded: ${response.index?.meta?.pricedNameCount || 0} priced cards`);
    scheduleScan();
    startObserver();
  } catch (error) {
    console.error("Sorcery price helper init failed:", error);
    setPageStatus(`Price helper error: ${error?.message || error}`);
  }
}

function buildCardNameMap(index) {
  const map = new Map();
  const entries = Object.values(index?.cardsByName || {});

  for (const entry of entries) {
    map.set(entry.normalizedName, entry);
  }

  return map;
}

function startObserver() {
  if (state.observer) state.observer.disconnect();

  state.observer = new MutationObserver((mutations) => {
    // Do not rescan when the only mutation is our own price badge/status UI.
    const meaningful = mutations.some((mutation) => {
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
      if (!nodes.length) return false;

      return nodes.some((node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (node.hasAttribute?.(EXT_ATTR) || node.closest?.(`[${EXT_ATTR}]`)) return false;
        return true;
      });
    });

    if (meaningful) scheduleScan();
  });

  state.observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function scheduleScan() {
  clearTimeout(state.scanTimer);
  state.scanTimer = setTimeout(scanAndInjectPrices, SCAN_DEBOUNCE_MS);
}

function scanAndInjectPrices() {
  if (state.isScanning || !state.priceIndex) return;
  state.isScanning = true;

  try {
    const candidates = findCandidateElements();
    let matched = 0;
    let priced = 0;

    for (const candidate of candidates) {
      if (candidate.element.getAttribute(BOUND_ATTR) === "1") continue;

      const match = findBestCardMatch(candidate);
      if (!match) continue;

      const quantity = resolveQuantityForMatch(candidate.element, match.name, candidate.quantity);
      injectBadge(candidate.element, match.entry, match.name, quantity);
      matched += 1;
      if (match.entry?.price > 0) priced += 1;
    }

    updateDeckTotal();
    setPageStatus(`Priced ${priced}/${matched} matched cards`, { quiet: true });
    state.lastScanAt = Date.now();
  } finally {
    state.isScanning = false;
  }
}

function findCandidateElements() {
  const selector = [
    "main a",
    "main button",
    "main li",
    "main span",
    "main p",
    "main div",
    "[role='main'] a",
    "[role='main'] button",
    "[role='main'] li",
    "[role='main'] span",
    "[role='main'] p",
    "[role='main'] div"
  ].join(",");

  const root = document.querySelector("main") || document.querySelector("[role='main']") || document.body;
  const elements = [...root.querySelectorAll(selector)];
  const candidates = [];
  const seenTextElement = new Set();

  for (const element of elements) {
    if (!isVisible(element)) continue;
    if (element.hasAttribute(EXT_ATTR) || element.closest(`[${EXT_ATTR}]`)) continue;
    if (element.closest("nav, header, footer, aside, form")) continue;
    if (element.querySelector(`[${EXT_ATTR}]`)) continue;

    // Prefer leaf-ish elements so we don't inject prices onto huge containers.
    const childTextElementCount = [...element.children].filter((child) => cleanText(child.innerText || child.textContent).length > 0).length;
    if (childTextElementCount > 4) continue;

    const rawText = cleanText(element.innerText || element.textContent || "");
    if (!rawText || rawText.length > 120) continue;

    const parsed = parseDeckText(rawText);
    if (!parsed?.possibleNames?.length) continue;

    const dedupeKey = `${parsed.possibleNames[0]}::${element.getBoundingClientRect().top.toFixed(0)}::${element.getBoundingClientRect().left.toFixed(0)}`;
    if (seenTextElement.has(dedupeKey)) continue;
    seenTextElement.add(dedupeKey);

    candidates.push({
      element,
      rawText,
      quantity: parsed.quantity,
      possibleNames: parsed.possibleNames
    });
  }

  // Smaller/deeper elements first. This reduces duplicate injections into parent containers.
  candidates.sort((a, b) => getDepth(b.element) - getDepth(a.element));
  return candidates;
}

function parseDeckText(rawText) {
  let text = cleanText(rawText);
  if (!text) return null;

  // Skip obvious section labels.
  if (CATEGORY_NAMES.has(normalizeName(text))) return null;

  // Remove our own existing text if a re-scan happens.
  text = text.replace(/(?:DotGG\s*)?\$[0-9,.]+/gi, " ");
  text = text.replace(/No\s*(?:DotGG\s*)?Price(?:\s*Found)?/gi, " ");

  // Common Curiosa/decklist shapes:
  // "2 Browse", "2x Browse", "Browse x2", "Browse × 2", "Browse\n2"
  let quantity = 1;
  const candidates = [];

  const normalizedLine = text.replace(/\s+/g, " ").trim();
  const lines = rawText.split(/\n+/).map(cleanText).filter(Boolean);

  for (const line of [normalizedLine, ...lines]) {
    let t = line;
    if (!t) continue;

    t = t.replace(/\$[0-9]+(?:\.[0-9]{1,2})?/g, " ");
    t = t.replace(/\b(?:foil|non[-\s]?foil|ordinary|exceptional|elite|unique|avatar|site|minion|magic|artifact)\b$/i, " ").trim();

    const prefixQty = t.match(/^(?:x\s*)?(\d{1,2})\s*[x×]?\s+(.+)$/i);
    if (prefixQty) {
      quantity = safeQuantity(prefixQty[1]);
      candidates.push(prefixQty[2].trim());
      continue;
    }

    const suffixQty = t.match(/^(.+?)\s+[x×]\s*(\d{1,2})$/i);
    if (suffixQty) {
      quantity = safeQuantity(suffixQty[2]);
      candidates.push(suffixQty[1].trim());
      continue;
    }

    const parenQty = t.match(/^(.+?)\s*\((\d{1,2})\)$/i);
    if (parenQty) {
      quantity = safeQuantity(parenQty[2]);
      candidates.push(parenQty[1].trim());
      continue;
    }

    candidates.push(t);
  }

  const possibleNames = [...new Set(candidates
    .map(stripCardNameNoise)
    .filter((name) => name.length >= 3 && name.length <= 80)
    .filter((name) => !CATEGORY_NAMES.has(normalizeName(name))))];

  return { quantity, possibleNames };
}

function stripCardNameNoise(value) {
  return cleanText(String(value || "")
    .replace(/[•·]/g, " ")
    .replace(/^[-–—]+\s*/, "")
    .replace(/\s+[-–—]+\s*$/, "")
    .replace(/\b(?:main|deck|sideboard|maybeboard|card|cards)\b$/i, "")
    .replace(/\s+/g, " "));
}

function safeQuantity(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : 1;
}

function resolveQuantityForMatch(element, displayName, parsedQuantity) {
  const parsedQty = safeQuantity(parsedQuantity || 1);
  if (parsedQty > 1) return parsedQty;

  const textBlocks = collectQuantityTextBlocks(element);
  for (const text of textBlocks) {
    const qty = extractQuantityNearName(text, displayName);
    if (qty > 1) return qty;
  }

  const siblingQty = extractQuantityFromNearbySiblings(element);
  if (siblingQty > 1) return siblingQty;

  return parsedQty;
}

function collectQuantityTextBlocks(element) {
  const blocks = [];
  const push = (value) => {
    const cleaned = cleanPriceHelperText(value);
    if (!cleaned || cleaned.length > 220) return;
    if (cleaned.split(/\n+/).length > 8) return;
    if (!blocks.includes(cleaned)) blocks.push(cleaned);
  };

  push(element.innerText || element.textContent || "");
  push(element.getAttribute?.("aria-label") || "");
  push(element.getAttribute?.("title") || "");

  // Look upward for the row/card container. Curiosa can render quantity and name in
  // separate child elements, so the card-name element alone may not contain the quantity.
  let node = element.parentElement;
  let depth = 0;
  while (node && depth < 4) {
    if (node.hasAttribute?.(EXT_ATTR) || node.closest?.(`[${EXT_ATTR}]`)) break;
    push(node.innerText || node.textContent || "");
    node = node.parentElement;
    depth += 1;
  }

  return blocks;
}

function cleanPriceHelperText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\([^)]*\$[0-9,.]+[^)]*\)/g, " ")
    .replace(/\$[0-9,.]+/g, " ")
    .replace(/No\s*Price\s*Found/gi, " ")
    .replace(/\s+$/gm, "")
    .trim();
}

function extractQuantityNearName(text, displayName) {
  const cleanedName = cleanText(displayName);
  if (!cleanedName) return 1;

  const escapedName = escapeRegExp(cleanedName);
  const normalizedBlock = cleanPriceHelperText(text);
  const lines = [
    normalizedBlock.replace(/\s+/g, " ").trim(),
    ...String(normalizedBlock || "").split(/\n+/).map(cleanText).filter(Boolean)
  ].filter(Boolean);

  for (const line of lines) {
    const compact = line.replace(/\s+/g, " ").trim();
    if (!compact) continue;

    const patterns = [
      // "3 Browse" or "3x Browse"
      new RegExp(`^(?:x\\s*)?(\\d{1,2})\\s*[x×]?\\s+${escapedName}(?:\\s|$)`, "i"),
      // "Browse x3" or "Browse × 3"
      new RegExp(`^${escapedName}\\s+[x×]\\s*(\\d{1,2})(?:\\s|$)`, "i"),
      // "Browse (3)"
      new RegExp(`^${escapedName}\\s*\\((\\d{1,2})\\)(?:\\s|$)`, "i"),
      // "Browse 3" when quantity is rendered after the card name.
      new RegExp(`^${escapedName}\\s+(\\d{1,2})(?:\\s|$)`, "i")
    ];

    for (const pattern of patterns) {
      const match = compact.match(pattern);
      if (match) return safeQuantity(match[1]);
    }
  }

  return 1;
}

function extractQuantityFromNearbySiblings(element) {
  const parent = element.parentElement;
  if (!parent) return 1;

  const siblings = [...parent.children];
  const currentIndex = siblings.indexOf(element);
  const nearby = siblings.filter((_, index) => Math.abs(index - currentIndex) <= 2);

  for (const sibling of nearby) {
    if (sibling === element) continue;
    if (sibling.hasAttribute?.(EXT_ATTR) || sibling.closest?.(`[${EXT_ATTR}]`)) continue;

    const text = cleanText(sibling.innerText || sibling.textContent || "");
    const match = text.match(/^(?:x\s*)?(\d{1,2})\s*[x×]?$/i);
    if (match) return safeQuantity(match[1]);
  }

  return 1;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBestCardMatch(candidate) {
  for (const possibleName of candidate.possibleNames) {
    const key = normalizeName(possibleName);
    const exact = state.cardNameMap.get(key);
    if (exact) {
      return { entry: exact, name: exact.name };
    }

    const compactKey = key.replace(/\s+/g, "");
    for (const [knownKey, entry] of state.cardNameMap.entries()) {
      if (knownKey.replace(/\s+/g, "") === compactKey) {
        return { entry, name: entry.name };
      }
    }
  }

  return null;
}

function injectBadge(element, entry, displayName, quantity) {
  element.setAttribute(BOUND_ATTR, "1");
  element.setAttribute(NAME_ATTR, displayName);
  element.setAttribute(QTY_ATTR, String(quantity || 1));

  const existing = element.querySelector(`:scope > [${EXT_ATTR}].scr-price-badge`);
  if (existing) existing.remove();

  const badge = document.createElement("span");
  badge.setAttribute(EXT_ATTR, "1");
  badge.className = "scr-price-badge";

  const price = Number(entry?.price || 0);
  const qty = safeQuantity(quantity || 1);
  if (price > 0) {
    const rowTotal = price * qty;
    badge.textContent = `(${formatCurrency(price)} / ${formatCurrency(rowTotal)})`;
    badge.title = buildPriceTitle(entry, qty);
    badge.dataset.status = "priced";
    badge.dataset.priceTier = getPriceTier(price);
    badge.dataset.unitPrice = String(price);
    badge.dataset.rowTotal = String(rowTotal);
    badge.dataset.quantity = String(qty);
    element.setAttribute(PRICE_ATTR, String(price));
  } else {
    badge.textContent = "No Price Found";
    badge.title = `Matched ${displayName}, but no usable price was returned.`;
    badge.dataset.status = "missing";
    badge.dataset.priceTier = "missing";
    element.removeAttribute(PRICE_ATTR);
  }

  // Append a leading space to keep the badge visually separated in inline contexts.
  element.appendChild(document.createTextNode(" "));
  element.appendChild(badge);
}

function buildPriceTitle(entry, quantity) {
  const variantCount = entry?.variants?.length || 1;
  const selected = entry?.selected || {};
  const qty = safeQuantity(quantity || 1);
  const unitPrice = Number(entry?.price || 0);
  const rowTotal = unitPrice * qty;
  const parts = [
    `${entry.name}: ${formatCurrency(unitPrice)} each`,
    `Quantity on page: ${qty}`,
    `Row total: ${formatCurrency(rowTotal)}`,
    variantCount > 1 ? `Lowest priced of ${variantCount} matching printings with this name.` : "Single printing matched."
  ];

  if (selected.setId) parts.push(`Set: ${selected.setId}`);
  if (selected.rarity) parts.push(`Rarity: ${selected.rarity}`);
  if (selected.id) parts.push(`Card ID: ${selected.id}`);

  return parts.join("\n");
}

function getPriceTier(price) {
  const n = Number(price || 0);
  if (!Number.isFinite(n) || n <= 0) return "missing";
  if (n < 5) return "under-5";
  if (n <= 10) return "5-10";
  if (n <= 20) return "10-20";
  if (n <= 50) return "20-50";
  return "over-50";
}

function updateDeckTotal() {
  const pricedElements = [...document.querySelectorAll(`[${BOUND_ATTR}='1'][${PRICE_ATTR}]`)];
  let total = 0;
  let count = 0;

  for (const el of pricedElements) {
    const price = Number.parseFloat(el.getAttribute(PRICE_ATTR) || "0");
    const qty = safeQuantity(el.getAttribute(QTY_ATTR) || "1");
    if (price > 0) {
      total += price * qty;
      count += qty;
    }
  }

  let box = document.querySelector(".scr-price-total-box");
  if (!box) {
    box = document.createElement("div");
    box.setAttribute(EXT_ATTR, "1");
    box.className = "scr-price-total-box";
    document.body.appendChild(box);
  }

  box.innerHTML = `
    <div class="scr-price-total-title">Sorcery Deck Price</div>
    <div class="scr-price-total-value">${formatCurrency(total)}</div>
    <div class="scr-price-total-meta">${count} priced card${count === 1 ? "" : "s"}</div>
  `;
}

function setPageStatus(message, { quiet = false } = {}) {
  let box = document.querySelector(".scr-price-status-box");

  if (!box) {
    box = document.createElement("div");
    box.setAttribute(EXT_ATTR, "1");
    box.className = "scr-price-status-box";
    document.body.appendChild(box);
  }

  box.textContent = message;

  if (quiet) {
    box.dataset.quiet = "1";
    window.clearTimeout(box._hideTimer);
    box._hideTimer = window.setTimeout(() => {
      box.dataset.hidden = "1";
    }, 2000);
  } else {
    box.dataset.hidden = "0";
    box.dataset.quiet = "0";
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function isVisible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.top > window.innerHeight + 1000) return false;

  return true;
}

function getDepth(element) {
  let depth = 0;
  let node = element;
  while (node?.parentElement) {
    depth += 1;
    node = node.parentElement;
  }
  return depth;
}

function formatCurrency(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n);
}
