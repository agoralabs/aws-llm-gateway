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
      Project   = var.project_name
      ManagedBy = "Terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_route53_zone" "main" {
  name         = var.hosted_zone_name
  private_zone = false
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix        = var.project_name
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  public_subnet_cidrs = [
    for index in range(2) : cidrsubnet(var.vpc_cidr, 8, index)
  ]
}
