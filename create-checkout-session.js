// netlify/functions/create-checkout-session.js
// Creates a Stripe Checkout Session using Stripe's REST API (no external deps).
//
// Required env vars on Netlify:
//   STRIPE_SECRET_KEY = sk_live_...
//
// Optional (choose ONE pricing mode):
//   A) PRICE MODE (recommended if you already have a Stripe Price)
//      STRIPE_PRICE_ID = price_...
//
//   B) INLINE PRICE MODE (zero Stripe product setup)
//      UNIT_AMOUNT = 9900      (in cents; e.g. 9900 = $99.00)
//      CURRENCY    = usd
//      PRODUCT_NAME = "VINvoyant Intake"
//      PRODUCT_DESCRIPTION = "Concierge Vehicle Intelligence Intake"
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

  if (!secret) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing STRIPE_SECRET_KEY in environment variables." }) };
  }

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch {}

  const rid = String(payload.rid || "").trim();
  const email = String(payload.email || "").trim();
  const origin = getOrigin(event.headers) || process.env.URL || process.env.DEPLOY_PRIME_URL;

  if (!origin) {
    return { statusCode: 400, body: JSON.stringify({ error: "Could not determine site origin." }) };
  }
  if (!rid || !/^VV-\d{4}-\d{5}$/.test(rid)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid or missing Request ID." }) };
  }

  const params = new URLSearchParams();
  params.append("mode", mode);
  params.append("success_url", `${origin}/paid.html?session_id={CHECKOUT_SESSION_ID}&rid=${encodeURIComponent(rid)}`);
  params.append("cancel_url", `${origin}/#start?canceled=1&rid=${encodeURIComponent(rid)}`);
  params.append("metadata[rid]", rid);
  params.append("client_reference_id", rid);
  if (email) params.append("customer_email", email);

  if (priceId){
    // PRICE MODE
    params.append("line_items[0][price]", priceId);
    params.append("line_items[0][quantity]", "1");
  } else {
    // INLINE PRICE MODE (no Stripe product setup)
    const unitAmount = parseInt(process.env.UNIT_AMOUNT || "9900", 10);
    const currency = (process.env.CURRENCY || "usd").toLowerCase();
    const pname = process.env.PRODUCT_NAME || "VINvoyant Intake";
    const pdesc = process.env.PRODUCT_DESCRIPTION || "Concierge Vehicle Intelligence Intake";

    if (!Number.isFinite(unitAmount) || unitAmount < 50){
      return { statusCode: 500, body: JSON.stringify({ error: "Invalid UNIT_AMOUNT env var (must be cents, e.g. 9900)." }) };
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
