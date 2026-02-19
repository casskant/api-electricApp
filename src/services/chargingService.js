import fetch from "node-fetch";
import * as turf from "@turf/turf";

const IRVE_URL = "https://odre.opendatasoft.com/api/records/1.0/search/";

/**
 * Trouve les bornes électriques nécessaires pour un trajet
 * @param {Object} routeLine - GeoJSON LineString du trajet ([lng, lat])
 * @param {number} distanceKm - Distance totale du trajet (km)
 * @param {number} autonomieKm - Autonomie du véhicule (km)
 * @param {number} searchRadiusKm - Rayon autour du trajet pour chercher les bornes
 */
export async function findChargingStations({
  routeLine,
  distanceKm,
  autonomieKm,
  searchRadiusKm = 50
}) {
  console.log("🚗 Recherche des bornes sur le trajet...");

  // 1️⃣ Prendre le point de départ pour récupérer toutes les bornes proches
  const start = routeLine.coordinates[0]; // [lng, lat]
  const radiusMeters = searchRadiusKm * 1000;

  const res = await fetch(
    `${IRVE_URL}?dataset=bornes-irve&geofilter.distance=${start[1]},${start[0]},${radiusMeters}&rows=500`
  );
  const data = await res.json();
  console.log(`🔹 ${data.records.length} bornes récupérées depuis l'API`);

  if (!data.records || data.records.length === 0) {
    console.warn("⚠️ Aucune borne récupérée !");
    return { nbStops: 0, stations: [] };
  }

  // 2️⃣ Projeter toutes les bornes sur la route
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

  console.log(`🔹 ${withPosition.length} bornes projetées sur la route`);

  // 3️⃣ Sélection des arrêts en fonction de l'autonomie
  const selected = [];
  let lastStopKm = 0;

  for (const b of withPosition) {
    if (selected.length === 0 || b.distanceAlongRouteKm - lastStopKm >= autonomieKm) {
      selected.push({ ...b, rechargeNum: selected.length + 1 });
      lastStopKm = b.distanceAlongRouteKm;
    }
  }

  console.log(`⚡ Nombre d'arrêts nécessaires : ${selected.length}`);
  console.log("🔹 Bornes sélectionnées :");
  selected.forEach(b =>
    console.log(`#${b.rechargeNum} - ${b.enseigne} (${b.puissance}kW) à ${b.distanceAlongRouteKm.toFixed(1)} km`)
  );

  return { nbStops: selected.length, stations: selected };
}
