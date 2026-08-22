import { publicGet } from "./src/http-client.js";
async function main() {
  const resp = await publicGet("/public/products", null);
  const products = (resp.data?.perpProductsV2 ?? []);
  const p = products.find(x => x.symbol === "BTCUSDT");
  console.log(JSON.stringify(Object.keys(p), null, 2));
  console.log("---");
  console.log("maxLeverage:", p?.maxLeverage);
  console.log("maxPositionValue:", p?.maxPositionValue);
  console.log("initialMargin:", p?.initialMargin);
  console.log("maintenanceMargin:", p?.maintenanceMargin);
}
main();
