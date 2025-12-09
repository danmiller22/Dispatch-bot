// Deno HTTP server for ETA + mileage based on Samsara GPS + city-to-city routes + Telegram webhook.
//
// Features:
// - Free-text queries: "ETA 5051 to Dallas TX", "5051 Dallas TX", "Chicago IL to Dallas TX".
// - Structured JSON: truckNumber + destinations[] (multi-stop) or originCity/originState + destinations[].
// - Returns miles + kilometers, ETA for each leg, and Google Maps route links.
// - Browser test:
//   GET /eta?q=ETA 5051 to Dallas TX
//   GET /eta?query=Chicago IL to Dallas TX
// - Telegram webhook: POST /telegram (Telegram sends updates here).

const SAMSARA_TOKEN = Deno.env.get("SAMSARA_API_TOKEN");
const SAMSARA_BASE = "https://api.samsara.com";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_API_BASE = TELEGRAM_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}` : null;

if (!SAMSARA_TOKEN) {
  console.warn("[WARN] SAMSARA_API_TOKEN is not set. Requests to Samsara will fail.");
}
if (!TELEGRAM_TOKEN) {
  console.warn("[WARN] TELEGRAM_BOT_TOKEN is not set. Telegram replies will be disabled.");
}

// ===== Types =====

type StopInput = {
  city?: string;
  state?: string;
  address?: string;
};

type EtaRequest = {
  query?: string;

  // truck-based
  truckNumber?: string;

  // single destination (backward compatibility)
  city?: string;
  state?: string;

  // city-based origin
  originCity?: string;
  originState?: string;

  // multiple stops
  destinations?: StopInput[];
};

type GpsStat = {
  time: string;
  latitude: number;
  longitude: number;
  headingDegrees?: number;
  speedMilesPerHour?: number;
  reverseGeo?: {
    formattedLocation?: string;
  };
};

type VehicleSnapshot = {
  id: string;
  name: string;
  gps?: GpsStat;
};

type ParsedQuery =
  | {
      mode: "truck";
      truckNumber: string;
      city?: string;
      state?: string;
    }
  | {
      mode: "city";
      originCity: string;
      originState: string;
      city?: string;
      state?: string;
    };

type Point = { lat: number; lng: number };

type LegResponse = {
  index: number;
  origin: {
    label: string;
    lat: number;
    lng: number;
  };
  destination: {
    label: string;
    city?: string;
    state?: string;
    lat: number;
    lng: number;
  };
  distanceKm: number;
  distanceMiles: number;
  durationSeconds: number;
  durationHuman: string;
  arrivalIso: string;
  mapsDirectionsUrl: string;
};

type ApiResponse = {
  mode: "truck" | "city";
  // truck mode
  truckNumber?: string;
  vehicleName?: string;
  vehicleLocation?: {
    lat: number;
    lng: number;
    formattedAddress: string | null;
    mapsUrl: string;
  };
  // origin summary
  origin: {
    label: string;
    lat: number;
    lng: number;
    mapsUrl: string;
  };
  // legs
  legs: LegResponse[];
  // route summary
  summary: {
    totalDistanceKm: number;
    totalDistanceMiles: number;
    totalDurationSeconds: number;
    totalDurationHuman: string;
    finalArrivalIso: string;
    mapsDirectionsUrl: string;
  };
  // backward compatibility for single-stop case
  eta?: {
    distanceKm: number;
    distanceMiles: number;
    durationSeconds: number;
    durationHuman: string;
    arrivalIso: string;
  };
  destination?: {
    city?: string;
    state?: string;
    lat: number;
    lng: number;
  };
};

// ===== Utils =====

async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const headers: HeadersInit = {
    ...init.headers,
    Authorization: `Bearer ${SAMSARA_TOKEN}`,
    Accept: "application/json",
  };

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${body}`);
  }
  return await response.json();
}

