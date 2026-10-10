resource "aws_s3_bucket" "jobs" {
  bucket        = "${var.project_name}-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  force_destroy = false

  tags = { Name = "${local.name_prefix}-jobs" }
}

resource "aws_s3_bucket_public_access_block" "jobs" {
  bucket                  = aws_s3_bucket.jobs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "jobs" {
  bucket = aws_s3_bucket.jobs.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "jobs" {
  bucket = aws_s3_bucket.jobs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "jobs" {
  bucket = aws_s3_bucket.jobs.id

  rule {
    id     = "expire-inputs"
    status = "Enabled"
    filter { prefix = "inputs/" }
    expiration { days = 1 }
  }
  rule {
    id     = "expire-cancellations"
    status = "Enabled"
    filter { prefix = "cancellations/" }
    expiration { days = 1 }
  }
  rule {
    id     = "expire-job-metadata"
    status = "Enabled"
    filter { prefix = "jobs/" }
    expiration { days = 30 }
  }
  rule {
    id     = "expire-request-index"
    status = "Enabled"
    filter { prefix = "requests/" }
    expiration { days = 30 }
  }
  rule {
    id     = "expire-results"
    status = "Enabled"
    filter { prefix = "results/" }
    expiration { days = 30 }
  }
}

resource "aws_sqs_queue" "dead_letter" {
  name                        = "${var.project_name}-jobs-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 1209600
}

resource "aws_sqs_queue" "jobs" {
  name                        = "${var.project_name}-jobs.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 1209600
  receive_wait_time_seconds   = 20
  visibility_timeout_seconds  = 120

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 3
  })
}

resource "aws_ecr_repository" "gateway" {
  name                 = var.project_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration { scan_on_push = true }
  tags = { Name = var.project_name }
}

resource "aws_ecr_lifecycle_policy" "gateway" {
  repository = aws_ecr_repository.gateway.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the ten most recent tagged deploys"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_secretsmanager_secret" "copilot_token" {
  name                    = "${var.project_name}/copilot-token"
  description             = "GitHub Copilot token used only by the gateway task"
  recovery_window_in_days = 7

  tags = { Name = "${var.project_name}-copilot-token" }
}
