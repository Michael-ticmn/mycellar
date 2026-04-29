// Varietal → drink-window lookup. Years are offsets from vintage year.
// `years_after_vintage` = full sane window. `peak` = subjective sweet spot.
// On bottle insert, drink_window_start = vintage + years_after_vintage[0],
// drink_window_end = vintage + years_after_vintage[1]. User can override.
//
// Sources: Wine Folly, Jancis Robinson, K&L Wine Merchants typical-drinking guides.
// Entries marked `// TODO confirm` are educated guesses — Chat please verify.

export const VARIETAL_WINDOWS = {
  // ── Reds ────────────────────────────────────────────────
  'Cabernet Sauvignon':   { years_after_vintage: [3, 15], peak: [5, 12] },
  'Merlot':               { years_after_vintage: [2, 10], peak: [3, 7]  },
  'Pinot Noir':           { years_after_vintage: [2, 8],  peak: [3, 6]  },
  'Syrah':                { years_after_vintage: [3, 12], peak: [5, 10] },
  'Shiraz':               { years_after_vintage: [3, 12], peak: [5, 10] },
  'Zinfandel':            { years_after_vintage: [2, 7],  peak: [3, 5]  },
  'Malbec':               { years_after_vintage: [2, 10], peak: [4, 8]  },
  'Tempranillo':          { years_after_vintage: [3, 12], peak: [5, 10] },
  'Sangiovese':           { years_after_vintage: [3, 12], peak: [5, 10] },
  'Nebbiolo':             { years_after_vintage: [5, 25], peak: [10, 20] },
  'Barbera':              { years_after_vintage: [2, 7],  peak: [3, 5]  }, // TODO confirm
  'Grenache':             { years_after_vintage: [2, 10], peak: [4, 8]  },
  'Mourvèdre':            { years_after_vintage: [3, 12], peak: [5, 10] }, // TODO confirm
  'Cabernet Franc':       { years_after_vintage: [3, 12], peak: [5, 9]  }, // TODO confirm
  'Petite Sirah':         { years_after_vintage: [3, 15], peak: [6, 12] }, // TODO confirm
  'Gamay':                { years_after_vintage: [1, 5],  peak: [2, 4]  },
  'Bordeaux Blend':       { years_after_vintage: [4, 20], peak: [7, 15] },
  'GSM Blend':            { years_after_vintage: [2, 10], peak: [4, 8]  },
  'Rhône Blend':          { years_after_vintage: [3, 15], peak: [5, 10] }, // TODO confirm
  'Red Blend':            { years_after_vintage: [2, 8],  peak: [3, 6]  }, // generic fallback

  // ── Whites ──────────────────────────────────────────────
  'Chardonnay':           { years_after_vintage: [1, 5],  peak: [2, 4]  },
  'Sauvignon Blanc':      { years_after_vintage: [0, 3],  peak: [1, 2]  },
  'Riesling':             { years_after_vintage: [1, 15], peak: [3, 10] },
  'Pinot Grigio':         { years_after_vintage: [0, 3],  peak: [1, 2]  },
  'Pinot Gris':           { years_after_vintage: [0, 4],  peak: [1, 3]  },
  'Chenin Blanc':         { years_after_vintage: [1, 12], peak: [3, 8]  }, // TODO confirm
  'Gewürztraminer':       { years_after_vintage: [1, 5],  peak: [2, 4]  }, // TODO confirm
  'Viognier':             { years_after_vintage: [1, 4],  peak: [1, 3]  }, // TODO confirm
  'Albariño':             { years_after_vintage: [0, 3],  peak: [1, 2]  },
  'Grüner Veltliner':     { years_after_vintage: [1, 6],  peak: [2, 4]  }, // TODO confirm
  'Sémillon':             { years_after_vintage: [2, 10], peak: [4, 8]  }, // TODO confirm
  'White Blend':          { years_after_vintage: [0, 4],  peak: [1, 3]  }, // generic fallback

  // ── Rosé ────────────────────────────────────────────────
  'Rosé':                 { years_after_vintage: [0, 2],  peak: [0, 1]  },

  // ── Sparkling ───────────────────────────────────────────
  'Champagne':            { years_after_vintage: [2, 15], peak: [4, 10] },
  'Champagne (Vintage)':  { years_after_vintage: [5, 25], peak: [8, 18] },
  'Prosecco':             { years_after_vintage: [0, 2],  peak: [0, 1]  },
  'Cava':                 { years_after_vintage: [1, 5],  peak: [1, 3]  }, // TODO confirm
  'Sparkling':            { years_after_vintage: [1, 5],  peak: [2, 4]  }, // generic fallback

  // ── Dessert / Fortified ─────────────────────────────────
  'Sauternes':            { years_after_vintage: [5, 30], peak: [10, 20] }, // TODO confirm
  'Port (Vintage)':       { years_after_vintage: [10, 50], peak: [20, 40] },
  'Port (Tawny)':         { years_after_vintage: [0, 5],  peak: [0, 3]  }, // bottled ready-to-drink
  'Sherry':               { years_after_vintage: [0, 5],  peak: [0, 3]  }, // TODO confirm — varies wildly by style
  'Madeira':              { years_after_vintage: [0, 50], peak: [5, 30] }, // effectively ageless once bottled
  'Ice Wine':             { years_after_vintage: [2, 15], peak: [4, 10] }, // TODO confirm
  'Late Harvest':         { years_after_vintage: [2, 15], peak: [4, 10] }, // TODO confirm
};

// Style → fallback when varietal isn't recognized.
export const STYLE_FALLBACK_WINDOWS = {
  light_red:    { years_after_vintage: [1, 5],  peak: [2, 4]  },
  medium_red:   { years_after_vintage: [2, 8],  peak: [3, 6]  },
  full_red:     { years_after_vintage: [3, 12], peak: [5, 10] },
  light_white:  { years_after_vintage: [0, 3],  peak: [1, 2]  },
  full_white:   { years_after_vintage: [1, 5],  peak: [2, 4]  },
  rose:         { years_after_vintage: [0, 2],  peak: [0, 1]  },
  sparkling:    { years_after_vintage: [1, 5],  peak: [2, 4]  },
  dessert:      { years_after_vintage: [2, 15], peak: [4, 10] },
  fortified:    { years_after_vintage: [0, 20], peak: [3, 15] },
};

export function lookupWindow(varietal, style) {
  if (varietal && VARIETAL_WINDOWS[varietal]) return VARIETAL_WINDOWS[varietal];
  if (style && STYLE_FALLBACK_WINDOWS[style]) return STYLE_FALLBACK_WINDOWS[style];
  return null;
}

export function suggestDrinkWindow({ varietal, style, vintage }) {
  if (!vintage) return { start: null, end: null };
  const w = lookupWindow(varietal, style);
  if (!w) return { start: null, end: null };
  return {
    start: vintage + w.years_after_vintage[0],
    end:   vintage + w.years_after_vintage[1],
  };
}

export const VARIETAL_NAMES = Object.keys(VARIETAL_WINDOWS);