// find truck by name == truckNumber in Samsara
async function findVehicleByTruckNumber(truckNumber: string): Promise<{ id: string; name: string } | null> {
  let after: string | undefined = undefined;

  while (true) {
    const params = new URLSearchParams();
    params.set("limit", "512");
    if (after) params.set("after", after);

    const url = `${SAMSARA_BASE}/fleet/vehicles?${params.toString()}`;
    const data = await fetchJson(url);
    const vehicles = (data.data ?? []) as Array<{ id: string; name?: string }>;

    const match = vehicles.find((v) => (v.name ?? "").trim().toLowerCase() === truckNumber.trim().toLowerCase());
    if (match) {
      return { id: String(match.id), name: match.name ?? truckNumber };
    }

    const pagination = data.pagination ?? {};
    if (!pagination.hasNextPage) break;
    after = pagination.endCursor;
    if (!after) break;
  }

  return null;
}

// get GPS stats by vehicleId
async function getVehicleGpsById(vehicleId: string): Promise<GpsStat | null> {
  const params = new URLSearchParams();
  params.set("types", "gps");
  const url = `${SAMSARA_BASE}/fleet/vehicles/stats?${params.toString()}`;
  const data = await fetchJson(url);
  const vehicles = (data.data ?? []) as VehicleSnapshot[];
  const v = vehicles.find((item) => String(item.id) === String(vehicleId));
  return v?.gps ?? null;
}

// geocode city/state or full address
async function geocode(query: string): Promise<Point | null> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("format", "json");
  params.set("limit", "1");

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "samsara-eta-bot/1.0 (deno-deploy)",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Geocoding failed HTTP ${response.status}: ${body}`);
  }
  const json = await response.json();
  if (!Array.isArray(json) || json.length === 0) return null;
  const first = json[0];
  return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
}

async function geocodeCityState(city: string, state: string): Promise<Point | null> {
  const q = `${city}, ${state}, USA`;
  return await geocode(q);
}

async function geocodeStop(stop: StopInput): Promise<{ point: Point; label: string; city?: string; state?: string }> {
  if (stop.address) {
    const point = await geocode(stop.address);
    if (!point) throw new Error(`Cannot geocode address: ${stop.address}`);
    return { point, label: stop.address };
  }
  if (stop.city && stop.state) {
    const point = await geocodeCityState(stop.city, stop.state);
    if (!point) throw new Error(`Cannot geocode city/state: ${stop.city}, ${stop.state}`);
    return { point, label: `${stop.city}, ${stop.state}`, city: stop.city, state: stop.state };
  }
  throw new Error("Stop must have either address or city+state");
}

// routing and ETA via OSRM
async function routeEta(origin: Point, dest: Point): Promise<{ distanceKm: number; durationSeconds: number }> {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=false&annotations=duration`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OSRM failed HTTP ${response.status}: ${body}`);
  }
  const json = await response.json();
  const route = json.routes?.[0];
  if (!route) {
    throw new Error("No route found from OSRM");
  }
  const distanceKm = (route.distance ?? 0) / 1000;
  const durationSeconds = Math.round(route.duration ?? 0);
  return { distanceKm, durationSeconds };
}

function formatDuration(sec: number): string {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function kmToMiles(km: number): number {
  return Math.round(km * 0.621371 * 10) / 10; // 1 decimal
}

function buildPointMapsUrl(point: Point): string {
  return `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}`;
}

function buildDirectionsUrl(origin: Point, dest: Point): string {
  const originParam = encodeURIComponent(`${origin.lat},${origin.lng}`);
  const destParam = encodeURIComponent(`${dest.lat},${dest.lng}`);
  return `https://www.google.com/maps/dir/?api=1&origin=${originParam}&destination=${destParam}&travelmode=driving`;
}

