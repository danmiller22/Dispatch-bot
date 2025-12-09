// Deno HTTP сервер для расчёта ETA и миль по данным Samsara + city-to-city маршруты.
//
// Возможности:
// - Свободный текст: "ETA 1234 to Dallas TX", "1234 dallas tx", "Chicago IL to Dallas TX".
// - Структура: truckNumber + destinations[] (multi-stop) или originCity/originState + destinations[].
// - Всегда отдаём мили и километры, ETA по каждому плечу и ссылки на маршруты в Google Maps.

const SAMSARA_TOKEN = Deno.env.get("SAMSARA_API_TOKEN");
const SAMSARA_BASE = "https://api.samsara.com";

if (!SAMSARA_TOKEN) {
  console.warn("[WARN] SAMSARA_API_TOKEN is not set. Requests to Samsara will fail.");
}

// ===== Типы =====

type StopInput = {
  city?: string;
  state?: string;
  address?: string;
};

type EtaRequest = {
  query?: string;

  // Truck-based
  truckNumber?: string;

  // Single destination (backward compatibility)
  city?: string;
  state?: string;

  // City-based origin
  originCity?: string;
  originState?: string;

  // Multiple stops
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
  // origin summary (truck location или origin city)
  origin: {
    label: string;
    lat: number;
    lng: number;
    mapsUrl: string;
  };
  // плечи
  legs: LegResponse[];
  // суммарные метрики по маршруту
  summary: {
    totalDistanceKm: number;
    totalDistanceMiles: number;
    totalDurationSeconds: number;
    totalDurationHuman: string;
    finalArrivalIso: string;
    mapsDirectionsUrl: string;
  };
  // для обратной совместимости при единственном стопе
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

// ===== Утилиты =====

async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const headers: HeadersInit = {
    ...init.headers,
    "Authorization": `Bearer ${SAMSARA_TOKEN}`,
    "Accept": "application/json",
  };

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${body}`);
  }
  return await response.json();
}

// Поиск трака по name == truckNumber
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

// Берём GPS-данные по vehicleId
async function getVehicleGpsById(vehicleId: string): Promise<GpsStat | null> {
  const params = new URLSearchParams();
  params.set("types", "gps");
  const url = `${SAMSARA_BASE}/fleet/vehicles/stats?${params.toString()}`;
  const data = await fetchJson(url);
  const vehicles = (data.data ?? []) as VehicleSnapshot[];
  const v = vehicles.find((item) => String(item.id) === String(vehicleId));
  return v?.gps ?? null;
}

// Геокодинг (город/штат или полный адрес)
async function geocode(query: string): Promise<Point | null> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("format", "json");
  params.set("limit", "1");

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
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

// Маршрут и ETA через OSRM
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
  return Math.round((km * 0.621371) * 10) / 10; // 1 знак после запятой
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
  const firstDest = stops[stops.length - 1];
  const waypoints = stops.slice(0, -1);
  const originParam = encodeURIComponent(`${origin.lat},${origin.lng}`);
  const destParam = encodeURIComponent(`${firstDest.lat},${firstDest.lng}`);
  let url =
    `https://www.google.com/maps/dir/?api=1&origin=${originParam}&destination=${destParam}&travelmode=driving`;
  if (waypoints.length > 0) {
    const wp = waypoints.map((p) => `${p.lat},${p.lng}`).join("|");
    url += `&waypoints=${encodeURIComponent(wp)}`;
  }
  return url;
}

// Парсинг свободного текста
function parseFreeformQuery(q: string): ParsedQuery | null {
  const tokens = q.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return null;

  const lower = tokens.map((t) => t.toLowerCase());
  const toIdx = lower.findIndex((t) => t === "to");

  // truckNumber = первый токен с цифрой
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

// ===== Основной handler =====

async function handleEta(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: EtaRequest;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!SAMSARA_TOKEN) {
    return new Response(JSON.stringify({ error: "SAMSARA_API_TOKEN is not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let { truckNumber, city, state, originCity, originState } = payload;

  // Свободный текст имеет приоритет, если задан
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

  // Собираем массив стопов
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
        return new Response(JSON.stringify({ error: "originCity and originState are required for city-based routing" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
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

    // Геокодим все стопы
    const stopGeos = [];
    for (const s of stops) {
      const geo = await geocodeStop(s);
      stopGeos.push(geo);
    }

    // Считаем плечи
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

    // Обратная совместимость для одного стопа
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

// ===== HTTP сервер =====

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.pathname === "/eta") {
    return handleEta(req);
  }
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("Not Found", { status: 404 });
});
