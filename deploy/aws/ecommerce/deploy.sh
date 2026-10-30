#!/bin/bash
# Larkspur Goods on AWS. Run in AWS CloudShell from the repository root:
#   bash deploy/aws/ecommerce/deploy.sh up 203.0.113.5/32   # your public IP; takes ~5 min, then ~10 min of setup
#   bash deploy/aws/ecommerce/deploy.sh status               # dashboard URL, setup code, per-host readiness
#   bash deploy/aws/ecommerce/deploy.sh join 'curl -fsSL http://.../agent/install.sh | sudo bash -s -- ...'
#                                                            # optional: run the dashboard's install command on all shop hosts
#   bash deploy/aws/ecommerce/deploy.sh down                 # delete everything (stops all charges)
set -euo pipefail
STACK=larkspur-goods
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="larkspur-twin-${ACCOUNT}-${REGION}"
export AWS_DEFAULT_REGION="$REGION"

output() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

run_on() {  # instance-ids... -- command ; prints each host's output via Session Manager
  local ids=() command
  while [ "$1" != "--" ]; do ids+=("$1"); shift; done; shift; command="$1"
  local params; params=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]]}))' "$command")
  local cid; cid=$(aws ssm send-command --document-name AWS-RunShellScript --instance-ids "${ids[@]}" \
    --parameters "$params" --query Command.CommandId --output text)
  for id in "${ids[@]}"; do
    aws ssm wait command-executed --command-id "$cid" --instance-id "$id" 2>/dev/null || true
    name=$(aws ec2 describe-instances --instance-ids "$id" --query "Reservations[0].Instances[0].Tags[?Key=='Name'].Value" --output text)
    echo "== $name"
    aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" \
      --query '[StandardOutputContent,StandardErrorContent]' --output text | sed '/^None$/d'
  done
}

case "${1:-}" in
up)
  cidr="${2:?usage: deploy.sh up <your-public-ip>/32  (find it at https://checkip.amazonaws.com in your browser)}"
  aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || {
    if [ "$REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
    else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null; fi
    aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true; }
  state=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].StackStatus" --output text 2>/dev/null || true)
  if [ "$state" = ROLLBACK_COMPLETE ]; then
    echo "Removing the earlier failed attempt first..."
    aws cloudformation delete-stack --stack-name "$STACK"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK"
  fi
  archive=$(mktemp --suffix=.tgz)
  (cd "$ROOT" && tar -czf "$archive" --exclude=node_modules --exclude=__pycache__ \
     agent ingestion ui deploy schema docker-compose.yml)
  aws s3 cp --quiet "$archive" "s3://$BUCKET/repo.tgz"
  rm -f "$archive"
  url=$(aws s3 presign "s3://$BUCKET/repo.tgz" --expires-in 21600)
  aws cloudformation deploy --stack-name "$STACK" --template-file "$ROOT/deploy/aws/ecommerce/stack.yaml" \
    --capabilities CAPABILITY_IAM --parameter-overrides "OperatorCidr=$cidr" "RepoUrl=$url" \
    "DbPassword=$(openssl rand -hex 16)" "Layout=${LAYOUT:-compact}"
  echo
  echo "Created. Servers are installing software now (about 10 minutes)."
  echo "Dashboard:  $(output Dashboard)"
  echo "Storefront: $(output Storefront)"
  echo "Next: bash deploy/aws/ecommerce/deploy.sh status"
  ;;
status)
  echo "Dashboard:  $(output Dashboard)"
  echo "Storefront: $(output Storefront)"
  run_on "$(output ControlInstance)" -- 'cat /root/twin-ready.txt 2>/dev/null || { echo "still installing:"; tail -n 3 /var/log/twin-control-setup.log; }'
  # shellcheck disable=SC2046
  run_on $(output ShopInstances) -- 'tail -n 1 /var/log/larkspur-setup.log 2>/dev/null; systemctl is-active twin-agent 2>/dev/null | sed "s/^/twin agent: /"'
  ;;
join)
  command="${2:?usage: deploy.sh join '<Linux install command copied from Hosts -> Add hosts>'}"
  # shellcheck disable=SC2046
  run_on $(output ShopInstances) -- "$command"
  ;;
down)
  aws cloudformation delete-stack --stack-name "$STACK"
  echo "Deleting stack (a few minutes)..."
  aws cloudformation wait stack-delete-complete --stack-name "$STACK"
  aws s3 rm --quiet --recursive "s3://$BUCKET" 2>/dev/null || true
  aws s3api delete-bucket --bucket "$BUCKET" 2>/dev/null || true
  echo "Everything for Larkspur Goods is deleted."
  ;;
*) sed -n '2,8p' "$0"; exit 2 ;;
esac
