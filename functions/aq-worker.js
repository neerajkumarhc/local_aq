/**
 * Cloudflare Pages Function — OpenAQ PM2.5 Proxy
 * Served at: /aq-worker
 *
 * Required secret (set via dashboard or `wrangler pages secret put OPENAQ_API_KEY`):
 *   OPENAQ_API_KEY
 *
 * Optional variable (wrangler.toml [vars] or dashboard):
 *   ALLOWED_ORIGIN  — restrict CORS to your domain, e.g. "https://example.com"
 *                     Defaults to "*" if not set.
 *
 * GET /aq-worker?lat={latitude}&lon={longitude}
 */

export async function onRequest({ request, env }) {
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const url = new URL(request.url);
  const latStr = url.searchParams.get('lat');
  const lonStr = url.searchParams.get('lon');
  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);

  if (!latStr || !lonStr || isNaN(lat) || isNaN(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return json({ error: 'Missing or invalid lat/lon parameters' }, 400, corsHeaders);
  }

  const apiKey = env.OPENAQ_API_KEY;
  if (!apiKey) {
    return json({ error: 'OPENAQ_API_KEY environment variable not configured' }, 500, corsHeaders);
  }

  const headers = { 'X-API-Key': apiKey, 'Accept': 'application/json' };

  try {
    // ── Step 1: Find nearest location with PM2.5 sensor (parameters_id=2) ──
    const locUrl =
      `https://api.openaq.org/v3/locations` +
      `?coordinates=${lat},${lon}` +
      `&radius=25000` +
      `&parameters_id=2` +
      `&limit=10`;

    const locResp = await fetch(locUrl, { headers });
    if (!locResp.ok) {
      const txt = await locResp.text();
      throw new Error(`OpenAQ locations ${locResp.status}: ${txt.slice(0, 300)}`);
    }
    const locData = await locResp.json();

    // Sort by distance ascending (API doesn't support order_by=distance)
    locData.results?.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

    if (!locData.results?.length) {
      return json(
        { error: 'No PM2.5 monitoring stations found within 100 km of your location' },
        404, corsHeaders
      );
    }

    // Pick first result that has an active PM2.5 sensor
    // A sensor is considered active if its lastUpdated is within the last 48 hours
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let location = null;
    let pm25Sensor = null;
    for (const loc of locData.results) {
      const sensor = loc.sensors?.find(s => {
        const name = s.parameter?.name;
        if (name !== 'pm25' && name !== 'PM2.5') return false;
        const lastUpdated = s.lastUpdated ?? s.lastValue?.datetime?.to ?? null;
        return lastUpdated ? lastUpdated >= cutoff : true; // include if no date info
      });
      if (sensor) { location = loc; pm25Sensor = sensor; break; }
    }

    if (!location || !pm25Sensor) {
      return json(
        { error: 'No active PM2.5 sensor found at nearby stations' },
        404, corsHeaders
      );
    }

    // ── Step 2: Latest measurement ──
    // Note: sort=desc is unreliable on this endpoint — fetch a recent window
    // and pick the newest result client-side instead.
    const now = new Date();
    const recent48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const latestUrl =
      `https://api.openaq.org/v3/sensors/${pm25Sensor.id}/measurements` +
      `?datetime_from=${recent48h.toISOString()}` +
      `&datetime_to=${now.toISOString()}` +
      `&limit=50`;

    const latestResp = await fetch(latestUrl, { headers });
    let currentValue = null;
    let lastUpdated = null;

    if (latestResp.ok) {
      const d = await latestResp.json();
      if (d.results?.length) {
        // Pick the result with the most recent period end time
        const latest = d.results.reduce((best, r) => {
          const t = r.period?.datetimeTo?.utc ?? r.period?.datetimeFrom?.utc ?? '';
          const bestT = best.period?.datetimeTo?.utc ?? best.period?.datetimeFrom?.utc ?? '';
          return t > bestT ? r : best;
        });
        currentValue = latest.value;
        lastUpdated = latest.period?.datetimeTo?.utc ?? latest.period?.datetimeFrom?.utc ?? null;
      }
    }

    // ── Step 3: 24-hour rolling average ──
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const avgUrl =
      `https://api.openaq.org/v3/sensors/${pm25Sensor.id}/measurements` +
      `?datetime_from=${yesterday.toISOString()}` +
      `&datetime_to=${now.toISOString()}` +
      `&limit=200` +
      `&order_by=datetime&sort=desc`;

    const avgResp = await fetch(avgUrl, { headers });
    let avg24h = null;
    let measurementCount = 0;

    if (avgResp.ok) {
      const d = await avgResp.json();
      if (d.results?.length) {
        const vals = d.results
          .map(m => m.value)
          .filter(v => v !== null && v !== undefined && v >= 0);
        measurementCount = vals.length;
        if (vals.length > 0) {
          avg24h = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
        }
      }
    }

    // Fall back to current reading if no history
    if (avg24h === null && currentValue !== null) {
      avg24h = Math.round(currentValue * 10) / 10;
    }

    // ── Step 4: Annual average via /years endpoint ──
    const yearsUrl =
      `https://api.openaq.org/v3/sensors/${pm25Sensor.id}/years` +
      `?limit=50`;

    const yearsResp = await fetch(yearsUrl, { headers });
    let avgAnnual = null;

    let annualYear = null;

    if (yearsResp.ok) {
      const d = await yearsResp.json();
      if (d.results?.length) {
        // Sort descending by year as a safety net in case API ignores sort param
        d.results.sort((a, b) => {
          const yearA = new Date(a.period?.datetimeFrom?.utc ?? a.datetime?.from ?? 0).getFullYear();
          const yearB = new Date(b.period?.datetimeFrom?.utc ?? b.datetime?.from ?? 0).getFullYear();
          return yearB - yearA;
        });
        const r = d.results[0];
        const rawAvg = r.summary?.avg ?? r.value ?? null;
        if (rawAvg !== null) avgAnnual = Math.round(rawAvg * 10) / 10;
        const toStr = r.period?.datetimeTo?.utc ?? r.period?.datetimeFrom?.utc ?? null;
        if (toStr) annualYear = new Date(toStr).getFullYear();
      }
    }

    const roundedCurrent = currentValue !== null
      ? Math.round(currentValue * 10) / 10
      : null;

    return json({
      location: {
        id: location.id,
        name: location.name ?? 'Unknown Station',
        locality: location.locality ?? null,
        country: location.country?.name ?? location.country?.code ?? null,
        coordinates: location.coordinates,
        distanceMeters: Math.round(location.distance ?? 0),
        owner: location.owner?.name ?? null,
        provider: location.provider?.name ?? null,
      },
      sensorId: pm25Sensor.id,
      current: {
        value: roundedCurrent,
        unit: pm25Sensor.parameter?.units ?? 'µg/m³',
        lastUpdated,
      },
      avg24h,
      avgAnnual,
      annualYear,
      measurementCount,
      serverTimestamp: now.toISOString(),
    }, 200, corsHeaders);

  } catch (err) {
    console.error('AQ worker error:', err.stack ?? err.message);
    return json({ error: err.message ?? 'Internal server error' }, 500, corsHeaders);
  }
}

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
