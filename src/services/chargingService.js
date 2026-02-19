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

  // 1️⃣ Créer un buffer autour de la route pour trouver les bornes proches
  const buffer = turf.buffer(routeLine, bufferKm, { units: "kilometers" });

  // Simplifier le polygone pour WKT
  const ring = buffer.geometry.coordinates[0];
  if (ring.length < 3) {
    console.warn("⚠️ Polygone de buffer invalide, aucune borne trouvée");
    return { nbStops: 0, stations: [] };
  }
  const simplified = ring.slice(0, 50);
  simplified.push(simplified[0]);

  // WKT format (lng lat)
  const polygonWKT = `POLYGON((${simplified.map(([lng, lat]) => `${lng} ${lat}`).join(",")}))`;

  // 2️⃣ Requête vers l'API IRVE
  const res = await fetch(
    `${IRVE_URL}?dataset=bornes-irve&geofilter=${encodeURIComponent(polygonWKT)}&rows=500`
  );
  const data = await res.json();

  console.log(`🔹 ${data.records.length} bornes récupérées depuis l'API`);

  // 3️⃣ Normaliser les bornes et calculer distance à la ligne
  const candidates = (data.records || [])
    .map((r, i) => {
      const p = r.fields?.geo_point_borne;
      if (!p) return null;
      const [lat, lng] = p;
      const point = turf.point([lng, lat]);
      const distanceToRouteKm = turf.pointToLineDistance(point, routeLine, { units: "kilometers" });

      return {
        id: r.recordid || `borne-${i}`,
        lat,
        lng,
        enseigne: r.fields.n_enseigne || r.fields.n_amenageur || "Public",
        puissance: parseFloat(r.fields.puiss_max) || 3,
        distanceToRouteKm,
        point
      };
    })
    .filter(b => b !== null);

  console.log(`🔹 ${candidates.length} bornes après normalisation`);

  // 4️⃣ Projection sur la ligne pour connaître la position le long du trajet
  const withPosition = candidates.map(b => {
    const nearest = turf.nearestPointOnLine(routeLine, b.point, { units: "kilometers" });
    return {
      ...b,
      distanceAlongRouteKm: nearest.properties.location
    };
  });

  // 5️⃣ Tri par distance le long du trajet
  withPosition.sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);

  // 6️⃣ Calcul du nombre d'arrêts nécessaires et sélection
  const nbStops = Math.max(0, Math.ceil(distanceKm / autonomieKm) - 1);
  const selected = [];
  let lastStopKm = 0;

  for (const b of withPosition) {
    // Ajouter borne si on a parcouru au moins 80% de l'autonomie depuis le dernier arrêt
    if (b.distanceAlongRouteKm - lastStopKm >= autonomieKm * 0.8 && selected.length < nbStops) {
      selected.push({ ...b, rechargeNum: selected.length + 1 });
      lastStopKm = b.distanceAlongRouteKm;
    }
  }

  console.log(`⚡ Nombre d'arrêts nécessaires : ${nbStops}`);
  console.log(`🔹 Bornes sélectionnées :`);
  selected.forEach(b =>
    console.log(
      `#${b.rechargeNum} - ${b.enseigne} (${b.puissance}kW) à ${b.distanceAlongRouteKm.toFixed(1)} km`
    )
  );

  return { nbStops, stations: selected };
}
