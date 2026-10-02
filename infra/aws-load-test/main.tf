data "aws_caller_identity" "current" {}

locals {
  topic_prefix = "$aws/rules/${var.rule_name}"
}

resource "aws_iam_role" "iot_rule" {
  name = "${var.rule_name}-republish"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "iot.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "iot_rule" {
  name = "verified-topic-publish"
  role = aws_iam_role.iot_rule.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "iot:Publish"
      Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/verified/fleet/v1/devices/*/telemetry"
    }]
  })
}

resource "aws_iot_topic_rule" "load_test" {
  name        = var.rule_name
  description = "Issue 64 Basic Ingest cloud path verification"
  enabled     = true
  sql         = "SELECT * FROM 'fleet/v1/devices/+/telemetry'"
  sql_version = "2016-03-23"

  republish {
    role_arn = aws_iam_role.iot_rule.arn
    topic    = "verified/$${topic()}"
    qos      = 0
  }
}

resource "aws_iot_policy" "load_test" {
  name = "${var.rule_name}-client"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:client/load-*"
      },
      {
        Effect   = "Allow"
        Action   = "iot:Publish"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/${local.topic_prefix}/fleet/v1/devices/load-*/telemetry"
      },
      {
        Effect   = "Allow"
        Action   = "iot:Subscribe"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topicfilter/verified/fleet/v1/devices/load-*/telemetry"
      },
      {
        Effect   = "Allow"
        Action   = "iot:Receive"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/verified/fleet/v1/devices/load-*/telemetry"
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "load_test" {
  policy = aws_iot_policy.load_test.name
  target = var.certificate_arn
}

resource "aws_budgets_budget" "iot" {
  count = var.budget_notification_email == "" ? 0 : 1

  name         = "drone-fleet-iot-zero-spend"
  budget_type  = "COST"
  limit_amount = "1"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["AWS IoT"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 1
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}
