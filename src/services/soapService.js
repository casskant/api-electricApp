import "dotenv/config"

export async function callTrajetSoap({ distanceKm, vitesseMoyKmH, autonomieKm, tempsRechargeH }) {
  const WSDL_URL = process.env.SOAP_URL | "http://localhost:8000/trajet?wsdl";

  try {
      const client = await soap.createClientAsync(WSDL_URL);
      const args = { distanceKm, vitesseMoyKmH, autonomieKm, tempsRechargeH };
      const [result] = await client.calculTrajetAsync(args);
      const raw = result?.return;
      if (raw === undefined || raw === null) throw new Error("SOAP: valeur absente");

      const travelTime = Number(String(raw).replace(",", "."));
      if (!Number.isFinite(travelTime)) throw new Error("SOAP: valeur invalide");

      return travelTime;
  } catch (err) {
      const travelTime = distanceKm / vitesseMoyKmH + Math.ceil(distanceKm / autonomieKm) * tempsRechargeH;
      return travelTime;
  }
}
