function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
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

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return json(500, { error: "Missing STRIPE_SECRET_KEY in environment variables." });
  }

  const qp = event.queryStringParameters || {};
  let sessionId = String(qp.session_id || "").trim();

  if (!sessionId && event.httpMethod === "POST") {
    try {
      const payload = JSON.parse(event.body || "{}");
      sessionId = String(payload.session_id || payload.sessionId || "").trim();
    } catch {}
  }

  if (!sessionId) {
    return json(400, { error: "Missing session_id." });
  }

  const out = await fetchCheckoutSession(secret, sessionId);
  if (!out.ok) {
    return json(out.status, { error: out.data?.error?.message || "Stripe error", details: out.data });
  }

  const session = out.data || {};
  const paid = session.payment_status === "paid";
  const rid = session.metadata?.rid || session.client_reference_id || "";

  return json(200, {
    paid,
    session_id: session.id || sessionId,
    rid,
    status: session.status,
    payment_status: session.payment_status,
  });
};

