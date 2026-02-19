import fetch from "node-fetch";
import * as turf from "@turf/turf";

console.log("🚗 Charging service started");

const IRVE_URL = "https://odre.opendatasoft.com/api/records/1.0/search/";

/**
 * Recherche de bornes de recharge le long d'un trajet
 * @param {Object} options
 * @param {Object} options.routeLine - GeoJSON LineString représentant l'itinéraire
 * @param {number} options.distanceKm - Distance totale du trajet (km)
 * @param {number} options.autonomieKm - Autonomie du véhicule (km)
 * @param {number} options.bufferKm - Rayon de recherche autour de la route (km)
 * @returns {Array} bornes sélectionnées pour le trajet
 */
export async function findChargingStations({
  routeLine,
  distanceKm,
  autonomieKm,
  bufferKm = 20
}) {
  console.log("📍 Étape 1 : Création du buffer autour de la route");

  // Création d'un buffer autour de la route
  const buffer = turf.buffer(routeLine, bufferKm, { units: "kilometers" });
  const ring = buffer.geometry.coordinates[0];
  if (ring.length < 3) {
    console.warn("⚠️ Polygone invalide, aucune borne trouvée");
    return [];
  }

  const simplified = ring.slice(0, 50);
  simplified.push(simplified[0]);

  const polygonWKT = `POLYGON((${simplified.map(([lng, lat]) => `${lng} ${lat}`).join(",")}))`;
  console.log("🔹 WKT du polygone :", polygonWKT);

  // 2️⃣ Requête vers l'API IRVE
  console.log("📡 Étape 2 : Requête vers l'API IRVE");
  const res = await fetch(
    `${IRVE_URL}?dataset=bornes-irve&geofilter=${encodeURIComponent(polygonWKT)}&rows=500`
  );
  const data = await res.json();
  console.log(`🔹 ${data.records.length} bornes récupérées depuis l'API`);

  // 3️⃣ Normalisation des bornes
  const candidates = (data.records || [])
    .map((r, i) => {
      const p = r.fields?.geo_point_borne;
      if (!p) return null;

      const [lat, lng] = p; // IRVE renvoie [lat, lng]
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

  console.log(`🔹 ${candidates.length} bornes après filtrage distance/power`);

  // 4️⃣ Projection sur la ligne pour connaître la position le long du trajet
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

  // Tri par position le long du trajet
  withPosition.sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);

  console.log("📌 Bornes triées le long du trajet :");
  withPosition.forEach(b => {
    console.log(
      `- ${b.enseigne} (${b.puissance}kW) à ${b.distanceAlongRouteKm.toFixed(
        1
      )} km du départ`
    );
  });

  // 5️⃣ Sélection des bornes nécessaires en fonction de l'autonomie
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

  console.log(`⚡ Bornes sélectionnées pour le trajet (${selected.length}) :`);
  selected.forEach(b =>
    console.log(
      `#${b.rechargeNum} - ${b.enseigne} (${b.puissance}kW) à ${b.distanceAlongRouteKm.toFixed(
        1
      )} km`
    )
  );

  return selected;
}
