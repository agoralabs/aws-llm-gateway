output "api_base_url" {
  value       = "https://${var.domain_name}"
  description = "Base URL des endpoints HTTP."
}

output "websocket_url" {
  value       = "wss://${var.domain_name}/v1/ws"
  description = "URL du endpoint WebSocket de génération."
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.gateway.repository_url
  description = "Repository ECR utilisé par le script de déploiement."
}

output "copilot_secret_arn" {
  value       = aws_secretsmanager_secret.copilot_token.arn
  description = "ARN du secret à renseigner via scripts/set-copilot-token.sh."
}

output "sqs_queue_url" {
  value       = aws_sqs_queue.jobs.url
  description = "File SQS FIFO des jobs."
}