function buildMultiStopDirectionsUrl(origin: Point, stops: Point[]): string {
  if (stops.length === 0) {
    return buildDirectionsUrl(origin, origin);
  }
  const finalDest = stops[stops.length - 1];
  const waypoints = stops.slice(0, -1);
  const originParam = encodeURIComponent(`${origin.lat},${origin.lng}`);
  const destParam = encodeURIComponent(`${finalDest.lat},${finalDest.lng}`);
  let url =
    `https://www.google.com/maps/dir/?api=1&origin=${originParam}&destination=${destParam}&travelmode=driving`;
  if (waypoints.length > 0) {
    const wp = waypoints.map((p) => `${p.lat},${p.lng}`).join("|");
    url += `&waypoints=${encodeURIComponent(wp)}`;
  }
  return url;
}

// format arrival time in Chicago time (CDT/CST)
function formatChicagoTime(iso: string): string {
  const d = new Date(iso);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const t = formatter.format(d);
  return `${t} CDT`;
}

// parse free-text requests
function parseFreeformQuery(q: string): ParsedQuery | null {
  const tokens = q.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return null;

  const lower = tokens.map((t) => t.toLowerCase());
  const toIdx = lower.findIndex((t) => t === "to");

  // truckNumber = first token with a digit
  const truckIdx = tokens.findIndex((t) => /\d/.test(t));

  if (truckIdx >= 0) {
    const truckNumber = tokens[truckIdx];
    let destTokens: string[] = [];
    if (toIdx >= 0 && toIdx < tokens.length - 1) {
      destTokens = tokens.slice(toIdx + 1);
    } else {
      destTokens = tokens.slice(truckIdx + 1);
    }
    if (destTokens.length >= 2) {
      const state = destTokens[destTokens.length - 1];
      const city = destTokens.slice(0, -1).join(" ");
      return { mode: "truck", truckNumber, city, state };
    }
    return { mode: "truck", truckNumber };
  }

  // city-to-city: "Chicago IL to Dallas TX"
  if (toIdx > 0 && toIdx < tokens.length - 1) {
    const originTokens = tokens.slice(0, toIdx);
    const destTokens = tokens.slice(toIdx + 1);
    if (originTokens.length >= 2 && destTokens.length >= 2) {
      const originState = originTokens[originTokens.length - 1];
      const originCity = originTokens.slice(0, -1).join(" ");
      const state = destTokens[destTokens.length - 1];
      const city = destTokens.slice(0, -1).join(" ");
      return { mode: "city", originCity, originState, city, state };
    }
  }

  return null;
}

// ===== Core ETA logic (shared by API + Telegram) =====

