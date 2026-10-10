variable "project_name" {
  description = "Prefixe des ressources AWS du projet."
  type        = string
  default     = "aws-llm-gateway"
}

variable "aws_region" {
  description = "Région AWS utilisée par Terraform et les ressources."
  type        = string
  default     = "us-west-2"
}

variable "hosted_zone_name" {
  description = "Zone publique Route 53 qui héberge le domaine."
  type        = string
  default     = "kaiac.io"
}

variable "domain_name" {
  description = "Nom DNS public de la gateway."
  type        = string
  default     = "llm.kaiac.io"
}

variable "client_ipv4_cidr" {
  description = "IPv4 publique autorisée à appeler l'ALB, au format x.x.x.x/32."
  type        = string
  validation {
    condition     = can(cidrnetmask(var.client_ipv4_cidr))
    error_message = "client_ipv4_cidr doit être un CIDR IPv4 valide, idéalement une adresse unique en /32."
  }
}

variable "vpc_cidr" {
  description = "CIDR IPv4 du VPC dédié."
  type        = string
  default     = "10.42.0.0/16"
}

variable "desired_count" {
  description = "Nombre de tâches ECS; laisser à zéro pendant le bootstrap de l'image et du secret."
  type        = number
  default     = 0
  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 2
    error_message = "desired_count doit être compris entre 0 et 2 pour cette V1 mono-utilisateur."
  }
}

variable "image_tag" {
  description = "Tag immuable de l'image Docker poussée dans ECR."
  type        = string
  default     = "bootstrap"
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    error_message = "image_tag contient des caractères invalides."
  }
}

variable "allowed_models" {
  description = "Modèles Copilot autorisés, séparés par des virgules."
  type        = string
  default     = "gpt-5.4,gpt-6-luna,claude-haiku-5.5,MAI-Code-1.1-Flash"
}

variable "max_prompt_bytes" {
  type        = number
  description = "Taille maximale du prompt en octets."
  default     = 204800
}

variable "max_output_bytes" {
  type        = number
  description = "Taille maximale de la réponse en octets."
  default     = 26214400
}

variable "max_job_duration_ms" {
  type        = number
  description = "Durée maximale d'un job en millisecondes."
  default     = 3600000
}
