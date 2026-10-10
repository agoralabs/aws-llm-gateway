variable "aws_region" {
  description = "Région AWS de l'application Amplify."
  type        = string
  default     = "us-west-2"
}

variable "app_name" {
  description = "Nom de l'application Amplify."
  type        = string
  default     = "gatewaylab"
}

variable "amplify_app_id" {
  description = "Identifiant de l'application créée et liée à GitHub depuis la console Amplify."
  type        = string
}

variable "github_branch" {
  description = "Branche déployée automatiquement par Amplify."
  type        = string
  default     = "main"
}

variable "hosted_zone_name" {
  description = "Domaine racine présent dans la zone publique Route 53."
  type        = string
  default     = "kaiac.io"
}

variable "subdomain_prefix" {
  description = "Préfixe DNS associé à la branche de production."
  type        = string
  default     = "gatewaylab"
}
