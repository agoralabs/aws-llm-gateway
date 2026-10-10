resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "gateway" {
  name = var.project_name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_iam_role" "execution" {
  name = "${var.project_name}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secret" {
  name = "read-copilot-token"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.copilot_token.arn
    }]
  })
}

resource "aws_iam_role" "task" {
  name = "${var.project_name}-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "task" {
  name = "gateway-runtime"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.jobs.arn, aws_sqs_queue.dead_letter.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.jobs.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.jobs.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = var.project_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name        = var.project_name
    image       = "${aws_ecr_repository.gateway.repository_url}:${var.image_tag}"
    essential   = true
    user        = "10001:10001"
    stopTimeout = 120
    portMappings = [{
      containerPort = 8080
      protocol      = "tcp"
    }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "8080" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "JOBS_BUCKET", value = aws_s3_bucket.jobs.id },
      { name = "SQS_QUEUE_URL", value = aws_sqs_queue.jobs.url },
      { name = "COPILOT_HOME", value = "/tmp/copilot-home" },
      { name = "ALLOWED_MODELS", value = var.allowed_models },
      { name = "MAX_PROMPT_BYTES", value = tostring(var.max_prompt_bytes) },
      { name = "MAX_OUTPUT_BYTES", value = tostring(var.max_output_bytes) },
      { name = "MAX_JOB_DURATION_MS", value = tostring(var.max_job_duration_ms) }
    ]
    secrets = [{
      name      = "COPILOT_GITHUB_TOKEN"
      valueFrom = aws_secretsmanager_secret.copilot_token.arn
    }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 90
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.gateway.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])

  tags = { Name = var.project_name }
}

resource "aws_ecs_service" "gateway" {
  name                   = var.project_name
  cluster                = aws_ecs_cluster.gateway.id
  task_definition        = aws_ecs_task_definition.gateway.arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  enable_execute_command = true

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = var.project_name
    container_port   = 8080
  }

  health_check_grace_period_seconds = 120
  depends_on = [
    aws_lb_listener.https,
    aws_iam_role_policy.task,
    aws_iam_role_policy.execution_secret,
    aws_iam_role_policy_attachment.execution
  ]

  tags = { Name = var.project_name }
}