async function processEta(payload: EtaRequest): Promise<Response> {
  if (!SAMSARA_TOKEN) {
    return new Response(JSON.stringify({ error: "SAMSARA_API_TOKEN is not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let { truckNumber, city, state, originCity, originState } = payload;

  // free-text has priority
  if (payload.query && payload.query.trim().length > 0) {
    const parsed = parseFreeformQuery(payload.query);
    if (parsed) {
      if (parsed.mode === "truck") {
        truckNumber = parsed.truckNumber;
        city = parsed.city ?? city;
        state = parsed.state ?? state;
      } else if (parsed.mode === "city") {
        originCity = parsed.originCity;
        originState = parsed.originState;
        city = parsed.city ?? city;
        state = parsed.state ?? state;
      }
    }
  }

  // collect stops
  const stops: StopInput[] = [];
  if (Array.isArray(payload.destinations) && payload.destinations.length > 0) {
    stops.push(...payload.destinations);
  } else if (city && state) {
    stops.push({ city, state });
  }

  if (stops.length === 0) {
    return new Response(JSON.stringify({ error: "No destinations provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = new Date();
  let mode: "truck" | "city";
  let originPoint: Point;
  let originLabel: string;
  let vehicleLocation: ApiResponse["vehicleLocation"] | undefined;
  let truckName: string | undefined;

  try {
    if (truckNumber) {
      mode = "truck";

      const vehicle = await findVehicleByTruckNumber(truckNumber);
      if (!vehicle) {
        return new Response(JSON.stringify({ error: `Truck ${truckNumber} not found in Samsara` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      truckName = vehicle.name;

      const gps = await getVehicleGpsById(vehicle.id);
      if (!gps) {
        return new Response(JSON.stringify({ error: `No GPS data for truck ${truckNumber}` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      originPoint = { lat: gps.latitude, lng: gps.longitude };
      originLabel = gps.reverseGeo?.formattedLocation ?? "Truck current location";

      vehicleLocation = {
        lat: gps.latitude,
        lng: gps.longitude,
        formattedAddress: gps.reverseGeo?.formattedLocation ?? null,
        mapsUrl: buildPointMapsUrl(originPoint),
      };
    } else {
      // city-based origin
      if (!originCity || !originState) {
        return new Response(
          JSON.stringify({
            error: "originCity and originState are required for city-based routing when truckNumber is not provided",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      mode = "city";
      const origin = await geocodeCityState(originCity, originState);
      if (!origin) {
        return new Response(JSON.stringify({ error: `Cannot geocode origin ${originCity}, ${originState}` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      originPoint = origin;
      originLabel = `${originCity}, ${originState}`;
    }

    // geocode stops
    const stopGeos = [];
    for (const s of stops) {
      const geo = await geocodeStop(s);
      stopGeos.push(geo);
    }

    // build legs
    const legs: LegResponse[] = [];
    let currentPoint: Point = originPoint;
    let currentLabel: string = originLabel;
    let currentTime = new Date(now.getTime());

    let totalDistanceKm = 0;
    let totalDurationSeconds = 0;

    for (let i = 0; i < stopGeos.length; i++) {
      const s = stopGeos[i];
      const { point: destPoint, label: destLabel, city: destCity, state: destState } = s;
      const { distanceKm, durationSeconds } = await routeEta(currentPoint, destPoint);
      const distanceMiles = kmToMiles(distanceKm);

      totalDistanceKm += distanceKm;
      totalDurationSeconds += durationSeconds;

      const arrival = new Date(currentTime.getTime() + durationSeconds * 1000);
      currentTime = arrival;

      const leg: LegResponse = {
        index: i,
        origin: {
          label: currentLabel,
          lat: currentPoint.lat,
          lng: currentPoint.lng,
        },
        destination: {
          label: destLabel,
          city: destCity,
          state: destState,
          lat: destPoint.lat,
          lng: destPoint.lng,
        },
        distanceKm,
        distanceMiles,
        durationSeconds,
        durationHuman: formatDuration(durationSeconds),
        arrivalIso: arrival.toISOString(),
        mapsDirectionsUrl: buildDirectionsUrl(currentPoint, destPoint),
      };

      legs.push(leg);
      currentPoint = destPoint;
      currentLabel = destLabel;
    }

    const totalDistanceMiles = kmToMiles(totalDistanceKm);
    const finalArrivalIso = currentTime.toISOString();
    const multiStopPoints = stopGeos.map((g) => g.point);
    const summaryMapsUrl = buildMultiStopDirectionsUrl(originPoint, multiStopPoints);

    const originMapsUrl = buildPointMapsUrl(originPoint);

    const response: ApiResponse = {
      mode,
      truckNumber: truckNumber ?? undefined,
      vehicleName: truckName,
      vehicleLocation,
      origin: {
        label: originLabel,
        lat: originPoint.lat,
        lng: originPoint.lng,
        mapsUrl: originMapsUrl,
      },
      legs,
      summary: {
        totalDistanceKm,
        totalDistanceMiles,
        totalDurationSeconds,
        totalDurationHuman: formatDuration(totalDurationSeconds),
        finalArrivalIso,
        mapsDirectionsUrl: summaryMapsUrl,
      },
    };

    // backward compatibility for single destination
    if (legs.length === 1) {
      const first = legs[0];
      response.eta = {
        distanceKm: first.distanceKm,
        distanceMiles: first.distanceMiles,
        durationSeconds: first.durationSeconds,
        durationHuman: first.durationHuman,
        arrivalIso: first.arrivalIso,
      };
      response.destination = {
        city: first.destination.city,
        state: first.destination.state,
        lat: first.destination.lat,
        lng: first.destination.lng,
      };
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Internal error", details: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ===== Telegram helpers =====

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  if (!TELEGRAM_API_BASE) {
    console.warn("[WARN] TELEGRAM_API_BASE not set, cannot send Telegram messages");
    return;
  }
  await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  }).catch((e) => console.error("Failed to send Telegram message", e));
}

// Telegram webhook handler
async function handleTelegram(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("ok");
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  const message = update.message ?? update.edited_message;
  if (!message || typeof message.text !== "string") {
    return new Response("ok");
  }

  const chatId: number = message.chat.id;
  const text: string = message.text.trim();

  if (!text) {
    return new Response("ok");
  }

  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      [
        "Send an ETA request, for example:",
        "",
        "<code>ETA 5051 to Dallas TX</code>",
        "<code>5051 Dallas TX</code>",
        "<code>Chicago IL to Dallas TX</code>",
        "",
        "You can also send city-to-city only: <code>Chicago IL to Dallas TX</code>",
      ].join("\n"),
    );
    return new Response("ok");
  }

  // feed user text into ETA engine
  const etaResp = await processEta({ query: text });
  const clone = etaResp.clone();

  let body: any = null;
  try {
    body = await clone.json();
  } catch {
    body = null;
  }

  if (!etaResp.ok || !body || body.error) {
    await sendTelegramMessage(
      chatId,
      `ETA calculation error: ${body?.error ?? `HTTP ${etaResp.status}`}`,
    );
    return new Response("ok");
  }

  const eta = body as ApiResponse;

  const lines: string[] = [];

  if (eta.truckNumber) {
    lines.push(`🚛 Truck <b>${eta.truckNumber}</b>`);
  } else if (eta.mode === "city") {
    lines.push("📍 City-to-city route");
  }

  if (eta.origin?.label) {
    lines.push(`Current location: <b>${eta.origin.label}</b>`);
  }

  if (Array.isArray(eta.legs) && eta.legs.length > 0) {
    const first = eta.legs[0];
    const firstArrivalLocal = formatChicagoTime(first.arrivalIso);

    lines.push(`Destination: <b>${first.destination.label}</b>`);
    lines.push(`Distance: <b>${first.distanceMiles.toFixed(1)} mi</b>`);
    lines.push(`ETA drive time: <b>${first.durationHuman}</b>`);
    lines.push(`ETA arrival time: <b>${firstArrivalLocal}</b>`);

    lines.push("");
    lines.push(`Route link: ${first.mapsDirectionsUrl}`);
  }

  if (eta.summary) {
    const finalArrivalLocal = formatChicagoTime(eta.summary.finalArrivalIso);

    lines.push("");
    lines.push(`Total route distance: <b>${eta.summary.totalDistanceMiles.toFixed(1)} mi</b>`);
    lines.push(`Total drive time: <b>${eta.summary.totalDurationHuman}</b>`);
    lines.push(`Final ETA arrival time: <b>${finalArrivalLocal}</b>`);

    lines.push("");
    lines.push(`Full route link: ${eta.summary.mapsDirectionsUrl}`);
  }

  if (eta.vehicleLocation?.mapsUrl) {
    lines.push("");
    lines.push(`Truck current GPS position: ${eta.vehicleLocation.mapsUrl}`);
  }

  if (lines.length === 0) {
    lines.push("No ETA data available for this request.");
  }

  await sendTelegramMessage(chatId, lines.join("\n"));

  return new Response("ok");
}

// ===== HTTP server =====

Deno.serve((req) => {
  const url = new URL(req.url);

  if (url.pathname === "/eta") {
    // simple browser test
    if (req.method === "GET") {
      const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      const payload: EtaRequest = { query: q };
      return processEta(payload);
    }

    // POST for production usage
    if (req.method === "POST") {
      return (async () => {
        let payload: EtaRequest;
        try {
          payload = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return processEta(payload);
      })();
    }

    return new Response(JSON.stringify({ error: "Use GET or POST" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/telegram") {
    return handleTelegram(req);
  }

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not Found", { status: 404 });
});
