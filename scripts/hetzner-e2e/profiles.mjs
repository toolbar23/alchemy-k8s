export const BASE_CHANNEL = "v1.35";
export const UPGRADE_CHANNEL = "v1.36";
export const STACK_NAME = "HetznerK3sE2E";

export const PROFILES = Object.freeze({
  "single-x86": Object.freeze({
    controlPlane: Object.freeze({
      count: 1,
      serverType: "cx23",
      locations: Object.freeze(["nbg1"]),
    }),
    scheduleWorkloadsOnControlPlane: true,
    workerPools: Object.freeze([]),
  }),
  "worker-x86": Object.freeze({
    controlPlane: Object.freeze({
      count: 1,
      serverType: "cx23",
      locations: Object.freeze(["nbg1"]),
    }),
    scheduleWorkloadsOnControlPlane: false,
    workerPools: Object.freeze([
      Object.freeze({
        name: "nbg",
        serverType: "cx23",
        location: "nbg1",
        count: 1,
      }),
    ]),
  }),
  "small-x86": Object.freeze({
    controlPlane: Object.freeze({
      count: 1,
      serverType: "cx23",
      locations: Object.freeze(["nbg1"]),
    }),
    scheduleWorkloadsOnControlPlane: false,
    workerPools: Object.freeze([
      Object.freeze({
        name: "nbg",
        serverType: "cx23",
        location: "nbg1",
        count: 1,
      }),
      Object.freeze({
        name: "fsn",
        serverType: "cx23",
        location: "fsn1",
        count: 1,
      }),
      Object.freeze({
        name: "hel",
        serverType: "cx23",
        location: "hel1",
        count: 1,
      }),
    ]),
  }),
  "ha-x86": Object.freeze({
    controlPlane: Object.freeze({
      count: 3,
      serverType: "cx23",
      locations: Object.freeze(["nbg1", "fsn1", "hel1"]),
    }),
    scheduleWorkloadsOnControlPlane: false,
    workerPools: Object.freeze([
      Object.freeze({
        name: "nbg",
        serverType: "cx23",
        location: "nbg1",
        count: 1,
      }),
      Object.freeze({
        name: "fsn",
        serverType: "cx23",
        location: "fsn1",
        count: 1,
      }),
      Object.freeze({
        name: "hel",
        serverType: "cx23",
        location: "hel1",
        count: 1,
      }),
    ]),
  }),
});

export const requireProfile = (name) => {
  const profile = PROFILES[name];
  if (profile === undefined) {
    throw new Error(
      `Unknown or missing --profile. Choose exactly one of: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  return profile;
};

export const baselineDesired = (name) => {
  const profile = requireProfile(name);
  return {
    channel: BASE_CHANNEL,
    protected: true,
    workerPools: profile.workerPools.map((pool) => ({
      name: pool.name,
      serverType: pool.serverType,
      location: pool.location,
      count: pool.count,
    })),
  };
};

export const renderClusterConfig = (name, desired, allowedCidrs) => {
  const profile = requireProfile(name);
  const expectedNames = profile.workerPools.map(
    ({ name: poolName }) => poolName,
  );
  const receivedNames = desired.workerPools.map(
    ({ name: poolName }) => poolName,
  );
  if (
    JSON.stringify([...expectedNames].sort()) !==
    JSON.stringify([...receivedNames].sort())
  ) {
    throw new Error(
      `Desired worker pools for ${name} must remain ${expectedNames.join(", ") || "empty"}`,
    );
  }
  if (!/^v1\.\d+$/.test(desired.channel)) {
    throw new Error(`Invalid K3s minor channel: ${desired.channel}`);
  }
  if (allowedCidrs.length === 0) {
    throw new Error("At least one SSH/API CIDR is required");
  }
  return {
    profile: name,
    clusterId: `e2e-${name}`,
    resourceId: `e2e-${name}`,
    channel: desired.channel,
    protected: desired.protected,
    allowedCidrs,
    controlPlane: {
      count: profile.controlPlane.count,
      serverType: profile.controlPlane.serverType,
      locations: [...profile.controlPlane.locations],
    },
    scheduleWorkloadsOnControlPlane: profile.scheduleWorkloadsOnControlPlane,
    workerPools: desired.workerPools.map((pool) => ({ ...pool })),
    ...(desired.etcdSnapshots === undefined
      ? {}
      : { etcdSnapshots: desired.etcdSnapshots }),
    ...(desired.recovery === undefined ? {} : { recovery: desired.recovery }),
  };
};

export const expectedServerCount = (name, desired) => {
  const profile = requireProfile(name);
  return (
    profile.controlPlane.count +
    desired.workerPools.reduce((total, pool) => total + pool.count, 0)
  );
};
