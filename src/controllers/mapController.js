import axios from "axios";
import fetch from "node-fetch";
import * as turf from "@turf/turf";
import "dotenv/config";

import { callTrajetSoap } from "../services/soapService.js";
import { findChargingStations } from "../services/chargingService.js";

/* =========================
   UTILITY: POLYLINE DECODER
========================= */
function decodePolyline(encoded, precision = 5) {
  if (!encoded) return [];

  let index = 0, lat = 0, lng = 0;
  const coords = [];
  const factor = 10 ** precision;

  while (index < encoded.length) {
    let result = 0, shift = 0, b;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    lat += (result & 1) ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    lng += (result & 1) ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lng / factor]);
  }

  return coords;
}

/* =========================
   UTILITY: GEOCODING
========================= */
async function geocodeCity(city) {
  const params = new URLSearchParams({
    q: `${city} France`,
    format: "json",
    limit: 1,
    countrycodes: "fr"
  });

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { headers: { "User-Agent": "ElectricApp/1.0" } }
  );

  const data = await res.json();
  if (!data?.[0]) throw new Error(`Ville introuvable : ${city}`);

  return {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon)
  };
}

/* =========================
   UTILITY: ERROR HANDLER
========================= */
function handleError(res, error, context = "") {
  console.error(`ERREUR [${context}] :`, error);
  return res.status(500).json({
    success: false,
    context,
    message: error.message || String(error),
    stack: error.stack || null
  });
}

/* =========================
   MAP CONTROLLER
========================= */
export async function mapController(req, res) {
  try {
    const {
      startCity,
      endCity,
      vitesseMoyKmH = 110,
      autonomieKm = 350,
      tempsRechargeH = 0.5
    } = req.body;

    console.log("mapController: nouvelle requête", { startCity, endCity, vitesseMoyKmH, autonomieKm, tempsRechargeH });

    // Validation des villes
    if (!startCity || !endCity) {
      console.warn("mapController: villes manquantes");
      return res.status(400).json({
        success: false,
        context: "validation",
        message: "Villes de départ et d’arrivée requises"
      });
    }

    // Validation des paramètres numériques
    const vitesse = Number(vitesseMoyKmH);
    const autonomie = Number(autonomieKm);
    const recharge = Number(tempsRechargeH);

    if (![vitesse, autonomie, recharge].every(Number.isFinite)) {
      console.warn("mapController: paramètres invalides", { vitesse, autonomie, recharge });
      return res.status(400).json({
        success: false,
        context: "validation",
        message: "Paramètres invalides pour le calcul du trajet"
      });
    }

    /* ========= 1. GEOCODAGE ========= */
    let start, end;
    try {
      [start, end] = await Promise.all([
        geocodeCity(startCity.trim()),
        geocodeCity(endCity.trim())
      ]);
      console.log("mapController: géocodage réussi", { start, end });
    } catch (err) {
      return handleError(res, err, "geocodeCity");
    }

    /* ========= 2. ROUTE ========= */
    let routeCoords = [], routeLine, distanceKm = 0;
    try {
      const routeRes = await axios.get(
        "https://maps.open-street.com/api/route/",
        {
          params: {
            origin: `${start.lat},${start.lng}`,
            destination: `${end.lat},${end.lng}`,
            mode: "driving",
            key: process.env.KEY_OPEN_STREET
          },
          timeout: 15000
        }
      );

      routeCoords = decodePolyline(routeRes.data.polyline);
      routeLine = turf.lineString(routeCoords.map(([lat, lng]) => [lng, lat]));
      distanceKm = turf.length(routeLine, { units: "kilometers" });

      console.log("mapController: route calculée", { distanceKm, nbPoints: routeCoords.length });
    } catch (err) {
      return handleError(res, err, "routeCalculation");
    }

    /* ========= 3. TEMPS TRAJET (APPEL SOAP) ========= */
    let travelTimeHours = null;
    try {
      travelTimeHours = await callTrajetSoap({
        distanceKm,
        vitesseMoyKmH: vitesse,
        autonomieKm: autonomie,
        tempsRechargeH: recharge
      });
      console.log("mapController: SOAP calculé", { travelTimeHours });
    } catch (err) {
      console.warn("mapController: SOAP échoué, fallback utilisé", err.message);
      travelTimeHours = distanceKm / vitesse + Math.ceil(distanceKm / autonomie) * recharge;
      console.log("mapController: fallback travelTimeHours", { travelTimeHours });
    }

    /* ========= 4. BORNES ÉLECTRIQUES ========= */
    let bornes = [];
    try {
      bornes = await findChargingStations({
        routeLine,
        distanceKm,
        autonomieKm: autonomie
      });
      console.log("mapController: bornes trouvées", { nbBornes: bornes.length });
    } catch (err) {
      console.warn("mapController: findChargingStations a échoué", err.message);
      bornes = [];
    }

    /* ========= 5. REPONSE JSON ========= */
    const response = {
      success: true,
      startCity: startCity.trim(),
      endCity: endCity.trim(),
      start,
      end,
      distanceKm: Math.round(distanceKm),
      travelTimeHours: travelTimeHours ? Number(travelTimeHours.toFixed(1)) : null,
      routeCoords,
      bornes,
      summary: {
        distanceKm: Math.round(distanceKm),
        tempsHeures: travelTimeHours ? Number(travelTimeHours.toFixed(1)) : null,
        nbRecharges: bornes.length
      }
    };

    console.log("mapController: réponse prête", response.summary);
    res.json(response);

  } catch (err) {
    return handleError(res, err, "mapController");
  }
}
