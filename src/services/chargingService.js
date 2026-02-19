import fetch from "node-fetch";
import * as turf from "@turf/turf";

console.log("charging service");

const IRVE_URL = "https://odre.opendatasoft.com/api/records/1.0/search/";

export async function findChargingStations({
  routeLine,    // LineString GeoJSON
  distanceKm,
  autonomieKm,
  bufferKm = 20
}) {
  // 1. Création du buffer autour de la route
  const buffer = turf.buffer(routeLine, bufferKm, { units: "kilometers" });
  const ring = buffer.geometry.coordinates[0];
  if (ring.length < 3) return []; // polygone invalide
  const simplified = ring.slice(0, 50);
  simplified.push(simplified[0]);

  const polygonWKT = `POLYGON((${simplified.map(([lng, lat]) => `${lng} ${lat}`).join(",")}))`;

  // 2. Requête IRVE
  const res = await fetch(
    `${IRVE_URL}?dataset=bornes-irve&geofilter=${encodeURIComponent(polygonWKT)}&rows=500`
  );
  const data = await res.json();

  // 3. Normalisation
  const candidates = (data.records || [])
    .map((r, i) => {
      const p = r.fields?.geo_point_borne;
      if (!p) return null;
      const [lat, lng] = p;

      const distanceToRouteKm = turf.pointToLineDistance(
        turf.point([lng, lat]),
        routeLine,
        { units: "kilometers" }
      );

      const puissance = parseFloat(r.fields.puiss_max) || 3;

      return {
        id: r.recordid || `borne-${i}`,
        lat,
        lng,
        puissance,
        enseigne: r.fields.n_enseigne || r.fields.n_amenageur || "Public",
        distanceToRouteKm
      };
    })
    .filter(b => b && b.distanceToRouteKm <= bufferKm && b.puissance >= 3);

  // 4. Projection sur la ligne
  const withPosition = candidates.map(b => {
    const nearest = turf.nearestPointOnLine(
      routeLine,
      turf.point([b.lng, b.lat]),
      { units: "kilometers" }
    );
    return {
      ...b,
      distanceAlongRouteKm: nearest.properties.location
    };
  });

  withPosition.sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);

  // 5. Sélection des bornes
  const rechargesNeeded = Math.max(0, Math.ceil(distanceKm / autonomieKm) - 1);
  const selected = [];
  let lastStopKm = 0;

  for (const b of withPosition) {
    if (b.distanceAlongRouteKm - lastStopKm >= autonomieKm * 0.8 && selected.length < rechargesNeeded) {
      selected.push({ ...b, rechargeNum: selected.length + 1 });
      lastStopKm = b.distanceAlongRouteKm;
    }
  }

  return selected;
}
