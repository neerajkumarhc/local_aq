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

    // Pick first result that has a PM2.5 sensor
    let location = null;
    let pm25Sensor = null;
    for (const loc of locData.results) {
      const sensor = loc.sensors?.find(
        s => s.parameter?.name === 'pm25' || s.parameter?.name === 'PM2.5'
      );
      if (sensor) { location = loc; pm25Sensor = sensor; break; }
    }

    if (!location || !pm25Sensor) {
      return json(
        { error: 'No active PM2.5 sensor found at nearby stations' },
        404, corsHeaders
      );
    }

    // ── Step 2: Latest measurement ──
    const latestUrl =
      `https://api.openaq.org/v3/sensors/${pm25Sensor.id}/measurements` +
      `?limit=1&order_by=datetime&sort=desc`;

    const latestResp = await fetch(latestUrl, { headers });
    let currentValue = null;
    let lastUpdated = null;

    if (latestResp.ok) {
      const d = await latestResp.json();
      if (d.results?.length) {
        currentValue = d.results[0].value;
        lastUpdated = d.results[0].datetime?.to ?? d.results[0].datetime?.from ?? null;
      }
    }

    // ── Step 3: 24-hour rolling average ──
    const now = new Date();
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
      current: {
        value: roundedCurrent,
        unit: pm25Sensor.parameter?.units ?? 'µg/m³',
        lastUpdated,
      },
      avg24h,
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
