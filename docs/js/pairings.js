import { createRequest, waitForResponse } from './pairing-bus.js';

export async function requestPairing({ dish, guests, occasion, constraints }) {
  const req = await createRequest({
    requestType: 'pairing',
    context: { dish, guests, occasion, constraints },
  });
  return { request: req, response: await waitForResponse(req.id) };
}

export async function requestFlight({ theme, guests, length, food, notes }) {
  const req = await createRequest({
    requestType: 'flight',
    context: {
      theme,
      guests,
      length,
      food:  food  || null,
      notes: notes || null,
    },
  });
  return { request: req, response: await waitForResponse(req.id) };
}

// Ask the sommelier for 1–2 wines NOT in the cellar that would expand
// flight-building potential. Recommendations array stays empty (those
// picks aren't owned); the actual suggestions live in the narrative.
export async function requestFlightExtras({ themeHint }) {
  const req = await createRequest({
    requestType: 'flight',
    context: { kind: 'extras', theme_hint: themeHint || null },
  });
  return { request: req, response: await waitForResponse(req.id) };
}

export async function requestDrinkNow({ notes }) {
  const req = await createRequest({
    requestType: 'drink_now',
    context: { notes: notes || null },
  });
  return { request: req, response: await waitForResponse(req.id) };
}
