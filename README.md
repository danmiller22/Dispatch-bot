# Samsara ETA Bot (Deno Deploy, v2)

HTTP-сервис для бота, который по свободному тексту и/или структурному JSON считает:

- ETA и мили от трака (по Samsara) до одного или нескольких стопов (город/штат или адрес).
- ETA и мили от города/штата до другого города/штата (city-to-city), также с несколькими стопами.
- На каждый участок маршрута отдаёт готовую ссылку на маршрут в Google Maps (Google сам покажет ETA онлайн).
- Для трака также отдаёт точку на Google Maps с текущим местоположением.

## Примеры сценариев

### 1. Свободный текст с траком

```json
POST /eta
{
  "query": "ETA 1234 to Dallas TX"
}
```

или

```json
{
  "query": "1234 dallas tx"
}
```

Парсер поймёт:

- `1234` — номер трака;
- `Dallas TX` — город/штат назначения.

### 2. Свободный текст city-to-city

```json
POST /eta
{
  "query": "Chicago IL to Dallas TX"
}
```

Парсер поймёт origin и destination и посчитает маршрут `Chicago, IL` → `Dallas, TX`.

### 3. Структурный запрос: трак + несколько стопов

```json
POST /eta
{
  "truckNumber": "1234",
  "destinations": [
    { "city": "Dallas", "state": "TX" },
    { "city": "Houston", "state": "TX" }
  ]
}
```

- origin = текущая GPS-точка трака из Samsara.
- Считаются последовательно участки:
  - трак → Dallas, TX
  - Dallas, TX → Houston, TX
- По каждому участку: мили, ETA (cumulative) и ссылка на маршрут в Google Maps.

### 4. Структурный запрос: city-to-city (одно или несколько плеч)

```json
POST /eta
{
  "originCity": "Chicago",
  "originState": "IL",
  "destinations": [
    { "city": "Dallas", "state": "TX" },
    { "city": "Houston", "state": "TX" }
  ]
}
```

- origin = Chicago, IL (геокодится через OSM).
- Плечи:
  - Chicago, IL → Dallas, TX
  - Dallas, TX → Houston, TX

### 5. Обратная совместимость (старый формат)

```json
POST /eta
{
  "truckNumber": "1234",
  "city": "Dallas",
  "state": "TX"
}
```

Будет работать как раньше, но в ответе станет больше полей.

## Формат ответа (основное)

Ответ всегда JSON вида (упрощённо):

```json
{
  "mode": "truck",
  "truckNumber": "1234",
  "vehicleName": "UNIT 1234",
  "vehicleLocation": {
    "lat": 32.78,
    "lng": -96.80,
    "formattedAddress": "Somewhere, TX",
    "mapsUrl": "https://www.google.com/maps/search/?api=1&query=32.78,-96.80"
  },
  "origin": {
    "label": "Truck current location",
    "lat": 32.78,
    "lng": -96.80,
    "mapsUrl": "https://www.google.com/maps/search/?api=1&query=32.78,-96.80"
  },
  "legs": [
    {
      "index": 0,
      "origin": {
        "label": "Truck current location",
        "lat": 32.78,
        "lng": -96.80
      },
      "destination": {
        "label": "Dallas, TX",
        "city": "Dallas",
        "state": "TX",
        "lat": 32.77,
        "lng": -96.80
      },
      "distanceKm": 1234.5,
      "distanceMiles": 767.0,
      "durationSeconds": 43200,
      "durationHuman": "12h 0m",
      "arrivalIso": "2025-01-01T12:34:56Z",
      "mapsDirectionsUrl": "https://www.google.com/maps/dir/?api=1&origin=32.78,-96.80&destination=32.77,-96.80&travelmode=driving"
    }
  ],
  "summary": {
    "totalDistanceKm": 1234.5,
    "totalDistanceMiles": 767.0,
    "totalDurationSeconds": 43200,
    "totalDurationHuman": "12h 0m",
    "finalArrivalIso": "2025-01-01T12:34:56Z",
    "mapsDirectionsUrl": "https://www.google.com/maps/dir/?api=1&origin=32.78,-96.80&destination=32.77,-96.80&travelmode=driving"
  },
  "eta": {
    "distanceKm": 1234.5,
    "distanceMiles": 767.0,
    "durationSeconds": 43200,
    "durationHuman": "12h 0m",
    "arrivalIso": "2025-01-01T12:34:56Z"
  },
  "destination": {
    "city": "Dallas",
    "state": "TX",
    "lat": 32.77,
    "lng": -96.80
  }
}
```

Комментарии:

- `mode`:
  - `"truck"` — стартуем от GPS трака;
  - `"city"` — стартуем от origin-города.
- `legs[]` — все плечи маршрута (включая multi-stop).
- `summary` — общие цифры по всему маршруту + общая ссылка в Google Maps с waypoints (если стопов несколько).
- Для обратной совместимости при единственном стопе дублируется `eta` и `destination` как раньше.

## Используемые внешние сервисы

1. **Samsara** (как и в v1):
   - `GET /fleet/vehicles` — поиск трака по `name == truckNumber`.
   - `GET /fleet/vehicles/stats?types=gps` — текущие GPS-данные.

2. **Geocoding / Reverse geocoding**:
   - Nominatim (OpenStreetMap) — геокодинг города/штата или адреса в координаты.

3. **Routing + ETA**:
   - OSRM public API — `route/v1/driving` для получения дистанции и длительности по каждому плечу.

4. **Google Maps**:
   - Для каждой точки: `https://www.google.com/maps/search/?api=1&query=lat,lng`.
   - Для каждого плеча/общего маршрута: `https://www.google.com/maps/dir/?api=1&origin=...&destination=...&waypoints=...&travelmode=driving`.

## Переменные окружения

- `SAMSARA_API_TOKEN` — API токен Samsara вида `samsara_api_...`.

## Локальный запуск

```bash
deno task dev
# или
deno run --allow-net --allow-env main.ts
```

Проверка:

```bash
curl -X POST http://localhost:8000/eta   -H "Content-Type: application/json"   -d '{"query": "ETA 1234 to Dallas TX"}'
```

## Деплой на Deno Deploy (как и раньше)

1. Заливаешь этот репо на GitHub.
2. Новый проект в Deno Deploy из этого репо, entrypoint `main.ts`.
3. В env переменных проекта задаёшь `SAMSARA_API_TOKEN`.
4. Бот шлёт POST на `/eta` с JSON в форматах как выше.
