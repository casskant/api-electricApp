import fetch from "node-fetch";
import * as turf from "@turf/turf";

const IRVE_URL = "https://odre.opendatasoft.com/api/records/1.0/search/";

export async function findChargingStations({ routeLine, distanceKm, autonomieKm, bufferKm = 20 }) {
  console.log("🚗 Recherche des bornes sur le trajet");

  // 1️⃣ Créer un buffer autour de la route pour récupérer les bornes proches
  const buffer = turf.buffer(routeLine, bufferKm, { units: "kilometers" });
  const ring = buffer.geometry.coordinates[0];
  const simplified = ring.slice(0, 50);
  simplified.push(simplified[0]);
  const polygonWKT = `POLYGON((${simplified.map(([lng, lat]) => `${lng} ${lat}`).join(",")}))`;

  // 2️⃣ Requête API IRVE
  const res = await fetch(
    `${IRVE_URL}?dataset=bornes-irve&geofilter=${encodeURIComponent(polygonWKT)}&rows=500`
  );
  const data = await res.json();

  console.log(`🔹 ${data.records.length} bornes récupérées depuis l'API`);

  if (!data.records || data.records.length === 0) {
    console.warn("⚠️ Aucune borne récupérée !");
    return { nbStops: 0, stations: [] };
  }

  // 3️⃣ Projeter toutes les bornes sur la route
  const withPosition = data.records
    .map((r, i) => {
      const p = r.fields?.geo_point_borne;
      if (!p) return null;
      const [lat, lng] = p;
      const point = turf.point([lng, lat]);
      const nearest = turf.nearestPointOnLine(routeLine, point, { units: "kilometers" });
      return {
        id: r.recordid || `borne-${i}`,
        lat,
        lng,
        enseigne: r.fields.n_enseigne || r.fields.n_amenageur || "Public",
        puissance: parseFloat(r.fields.puiss_max) || 0,
        distanceAlongRouteKm: nearest.properties.location
      };
    })
    .filter(b => b !== null)
    .sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);

  // 4️⃣ Sélection **simple et garantie** : on prend une borne tous les X km selon l’autonomie
  const selected = [];
  let lastStopKm = 0;

  for (const b of withPosition) {
    if (b.distanceAlongRouteKm - lastStopKm >= autonomieKm || selected.length === 0) {
      selected.push({ ...b, rechargeNum: selected.length + 1 });
      lastStopKm = b.distanceAlongRouteKm;
    }
  }

  console.log(`⚡ Bornes sélectionnées :`);
  selected.forEach(b =>
    console.log(`#${b.rechargeNum} - ${b.enseigne} (${b.puissance}kW) à ${b.distanceAlongRouteKm.toFixed(1)} km`)
  );

  return { nbStops: selected.length, stations: selected };
}
