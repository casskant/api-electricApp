import fetch from "node-fetch";
import * as turf from "@turf/turf";

const IRVE_URL = "https://odre.opendatasoft.com/api/records/1.0/search/";

/**
 * Trouve les bornes électriques nécessaires pour un trajet
 * @param {Object} routeLine - GeoJSON LineString du trajet
 * @param {number} distanceKm - Distance totale du trajet (km)
 * @param {number} autonomieKm - Autonomie du véhicule (km)
 * @param {number} bufferKm - Distance autour de la ligne pour chercher les bornes
 * @returns {Object} { nbStops: number, stations: Array }
 */
export async function findChargingStations({ routeLine, distanceKm, autonomieKm, bufferKm = 20 }) {
  console.log("🚗 Recherche des bornes sur le trajet");

  // 1️⃣ Créer un buffer autour de la route
  const buffer = turf.buffer(routeLine, bufferKm, { units: "kilometers" });

  // Simplifier le polygone pour WKT
  const ring = buffer.geometry.coordinates[0];
  if (ring.length < 3) return { nbStops: 0, stations: [] };

  const simplified = ring.slice(0, 50);
  simplified.push(simplified[0]);
  const polygonWKT = `POLYGON((${simplified.map(([lng, lat]) => `${lng} ${lat}`).join(",")}))`;

  // 2️⃣ Requête API IRVE
  const res = await fetch(
    `${IRVE_URL}?dataset=bornes-irve&geofilter=${encodeURIComponent(polygonWKT)}&rows=500`
  );
  const data = await res.json();

  console.log(`🔹 ${data.records.length} bornes récupérées depuis l'API`);

  // 3️⃣ Projeter toutes les bornes sur la route, sans filtrage
  const withPosition = (data.records || [])
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

  // 4️⃣ Calcul du nombre d'arrêts nécessaires et sélection
 const nbStops = Math.max(0, Math.ceil(distanceKm / autonomieKm) - 1);
  const selected = [];
  let lastStopKm = 0;
  
  for (const b of withPosition) {
    if (selected.length === 0) {
      // Premier arrêt : on prend la première borne sur la route
      selected.push({ ...b, rechargeNum: 1 });
      lastStopKm = b.distanceAlongRouteKm;
    } else if (b.distanceAlongRouteKm - lastStopKm >= autonomieKm * 0.8 && selected.length < nbStops) {
      selected.push({ ...b, rechargeNum: selected.length + 1 });
      lastStopKm = b.distanceAlongRouteKm;
    }
  
    // Stop si on a déjà assez de bornes
    if (selected.length >= nbStops) break;
  }

  console.log(`⚡ Nombre d'arrêts nécessaires : ${nbStops}`);
  console.log(`🔹 Bornes sélectionnées :`);
  selected.forEach(b =>
    console.log(`#${b.rechargeNum} - ${b.enseigne} (${b.puissance}kW) à ${b.distanceAlongRouteKm.toFixed(1)} km`)
  );

  return { nbStops, stations: selected };
}
