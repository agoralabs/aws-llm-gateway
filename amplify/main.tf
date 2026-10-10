terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.app_name
      ManagedBy = "Terraform"
    }
  }
}

data "aws_route53_zone" "public" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_amplify_domain_association" "frontend" {
  app_id      = var.amplify_app_id
  domain_name = var.hosted_zone_name

  sub_domain {
    branch_name = var.github_branch
    prefix      = var.subdomain_prefix
  }

  certificate_settings {
    type = "AMPLIFY_MANAGED"
  }

  wait_for_verification = false
}

locals {
  certificate_verification_record = regexall("\\S+", aws_amplify_domain_association.frontend.certificate_verification_dns_record)
  frontend_cname_record           = regexall("\\S+", one(aws_amplify_domain_association.frontend.sub_domain).dns_record)
}

resource "aws_route53_record" "certificate_verification" {
  zone_id         = data.aws_route53_zone.public.zone_id
  name            = local.certificate_verification_record[0]
  type            = local.certificate_verification_record[1]
  ttl             = 300
  records         = [local.certificate_verification_record[2]]
  allow_overwrite = true
}

resource "aws_route53_record" "frontend" {
  zone_id         = data.aws_route53_zone.public.zone_id
  name            = "${var.subdomain_prefix}.${var.hosted_zone_name}"
  type            = local.frontend_cname_record[0]
  ttl             = 300
  records         = [local.frontend_cname_record[1]]
  allow_overwrite = true
}
