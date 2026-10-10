#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/terraform"
AWS_PROFILE="${AWS_PROFILE:-default}"
AWS_REGION="${AWS_REGION:-us-west-2}"
export AWS_PROFILE AWS_DEFAULT_PROFILE="$AWS_PROFILE"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this script as root inside Vagrant (sudo su)." >&2
  exit 1
fi

SECRET_ARN="$(terraform -chdir="$TF_DIR" output -raw copilot_secret_arn)"
read -r -s -p "GitHub Copilot token (input hidden): " COPILOT_GITHUB_TOKEN
printf '\n'
if [[ -z "$COPILOT_GITHUB_TOKEN" ]]; then
  echo "Token cannot be empty." >&2
  exit 1
fi

printf '%s' "$COPILOT_GITHUB_TOKEN" \
  | aws secretsmanager put-secret-value \
      --secret-id "$SECRET_ARN" \
      --secret-string file:///dev/stdin \
      --region "$AWS_REGION" \
      --profile "$AWS_PROFILE" \
      --query VersionId \
      --output text >/dev/null
unset COPILOT_GITHUB_TOKEN

echo "Copilot token stored in Secrets Manager. Redeploy to inject it into ECS."
