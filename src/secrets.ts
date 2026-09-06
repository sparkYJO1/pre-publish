/**
 * A deliberately short list of high-signal, prefix-anchored credential
 * patterns. This is a secondary check. gitleaks and trufflehog carry hundreds
 * of rules plus live verification, and they are the right tool for depth --
 * see the README. What is here exists so that an obvious key in history is not
 * missed by someone who runs only this tool.
 */
export interface SecretPattern {
  id: string;
  description: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub personal access / OAuth token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "github-fine-grained-token",
    description: "GitHub fine-grained personal access token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  },
  {
    id: "private-key-block",
    description: "PEM private key block",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "slack-token",
    description: "Slack token",
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "stripe-secret-key",
    description: "Stripe secret or restricted key",
    regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  },
  {
    id: "npm-token",
    description: "npm access token",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "jwt",
    description: "JSON Web Token",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];
