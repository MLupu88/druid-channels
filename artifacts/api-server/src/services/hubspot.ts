// Service boundary for a real HubSpot integration. No live HTTP calls are
// implemented yet (Task #7 scope is admin config + honest status, not a
// working HubSpot sync) -- every function below throws until a real
// implementation is wired up, so a HUBSPOT-mapped KPI never silently
// reports fabricated data. Once implemented, these should call the HubSpot
// API using `process.env[connection.credentialEnvVar]` as the bearer token.

export class HubSpotNotImplementedError extends Error {
  constructor(operation: string) {
    super(`HubSpot ${operation} is not implemented yet. Configure a connection and implement this call before mapping a KPI to HUBSPOT.`);
    this.name = "HubSpotNotImplementedError";
  }
}

export async function testConnection(_accessToken: string): Promise<{ ok: boolean; message: string }> {
  throw new HubSpotNotImplementedError("testConnection");
}

export async function findCompanyByDomain(_accessToken: string, _domain: string): Promise<unknown> {
  throw new HubSpotNotImplementedError("findCompanyByDomain");
}

export async function getPartners(_accessToken: string): Promise<unknown[]> {
  throw new HubSpotNotImplementedError("getPartners");
}

export async function getDeals(_accessToken: string): Promise<unknown[]> {
  throw new HubSpotNotImplementedError("getDeals");
}

export async function getCampaignData(_accessToken: string): Promise<unknown[]> {
  throw new HubSpotNotImplementedError("getCampaignData");
}

export async function getRenewals(_accessToken: string): Promise<unknown[]> {
  throw new HubSpotNotImplementedError("getRenewals");
}
