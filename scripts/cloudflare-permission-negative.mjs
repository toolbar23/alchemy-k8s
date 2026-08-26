import { randomUUID } from "node:crypto";
import console from "node:console";
import process from "node:process";

const { AbortSignal, fetch } = globalThis;

if (process.argv[2] !== undefined) process.loadEnvFile(process.argv[2]);

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const zoneName = process.env.CLOUDFLARE_TEST_ZONE ?? "openmdta.com";
if (accountId === undefined || apiToken === undefined) {
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required",
  );
}

const request = async (
  path,
  { token = apiToken, method = "GET", body } = {},
) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { response, payload: await response.json() };
};

const zones = await request(
  `/zones?name=${encodeURIComponent(zoneName)}&account.id=${encodeURIComponent(accountId)}`,
);
if (!zones.response.ok || zones.payload.result?.length !== 1) {
  throw new Error(
    `Could not resolve the Cloudflare test zone (${zones.response.status})`,
  );
}
const zoneId = zones.payload.result[0].id;

const permissionGroups = await request(
  `/accounts/${accountId}/tokens/permission_groups`,
);
const zoneRead = permissionGroups.payload.result?.find(
  (group) => group.name === "Zone Read",
);
if (!permissionGroups.response.ok || zoneRead === undefined) {
  throw new Error(
    `Could not resolve Cloudflare Zone Read permission (${permissionGroups.response.status})`,
  );
}

const suffix = randomUUID();
const created = await request(`/accounts/${accountId}/tokens`, {
  method: "POST",
  body: {
    name: `alchemy-negative-${suffix}`,
    policies: [
      {
        effect: "allow",
        permission_groups: [{ id: zoneRead.id }],
        resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
      },
    ],
  },
});
if (
  !created.response.ok ||
  created.payload.result?.id === undefined ||
  created.payload.result?.value === undefined
) {
  throw new Error(
    `Could not create the restricted Cloudflare token (${created.response.status})`,
  );
}

const tokenId = created.payload.result.id;
let unexpectedRecordId;
let testError;
try {
  const readable = await request(`/zones/${zoneId}`, {
    token: created.payload.result.value,
  });
  if (!readable.response.ok) {
    throw new Error(
      `The Zone Read control request failed (${readable.response.status})`,
    );
  }

  const denied = await request(`/zones/${zoneId}/dns_records`, {
    token: created.payload.result.value,
    method: "POST",
    body: {
      type: "TXT",
      name: `_alchemy-permission-negative.${zoneName}`,
      content: suffix,
      ttl: 60,
    },
  });
  unexpectedRecordId = denied.payload.result?.id;
  if (denied.response.status !== 403) {
    throw new Error(
      `A Zone Read-only token returned ${denied.response.status} for DNS Write; expected 403`,
    );
  }
} catch (error) {
  testError = error;
}

const cleanupErrors = [];
if (unexpectedRecordId !== undefined) {
  try {
    const removedRecord = await request(
      `/zones/${zoneId}/dns_records/${unexpectedRecordId}`,
      { method: "DELETE" },
    );
    if (!removedRecord.response.ok) {
      cleanupErrors.push(
        new Error(
          `Could not remove the unexpected DNS record (${removedRecord.response.status})`,
        ),
      );
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
}
try {
  const removedToken = await request(
    `/accounts/${accountId}/tokens/${tokenId}`,
    { method: "DELETE" },
  );
  if (!removedToken.response.ok) {
    cleanupErrors.push(
      new Error(
        `Could not remove the restricted Cloudflare token (${removedToken.response.status})`,
      ),
    );
  }
} catch (error) {
  cleanupErrors.push(error);
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "Cloudflare test cleanup failed");
}
if (testError !== undefined) {
  throw testError;
}

console.log(
  `Cloudflare negative permission test passed for ${zoneName}: Zone Read allowed, DNS Write denied`,
);
