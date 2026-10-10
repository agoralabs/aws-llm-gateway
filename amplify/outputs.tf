output "app_id" {
  description = "Identifiant de l'application Amplify."
  value       = var.amplify_app_id
}

output "default_url" {
  description = "URL Amplify de la branche principale."
  value       = "https://${var.github_branch}.${var.amplify_app_id}.amplifyapp.com"
}

output "custom_domain_url" {
  description = "URL publique de la console Gateway Lab."
  value       = "https://${var.subdomain_prefix}.${var.hosted_zone_name}"
}
