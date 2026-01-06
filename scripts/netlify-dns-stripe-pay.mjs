#!/usr/bin/env node
/**
 * Applies Stripe "custom domain" DNS records in Netlify DNS.
 *
 * Requirements:
 * - NETLIFY_AUTH_TOKEN must be set (or pass --auth-token).
 * - The domain's DNS zone must be hosted on Netlify DNS.
 *
 * The TXT value (ACME challenge) is treated as sensitive and is never printed.
 */

const NETLIFY_API_BASE = "https://api.netlify.com/api/v1";

function readArgValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function printHelp() {
  // Avoid printing sensitive defaults; keep help minimal.
  console.log(
    [
      "Usage:",
      "  node scripts/netlify-dns-stripe-pay.mjs [options]",
      "",
      "Options:",
      "  --auth-token <token>          Netlify auth token (or set NETLIFY_AUTH_TOKEN)",
      "  --zone <domain>               DNS zone name (default: vinvoyant.com)",
      "  --cname-host <host>           CNAME host (default: pay)",
      "  --cname-target <target>       CNAME target (default: hosted-checkout.stripecdn.com)",
      "  --txt-host <host>             TXT host (default: _acme-challenge.pay)",
      "  --txt-value <value>           TXT value (or set STRIPE_ACME_CHALLENGE_VALUE)",
      "  --ttl <seconds>               TTL (default: 300)",
      "  --force                       Replace existing differing records",
      "  -h, --help                    Show help",
    ].join("\n"),
  );
}

async function netlifyRequest(authToken, path, { method = "GET", body } = {}) {
  const response = await fetch(`${NETLIFY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "User-Agent": "netlify-agent-dns-helper",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const message = text ? `${response.status} ${response.statusText}: ${text}` : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return response.json();
}

function normalizeZoneName(zoneName) {
  return zoneName.endsWith(".") ? zoneName.slice(0, -1) : zoneName;
}

function redactValue(type, value) {
  if (type === "TXT") return "(redacted)";
  return value;
}

async function upsertRecord({ authToken, zoneId, desiredRecord, force }) {
  const existingRecords = await netlifyRequest(authToken, `/dns_zones/${zoneId}/dns_records`);

  const matches = existingRecords.filter(
    (record) =>
      String(record.type).toUpperCase() === desiredRecord.type &&
      String(record.hostname) === desiredRecord.hostname,
  );

  const desiredValue = String(desiredRecord.value);

  // If any existing record already matches desired value, do nothing.
  if (matches.some((record) => String(record.value) === desiredValue)) {
    console.log(
      `OK: ${desiredRecord.type} ${desiredRecord.hostname} already set to ${redactValue(desiredRecord.type, desiredValue)}`,
    );
    return;
  }

  if (matches.length > 0 && !force) {
    console.error(
      `Blocked: ${desiredRecord.type} ${desiredRecord.hostname} exists with a different value. Re-run with --force to replace it.`,
    );
    process.exitCode = 2;
    return;
  }

  // Replace any conflicting records (same host+type) when forced.
  if (matches.length > 0 && force) {
    for (const record of matches) {
      await netlifyRequest(authToken, `/dns_zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    }
    console.log(`Replaced: ${desiredRecord.type} ${desiredRecord.hostname} (existing records removed)`);
  }

  await netlifyRequest(authToken, `/dns_zones/${zoneId}/dns_records`, {
    method: "POST",
    body: desiredRecord,
  });

  console.log(
    `Created: ${desiredRecord.type} ${desiredRecord.hostname} -> ${redactValue(desiredRecord.type, desiredValue)}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, "-h") || hasFlag(args, "--help")) {
    printHelp();
    return;
  }

  const authToken = readArgValue(args, "--auth-token") || process.env.NETLIFY_AUTH_TOKEN;
  if (!authToken) {
    console.error("Missing Netlify auth token. Set NETLIFY_AUTH_TOKEN or pass --auth-token.");
    process.exitCode = 2;
    return;
  }

  const zoneName = normalizeZoneName(readArgValue(args, "--zone") || "vinvoyant.com");
  const ttlRaw = readArgValue(args, "--ttl") || "300";
  const ttl = Number.parseInt(ttlRaw, 10);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("Invalid --ttl value (must be a positive integer).");
  }

  const cnameHost = readArgValue(args, "--cname-host") || "pay";
  const cnameTarget = readArgValue(args, "--cname-target") || "hosted-checkout.stripecdn.com";
  const txtHost = readArgValue(args, "--txt-host") || "_acme-challenge.pay";
  const txtValue = readArgValue(args, "--txt-value") || process.env.STRIPE_ACME_CHALLENGE_VALUE;
  if (!txtValue) {
    console.error("Missing TXT value. Set STRIPE_ACME_CHALLENGE_VALUE or pass --txt-value.");
    process.exitCode = 2;
    return;
  }

  const force = hasFlag(args, "--force");

  const zones = await netlifyRequest(authToken, "/dns_zones");
  const zone = zones.find((z) => normalizeZoneName(String(z.name)) === zoneName);
  if (!zone) {
    console.error(
      `DNS zone not found in Netlify DNS: ${zoneName}. The domain's DNS must be hosted on Netlify DNS to apply records from this environment.`,
    );
    process.exitCode = 3;
    return;
  }

  await upsertRecord({
    authToken,
    zoneId: zone.id,
    force,
    desiredRecord: {
      type: "CNAME",
      hostname: cnameHost,
      value: cnameTarget,
      ttl,
    },
  });

  await upsertRecord({
    authToken,
    zoneId: zone.id,
    force,
    desiredRecord: {
      type: "TXT",
      hostname: txtHost,
      value: txtValue,
      ttl,
    },
  });
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

