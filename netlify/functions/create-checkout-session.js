// Creates a Stripe Checkout Session using Stripe's REST API (no external deps).
//
// Required env vars on Netlify:
//   STRIPE_SECRET_KEY = sk_live_...
//
// Pricing:
//   Tiered pricing is the default behavior (matches the site pricing table).
//
//   - ENABLE_TIERED_PRICING (optional)
//       Defaults to enabled. Set to "0" / "false" / "no" / "off" to disable and use legacy fixed pricing.
//
//   - STRIPE_TIERED_PRICE_IDS (optional)
//       JSON map of Stripe Price IDs to use instead of inline amounts.
//       Example:
//         {
//           "tier_a": { "brief_remote": "price_...", "command_remote": "price_..." },
//           "tier_b": { "brief_remote": "price_...", "command_remote": "price_..." }
//         }
//
// Legacy fixed pricing (only used when tiered pricing is disabled):
//   - STRIPE_PRICE_ID = price_...
//   - or inline price:
//       UNIT_AMOUNT (cents), CURRENCY=usd, PRODUCT_NAME, PRODUCT_DESCRIPTION
//
// Optional:
//   CHECKOUT_MODE = payment (default)

function getOrigin(headers){
  const o = headers.origin;
  if (o) return o;
  const ref = headers.referer || headers.referrer;
  if (!ref) return null;
  try { return new URL(ref).origin; } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID || "";
  const mode = process.env.CHECKOUT_MODE || "payment";
  const enableTiered = !/^(0|false|no|off)$/i.test(String(process.env.ENABLE_TIERED_PRICING || ""));

  if (!secret) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing STRIPE_SECRET_KEY in environment variables." }) };
  }

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch {}

  const rid = String(payload.rid || "").trim();
  const email = String(payload.email || "").trim();
  const serviceLevel = String(payload.service_level || payload.serviceLevel || "").trim();
  const vehicleTier = String(payload.vehicle_tier || payload.vehicleTier || "").trim();
  const origin = getOrigin(event.headers) || process.env.URL || process.env.DEPLOY_PRIME_URL;

  if (!origin) {
    return { statusCode: 400, body: JSON.stringify({ error: "Could not determine site origin." }) };
  }
  if (!rid || !/^VV-\d{4}-\d{5}$/.test(rid)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid or missing Request ID." }) };
  }

  // Tiered pricing map (cents, USD). Enabled only when ENABLE_TIERED_PRICING is truthy.
  const PRICING_CENTS = {
    tier_a: {
      brief_remote: 12900,
      command_remote: 24900,
      verify_ppi_inperson: 29900,
      confirm_diag_inperson: 17900
    },
    tier_b: {
      brief_remote: 16900,
      command_remote: 32900,
      verify_ppi_inperson: 39900,
      confirm_diag_inperson: 22900
    }
  };

  const SERVICE_NAMES = {
    brief_remote: "VINvoyant Brief (Remote)",
    command_remote: "VINvoyant Command (Remote)",
    verify_ppi_inperson: "VINvoyant Verify (Mobile PPI)",
    confirm_diag_inperson: "VINvoyant Confirm (Diag + Quote)"
  };

  const params = new URLSearchParams();
  params.append("mode", mode);
  params.append("success_url", `${origin}/paid.html?session_id={CHECKOUT_SESSION_ID}&rid=${encodeURIComponent(rid)}`);
  params.append("cancel_url", `${origin}/#start?canceled=1&rid=${encodeURIComponent(rid)}`);
  params.append("metadata[rid]", rid);
  if (serviceLevel) params.append("metadata[service_level]", serviceLevel);
  if (vehicleTier) params.append("metadata[vehicle_tier]", vehicleTier);
  params.append("client_reference_id", rid);
  if (email) params.append("customer_email", email);

  if (enableTiered) {
    const tierKey = vehicleTier;
    const serviceKey = serviceLevel;
    const unitAmount = PRICING_CENTS[tierKey]?.[serviceKey];
    if (!tierKey || !serviceKey) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing service/tier selection for tiered pricing." }) };
    }

    let tieredPriceIds = null;
    try {
      const raw = String(process.env.STRIPE_TIERED_PRICE_IDS || "").trim();
      if (raw) tieredPriceIds = JSON.parse(raw);
    } catch {
      tieredPriceIds = null;
    }

    const mappedPriceId = tieredPriceIds?.[tierKey]?.[serviceKey];
    if (typeof mappedPriceId === "string" && /^price_/.test(mappedPriceId)) {
      params.append("line_items[0][price]", mappedPriceId);
      params.append("line_items[0][quantity]", "1");
    } else if (unitAmount) {
      params.append("line_items[0][price_data][currency]", "usd");
      params.append("line_items[0][price_data][unit_amount]", String(unitAmount));
      params.append("line_items[0][price_data][product_data][name]", SERVICE_NAMES[serviceKey] || "VINvoyant Service");
      params.append(
        "line_items[0][price_data][product_data][description]",
        `${vehicleTier === "tier_b" ? "Tier B — European/Exotic" : "Tier A — Import/Domestic"} • Request ID ${rid}`
      );
      params.append("line_items[0][quantity]", "1");
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid or missing service/tier selection for tiered pricing." }) };
    }
  } else if (priceId){
    // PRICE MODE
    params.append("line_items[0][price]", priceId);
    params.append("line_items[0][quantity]", "1");
  } else {
    // INLINE PRICE MODE (no Stripe product setup)
    const unitAmount = parseInt(process.env.UNIT_AMOUNT || "12900", 10);
    const currency = (process.env.CURRENCY || "usd").toLowerCase();
    const pname = process.env.PRODUCT_NAME || "VINvoyant Brief (Legacy)";
    const pdesc = process.env.PRODUCT_DESCRIPTION || "Legacy fixed-price checkout (tiered pricing disabled)";

    if (!Number.isFinite(unitAmount) || unitAmount < 50){
      return { statusCode: 500, body: JSON.stringify({ error: "Invalid UNIT_AMOUNT env var (must be cents, e.g. 12900)." }) };
    }

    params.append("line_items[0][price_data][currency]", currency);
    params.append("line_items[0][price_data][unit_amount]", String(unitAmount));
    params.append("line_items[0][price_data][product_data][name]", pname);
    params.append("line_items[0][price_data][product_data][description]", pdesc);
    params.append("line_items[0][quantity]", "1");
  }

  try{
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.error?.message || "Stripe error", details: data }) };
    }

    return { statusCode: 200, body: JSON.stringify({ url: data.url, sessionId: data.id }) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ error: "Server error creating session." }) };
  }
};
