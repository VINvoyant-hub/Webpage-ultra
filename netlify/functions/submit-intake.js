function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function getOrigin(headers) {
  const o = headers.origin;
  if (o) return o;
  const ref = headers.referer || headers.referrer;
  if (!ref) return null;
  try {
    return new URL(ref).origin;
  } catch {
    return null;
  }
}

async function fetchCheckoutSession(secret, sessionId) {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const data = await res.json();
  if (!res.ok) {
    return { ok: false, status: res.status, data };
  }
  return { ok: true, status: res.status, data };
}

function appendField(params, key, value) {
  if (value === undefined || value === null) return;
  const v = typeof value === "string" ? value : String(value);
  if (!v.trim()) return;
  params.append(key, v);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return json(500, { error: "Missing STRIPE_SECRET_KEY in environment variables." });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {}

  const sessionId = String(payload.session_id || payload.sessionId || "").trim();
  const requestId = String(payload.request_id || payload.requestId || "").trim();

  if (!sessionId) return json(400, { error: "Missing session_id." });
  if (!requestId) return json(400, { error: "Missing request_id." });

  const out = await fetchCheckoutSession(secret, sessionId);
  if (!out.ok) {
    return json(out.status, { error: out.data?.error?.message || "Stripe error", details: out.data });
  }

  const session = out.data || {};
  const paid = session.payment_status === "paid";
  if (!paid) {
    return json(402, { error: "Payment not verified." });
  }

  const rid = session.metadata?.rid || session.client_reference_id || "";
  if (rid && rid !== requestId) {
    return json(400, { error: "Request ID did not match the paid session." });
  }

  const siteOrigin =
    process.env.URL || process.env.DEPLOY_PRIME_URL || getOrigin(event.headers || {}) || null;

  if (siteOrigin) {
    try {
      const params = new URLSearchParams();
      params.append("form-name", "vinvoyant_intake");
      appendField(params, "source", payload.source);
      appendField(params, "request_id", requestId);
      appendField(params, "name", payload.name);
      appendField(params, "email", payload.email);
      appendField(params, "vin", payload.vin);
      appendField(params, "goal", payload.goal);
      appendField(params, "service_level", payload.service_level || payload.serviceLevel);
      appendField(params, "vehicle_tier", payload.vehicle_tier || payload.vehicleTier);
      appendField(params, "symptoms", payload.symptoms);
      appendField(params, "dtc_codes", payload.dtc_codes);
      appendField(params, "evidence_links", payload.evidence_links);

      const deliverables = Array.isArray(payload.deliverables) ? payload.deliverables : [];
      for (const d of deliverables) appendField(params, "deliverables", d);

      params.append("paid_confirmed", "true");
      params.append("payment_reference", session.id || sessionId);
      appendField(params, "session_id", session.id || sessionId);

      await fetch(`${siteOrigin}/success.html`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } catch {
      // Best-effort only: still return ok so the customer flow continues.
    }
  }

  return json(200, { ok: true, rid: requestId });
};
