export const invalidPathParameterError = {
  code: "invalid_path_parameter",
  message: "Malformed percent encoding in path parameter",
} as const;

export function decodePathParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}
