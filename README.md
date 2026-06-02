# Sorcery Curiosa Price Helper

A lightweight Chrome/Edge browser extension that adds estimated **Sorcery: Contested Realm** card prices directly to Curiosa deck pages.

When you open a Curiosa decklist, the extension scans the visible card names, matches them to public Sorcery pricing data, and displays the price beside each card. It also calculates a running deck total using card quantity, so multiple copies are counted correctly.

> This is an unofficial fan-made tool and is not affiliated with Curiosa, Erik's Curiosa Ltd., Sorcery: Contested Realm, or DotGG.

## Features

- Runs automatically on Curiosa deck pages: `https://curiosa.io/decks/*`
- Adds price badges beside cards in deck sections like Avatar, Artifact, Minion, Magic, Site, Collection, Spellbook, and Atlas
- Shows unit price and row total in the format: `($5.00 / $15.00)`
- Calculates the bottom-right deck total using `quantity × unit price`
- Detects common quantity formats such as `3 Browse`, `3x Browse`, `Browse x3`, and `Browse (3)`
- Uses local browser extension caching so pricing data is not fetched repeatedly
- Requires no backend server and no private API keys
- Includes a popup with cache status, refresh, clear-cache, and reload controls

## Price Badge Colors

| Price Range | Badge Color |
|---|---|
| Under $5 | White |
| $5.00 – $10.00 | Green |
| $10.01 – $20.00 | Blue |
| $20.01 – $50.00 | Purple |
| Over $50.00 | Orange |
| No price found | Red |

## Example

If a card costs `$5.00` and the decklist contains 3 copies, the badge will display:

```text
($5.00 / $15.00)
```

The first value is the single-card price. The second value is the total for that row.

## Installation

This extension is currently installed as an unpacked developer extension.

### Chrome

1. Download or clone this repository.
2. Open Chrome.
3. Go to `chrome://extensions`.
4. Turn on **Developer mode** in the top-right corner.
5. Click **Load unpacked**.
6. Select the folder that contains `manifest.json`.
7. Open a Curiosa deck page, such as:

```text
https://curiosa.io/decks/{deck_id}
```

### Microsoft Edge

1. Download or clone this repository.
2. Open Edge.
3. Go to `edge://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the folder that contains `manifest.json`.
7. Open a Curiosa deck page.

## How It Works

The extension has two main parts:

### Content Script

The content script runs on Curiosa deck pages. It scans the visible decklist, identifies likely card rows, extracts the card name and quantity, and injects price badges into the page.

### Background Service Worker

The background script fetches public Sorcery card-pricing data, builds a normalized card-name price index, and stores it in extension storage. The cached data is reused so the extension does not repeatedly request pricing data on every page load.

## File Structure

```text
.
├── manifest.json
├── background.js
├── content_curiosa.js
├── content_curiosa.css
├── popup.html
├── popup.js
└── README.md
```

## Updating Prices

The extension caches pricing data locally. To refresh it manually:

1. Click the extension icon in your browser toolbar.
2. Click **Refresh Prices**.
3. Reload the Curiosa deck page.

You can also use **Clear Cache** if the extension appears to be using old data.

## Known Limitations

- Prices are matched by normalized card name.
- If a card has multiple printings with the same name, the extension uses the lowest positive price it finds for that name.
- Curiosa decklists may not expose set, finish, or variant information in the visible list.
- Foil and non-foil versions are not currently distinguished.
- If Curiosa changes its page layout, the decklist scanner may need to be updated.
- If the public pricing data source changes its response format, the price parser may need to be updated.

## Troubleshooting

### Prices do not appear

Try the following:

1. Open the extension popup.
2. Click **Refresh Prices**.
3. Refresh the Curiosa deck page.
4. Confirm the URL matches `https://curiosa.io/decks/*`.
5. Open browser DevTools and check the Console for extension errors.

### A card says "No Price Found"

This usually means one of the following:

- The card name on Curiosa does not exactly match the pricing data name.
- The card is missing from the pricing source.
- The card is a token, variant, foil, promo, or alternate printing that is not currently matched.

### The total looks too low or too high

The total depends on quantity detection. If Curiosa renders quantity in a new layout, the scanner may need to be adjusted.

## Development

After editing the extension files:

1. Go to `chrome://extensions` or `edge://extensions`.
2. Find **Sorcery Curiosa Price Helper**.
3. Click the reload icon.
4. Refresh the Curiosa deck page.

For debugging, open DevTools on the Curiosa page and inspect the Console.

## Possible Future Improvements

- Exact set/finish matching
- Foil/non-foil toggle
- Export decklist with prices
- Show total by card type or Curiosa section
- Add options page for custom color tiers
- Add support for additional Sorcery deckbuilding sites

## License

MIT License is recommended if you want other people to freely use, modify, and contribute to this project.
