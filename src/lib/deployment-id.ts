// Version-skew protection (next.config.ts): the image build passes the commit SHA as
// STUDIO_DEPLOYMENT_ID. Imported by next.config.ts with a relative path, so no '@/' imports here.

/** The build's deployment id: the trimmed value, or undefined when unset or blank. */
export function deploymentId(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}
