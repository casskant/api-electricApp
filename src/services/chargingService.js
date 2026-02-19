import fetch from "node-fetch";
import * as turf from "@turf/turf";

export async function findChargingStations({
  routeLine,
  distanceKm,
  autonomieKm,
  bufferKm = 20
}) {
  // 1. Créer un buffer autour de la route
  const buffer = turf.buffer(routeLine, bufferKm, { units: "kilometers" });
  const ring = buffer.geometry.coordinates[0];
  const simplified = ring.slice(0, 50);
  simplified.push(simplified[0]);

  const polygonWKT = `POLYGON((${simplified
    .map(([lng, lat]) => `${lng} ${lat}`)
    .join(",")}))`;

  // 2. Requête API IRVE (dataset officiel des bornes françaises)
  const res = await fetch(
    `https://odre.opendatasoft.com/api/records/1.0/search/?dataset=bornes-irve&geofilter=${encodeURIComponent(polygonWKT)}&rows=500`
  );
  const data = await res.json();

  // 3. Normalisation + filtrage
  const candidates = (data.records || [])
    .map((r, i) => {
      const p = r.fields?.geo_point_borne;
      if (!p) return null;
      const [lat, lng] = p;

      const distanceToRouteKm = turf.pointToLineDistance(
        [lng, lat],
        routeLine,
        { units: "kilometers" }
      );

      return {
        id: r.recordid || `borne-${i}`,
        lat,
        lng,
        puissance: Number(r.fields.puiss_max) || 3,
        enseigne: r.fields.n_enseigne || r.fields.n_amenageur || "Public",
        distanceToRouteKm
      };
    })
    .filter(b => b && b.distanceToRouteKm <= bufferKm && b.puissance >= 3);

  // 4. Projection sur la route pour connaître la position de chaque borne
  const withPosition = candidates
    .map(b => {
      const nearest = turf.nearestPointOnLine(routeLine, [b.lng, b.lat], {
        units: "kilometers"
      });
      return { ...b, distanceAlongRouteKm: nearest.properties.location };
    })
    .sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);

  // 5. Sélection des arrêts nécessaires
  const rechargesNeeded = Math.max(0, Math.ceil(distanceKm / autonomieKm) - 1);
  const selected = [];
  let lastStopKm = 0;

  for (const b of withPosition) {
    if (
      b.distanceAlongRouteKm - lastStopKm >= autonomieKm * 0.8 &&
      selected.length < rechargesNeeded
    ) {
      selected.push({ ...b, rechargeNum: selected.length + 1 });
      lastStopKm = b.distanceAlongRouteKm;
    }
  }
  console.log("buffer type:", buffer.geometry.type);
  console.log("records reçus:", data.records?.length);
  console.log("candidates après filtre:", candidates.length);
  return selected;
}
