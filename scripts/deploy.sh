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

for command in aws terraform docker curl; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

aws sts get-caller-identity --profile "$AWS_PROFILE" >/dev/null
CLIENT_IPV4_CIDR="${CLIENT_IPV4_CIDR:-$(curl -4fsS https://checkip.amazonaws.com | tr -d '\r\n')/32}"
if [[ ! "$CLIENT_IPV4_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]]; then
  echo "CLIENT_IPV4_CIDR must be one IPv4 address with /32." >&2
  exit 1
fi

terraform -chdir="$TF_DIR" init

is_valid_repository_url() {
  [[ "$1" =~ ^[0-9]{12}\.dkr\.ecr\.${AWS_REGION}\.amazonaws\.com/.+$ ]]
}

REPOSITORY_URL="$(terraform -chdir="$TF_DIR" output -raw ecr_repository_url 2>/dev/null || true)"
if is_valid_repository_url "$REPOSITORY_URL"; then
  echo "Existing deployment detected; keeping the current service running during the build."
else
  if STATE_RESOURCES="$(terraform -chdir="$TF_DIR" state list 2>&1)"; then
    if [[ -n "$STATE_RESOURCES" ]]; then
      echo "Terraform state contains resources but has no valid ecr_repository_url output." >&2
      echo "Refusing to apply or log in to avoid changing an existing deployment." >&2
      echo "Reconcile the Terraform state and outputs, then rerun this script." >&2
      exit 1
    fi
  elif [[ "$STATE_RESOURCES" == *"No state file was found!"* ]]; then
    STATE_RESOURCES=""
  else
    echo "Unable to inspect Terraform state:" >&2
    printf '%s\n' "$STATE_RESOURCES" >&2
    exit 1
  fi

  echo "First deployment: creating infrastructure with ECS desired count 0."
  terraform -chdir="$TF_DIR" apply -input=false \
    -var="aws_region=$AWS_REGION" \
    -var="client_ipv4_cidr=$CLIENT_IPV4_CIDR" \
    -var="desired_count=0" \
    -var="image_tag=bootstrap"
  REPOSITORY_URL="$(terraform -chdir="$TF_DIR" output -raw ecr_repository_url 2>/dev/null || true)"
  if ! is_valid_repository_url "$REPOSITORY_URL"; then
    echo "Terraform did not produce a valid ecr_repository_url output; stopping before Docker login." >&2
    exit 1
  fi
fi
echo "Allowed client CIDR: $CLIENT_IPV4_CIDR"

REGISTRY="${REPOSITORY_URL%%/*}"
IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"

aws ecr get-login-password --region "$AWS_REGION" --profile "$AWS_PROFILE" \
  | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/amd64 -t "$REPOSITORY_URL:$IMAGE_TAG" "$ROOT_DIR"
docker push "$REPOSITORY_URL:$IMAGE_TAG"

SECRET_ARN="$(terraform -chdir="$TF_DIR" output -raw copilot_secret_arn)"
if ! aws secretsmanager describe-secret --secret-id "$SECRET_ARN" --region "$AWS_REGION" --profile "$AWS_PROFILE" \
  --query VersionIdsToStages --output json | grep -q AWSCURRENT; then
  echo "Copilot token not configured. Run scripts/set-copilot-token.sh, then rerun this deploy script."
  exit 2
fi

echo "Deploying image $IMAGE_TAG with one running Fargate task."
terraform -chdir="$TF_DIR" apply -input=false \
  -var="aws_region=$AWS_REGION" \
  -var="client_ipv4_cidr=$CLIENT_IPV4_CIDR" \
  -var="desired_count=1" \
  -var="image_tag=$IMAGE_TAG"

terraform -chdir="$TF_DIR" output api_base_url
terraform -chdir="$TF_DIR" output websocket_url
