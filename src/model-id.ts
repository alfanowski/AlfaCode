const PREFIX = "alfacode-anthropic";
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const ONE_MILLION_CONTEXT_SUFFIX = "[1m]";

export interface DecodedModelId {
  readonly providerId: string;
  readonly upstreamModel: string;
  readonly extendedContext: boolean;
}

export function encodeModelId(providerId: string, upstreamModel: string): string {
  if (!PROVIDER_ID.test(providerId) || upstreamModel.length === 0) {
    throw new Error("Invalid provider or upstream model identifier");
  }
  return `${PREFIX}/${encodeURIComponent(providerId)}/${encodeURIComponent(upstreamModel)}`;
}

export function decodeModelId(modelId: string): DecodedModelId | undefined {
  const extendedContext = modelId.endsWith(ONE_MILLION_CONTEXT_SUFFIX);
  const normalizedModelId = extendedContext ? modelId.slice(0, -ONE_MILLION_CONTEXT_SUFFIX.length) : modelId;
  const parts = normalizedModelId.split("/");
  if (parts.length !== 3 || parts[0] !== PREFIX || parts[1] === undefined || parts[2] === undefined) {
    return undefined;
  }

  try {
    const providerId = decodeURIComponent(parts[1]);
    const upstreamModel = decodeURIComponent(parts[2]);
    return PROVIDER_ID.test(providerId) && upstreamModel.length > 0
      ? { providerId, upstreamModel, extendedContext }
      : undefined;
  } catch {
    return undefined;
  }
}
