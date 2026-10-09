// Cloudflare Pages Function: /api/geocode?address=...
// Proxies the US Census Bureau geocoder (authoritative TIGER address data —
// the best source for rural US addresses), which blocks direct browser
// requests via CORS. Free, no API key.
export async function onRequestGet({ request }) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address || address.trim().length < 3) {
    return Response.json({ error: "address query parameter required" }, { status: 400 });
  }

  const census =
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
    `?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;

  try {
    const res = await fetch(census, { headers: { "User-Agent": "uppervalleylandclearing.com" } });
    const json = await res.json();
    const m = json?.result?.addressMatches?.[0];
    if (!m) return Response.json({ match: null });
    return Response.json({
      match: { lat: m.coordinates.y, lng: m.coordinates.x, label: m.matchedAddress },
    });
  } catch {
    return Response.json({ match: null });
  }
}
