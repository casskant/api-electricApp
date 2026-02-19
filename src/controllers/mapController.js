import axios from "axios";
import fetch from "node-fetch";
import * as turf from "@turf/turf";
import "dotenv/config"

import { callTrajetSoap } from "../services/soapService.js";
import { findChargingStations } from "../services/chargingService.js";

/* =========================
   UTILITY: POLYLINE DECODER
========================= */

function decodePolyline(encoded, precision = 6) {
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
  console.log(`[geocodeCity] Recherche de la ville : ${city}`);
  
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

  const location = {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon)
  };

  console.log(`[geocodeCity] Coordonnées trouvées pour ${city}:`, location);
  return location;
}

/* =========================
   UTILITY: ERROR HANDLER
========================= */

function handleError(res, error, context = "") {
  console.error(`ERREUR [${context}] :`, error);
  res.status(500).json({
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

    console.log("[mapController] Requête reçue :", req.body);

    if (!startCity || !endCity) {
      console.warn("[mapController] Villes manquantes dans la requête");
      return res.status(400).json({
        success: false,
        context: "validation",
        message: "Villes de départ et d’arrivée requises"
      });
    }

    /* ========= 1. GEOCODAGE ========= */
    console.log("[mapController] Début du géocodage...");

    let start, end;
    try {
      [start, end] = await Promise.all([
        geocodeCity(startCity.trim()),
        geocodeCity(endCity.trim())
      ]);
    } catch (err) {
      return handleError(res, err, "geocodeCity");
    }

    /* ========= 2. ROUTE ========= */
    console.log("[mapController] Calcul de la route entre villes...");

    let routeCoords, routeLine, distanceKm;
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
          timeout: 10000
        }
      );

      console.log("[mapController] Polyline reçue :", routeRes.data.polyline);

      routeCoords = decodePolyline(routeRes.data.polyline);
      routeLine = turf.lineString(
        routeCoords.map(([lat, lng]) => [lng, lat])
      );
      distanceKm = turf.length(routeLine, { units: "kilometers" });

      console.log(`[mapController] Distance calculée : ${distanceKm.toFixed(2)} km`);

    } catch (err) {
      return handleError(res, err, "routeCalculation");
    }

    /* ========= 3. TEMPS TRAJET (APPEL SOAP) ========= */
    console.log("[mapController] Appel du service SOAP pour le temps de trajet...");

    let travelTimeHours;
    try {
      travelTimeHours = await callTrajetSoap({
        distanceKm,
        vitesseMoyKmH: Number(vitesseMoyKmH),
        autonomieKm: Number(autonomieKm),
        tempsRechargeH: Number(tempsRechargeH)
      });

      console.log(`[mapController] Temps de trajet estimé : ${travelTimeHours.toFixed(2)} h`);
    } catch (err) {
      return handleError(res, err, "callTrajetSoap");
    }

    /* ========= 4. BORNES ÉLECTRIQUES ========= */
    console.log("[mapController] Recherche des bornes de recharge sur le trajet...");

    let bornes = [];
    try {
      bornes = await findChargingStations({
        routeLine,
        distanceKm,
        autonomieKm: Number(autonomieKm)
      });

      console.log(`[mapController] Bornes trouvées : ${bornes.length}`);
    } catch (err) {
      console.warn("findChargingStations a échoué :", err.message);
      bornes = []; 
    }

    /* ========= REPONSE FORMAT JSON ========= */
    console.log("[mapController] Préparation de la réponse JSON...");

    res.json({
      success: true,
      startCity: startCity.trim(),
      endCity: endCity.trim(),
      start,
      end,
      distanceKm: Math.round(distanceKm),
      travelTimeHours,
      routeCoords,
      bornes,
      summary: {
        distanceKm: Math.round(distanceKm),
        tempsHeures: Number(travelTimeHours.toFixed(1)),
        nbRecharges: bornes.length
      }
    });

    console.log("[mapController] Réponse envoyée avec succès !");
  } catch (err) {
    return handleError(res, err, "mapController");
  }
}
