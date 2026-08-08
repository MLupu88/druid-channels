// Service boundary for a real LLM provider used to structure discovery
// evidence into the qualification schema (product spec, section 8.3). No
// live calls are implemented yet: this function throws until a specific
// provider is chosen and wired up, so discoveryEngine.ts never silently
// fabricates a qualification that no model actually produced. Once
// implemented, read the provider choice from `connection.configJson.provider`
// and the API key from `process.env[connection.credentialEnvVar]`.
//
// The LLM must only structure and summarize collected evidence -- it must
// never invent companies or evidence, and every claim it returns must
// reference at least one evidence URL it was given as input.

export class AiNotImplementedError extends Error {
  constructor() {
    super("AI structuring is not implemented yet. Configure a connection and implement this call before relying on live discovery.");
    this.name = "AiNotImplementedError";
  }
}

export interface AiQualificationInput {
  companyName: string;
  domain: string;
  evidence: Array<{ url: string; text: string }>;
}

export interface AiQualificationOutput {
  partnerType: string;
  enterpriseAccess: boolean;
  relevantCapability: boolean;
  technologyAdjacency: boolean;
  partnershipOpenness: boolean;
  recentTrigger: boolean;
  whyItFits: string;
  whyNow: string;
  suggestedAngle: string;
  suggestedTargetRole: string;
  suggestedMessage: string;
  // Must be a subset of the URLs present in AiQualificationInput.evidence --
  // an implementation must never invent a source URL that wasn't given to it.
  evidenceUrls: string[];
}

export async function qualify(_input: AiQualificationInput): Promise<AiQualificationOutput> {
  throw new AiNotImplementedError();
}
