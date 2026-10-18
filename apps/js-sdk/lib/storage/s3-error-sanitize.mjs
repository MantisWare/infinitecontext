const AWS_ACCESS_KEY_PATTERN = /\b(AKIA[0-9A-Z]{16})\b/g;
const AWS_SECRET_LIKE_PATTERN = /\b([A-Za-z0-9/+=]{40,})\b/g;
const SIGV4_PATTERNS = [
  /\bX-Amz-Signature=[A-Fa-f0-9]+/gi,
  /\bX-Amz-Credential=[^&\s]+/gi,
  /\bCredential=[^,\s]+/gi,
  /\bX-Amz-Security-Token=[^&\s]+/gi,
];

/**
 * @param {string} message
 */
export function redactS3ErrorMessage(message) {
  let out = String(message ?? "");
  for (const pattern of SIGV4_PATTERNS) {
    out = out.replace(pattern, "[redacted-sigv4]");
  }
  out = out.replace(AWS_ACCESS_KEY_PATTERN, "AKIA***");
  out = out.replace(AWS_SECRET_LIKE_PATTERN, (match) => {
    if (match.startsWith("AKIA")) {
      return match;
    }
    return "[redacted-secret]";
  });
  return out;
}
