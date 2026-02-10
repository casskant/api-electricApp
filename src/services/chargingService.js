import fetch from "node-fetch";
import * as turf from "@turf/turf";

const IRVE_URL =
  "https://odre.opendatasoft.com/api/records/1.0/search/";

// Recherche de bornes de recharge pertinentes le long d’un trajet
export async function findChargingStations({
  routeLine,    // LineString GeoJSON représentant l’itinéraire
  distanceKm,   // Distance totale du trajet (km)
  autonomieKm,  // Autonomie du véhicule (km)
  bufferKm = 20 // Rayon de recherche autour du trajet (km)
}) {

  // 1. Zone de recherche : buffer autour de la route
  // On crée un polygone englobant la route à bufferKm de part et d’autre.
  const buffer = turf.buffer(routeLine, bufferKm, {
    units: "kilometers"
  });

  // On suppose que le buffer est un simple Polygon et on prend son anneau externe.
  const ring = buffer.geometry.coordinates[0];

  // Pour limiter la taille de la requête WKT, on coupe brutalement à 50 points.
  // → C’est un compromis perf/précision : plus rapide, mais zone approximée.
  const simplified = ring.slice(0, 50);

  // On ferme explicitement le polygone pour qu’il soit géométriquement valide.
  simplified.push(simplified[0]);

  // Construction de la géométrie WKT (format attendu par l’API IRVE).
  // Attention : WKT attend (lng lat) et non (lat lng).
  const polygonWKT = `POLYGON((${simplified
    .map(([lng, lat]) => `${lng} ${lat}`)
    .join(",")}))`;

  // 2. Requête vers le dataset IRVE filtré par le polygone
  // rows=500 limite implicitement le nombre de bornes récupérées (pas de pagination ici).
  const res = await fetch(
    `${IRVE_URL}?dataset=bornes-irve&geofilter=${encodeURIComponent(
      polygonWKT
    )}&rows=500`
  );

  const data = await res.json();

  // 3. Normalisation des enregistrements + filtrage métier
  const candidates = (data.records || [])
    .map((r, i) => {
      const p = r.fields?.geo_point_borne;
      if (!p) return null; // On ignore les bornes sans position exploitable.

      const [lat, lng] = p; 

      // Distance minimale entre la borne et la ligne du trajet (km).
      const distanceToRouteKm =
        turf.pointToLineDistance(
          [lng, lat], 
          routeLine,
          { units: "kilometers" }
        );

      // On fabrique un modèle de borne homogène pour la suite de l’algo.
      return {
        id: r.recordid || `borne-${i}`,
        lat,
        lng,
        // Si la puissance est manquante ou invalide, on considère 3 kW par défaut.
        puissance: Number(r.fields.puiss_max) || 3,
        enseigne:
          r.fields.n_enseigne ||
          r.fields.n_amenageur ||
          "Public",
        distanceToRouteKm
      };
    })
    .filter(
      b =>
        b &&
        b.distanceToRouteKm <= bufferKm &&
        // On écarte les bornes très lentes / mal renseignées (< 3 kW) pour un trajet plus rapide.
        b.puissance >= 3
    );

  // 4. Projection des bornes sur le trajet pour connaître "où" on les croise
  const withPosition = candidates.map(b => {
    const nearest = turf.nearestPointOnLine(
      routeLine,
      [b.lng, b.lat],
      { units: "kilometers" }
    );

    return {
      ...b,
      // location = position le long de la ligne (même base que distanceKm/autonomieKm).
      distanceAlongRouteKm:
        nearest.properties.location
    };
  });

  
  withPosition.sort(
    (a, b) =>
      a.distanceAlongRouteKm -
      b.distanceAlongRouteKm
  );

  // 5. Stratégie de sélection des arrêts de recharge

  // Nombre de recharges nécessaires si on part à 100 % et qu’on recharge à 100 % à chaque fois.
  
  const rechargesNeeded = Math.max(
    0,
    Math.ceil(distanceKm / autonomieKm) - 1
  );

  const selected = [];
  let lastStopKm = 0; // Distance depuis le départ du trajet du dernier arrêt (0 = départ).

  for (const b of withPosition) {
    // Conditions pour choisir cette borne comme arrêt :
    // - On a parcouru au moins 80 % de l’autonomie depuis le dernier arrêt (marge de sécurité).
    // - On n’a pas déjà atteint le nombre de recharges théoriques.
    if (
      b.distanceAlongRouteKm - lastStopKm >= autonomieKm * 0.8 &&
      selected.length < rechargesNeeded
    ) {
      selected.push({
        ...b,
        // Numéro d’arrêt dans l’ordre du trajet.
        rechargeNum: selected.length + 1
      });
      lastStopKm = b.distanceAlongRouteKm;
    }
  }

  // Résultat : uniquement les bornes effectivement retenues comme stops.
  // À noter : la fonction ne signale pas les cas impossibles (trous > autonomieKm).
  return selected;
}
