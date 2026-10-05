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

resource "aws_iot_thing" "load_device" {
  for_each = var.load_device_ids

  name = each.value
}

resource "aws_iot_policy" "load_device" {
  name = "${var.rule_name}-device"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectAsAttachedThing"
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:client/$${iot:Connection.Thing.ThingName}"
        Condition = {
          Bool = {
            "iot:Connection.Thing.IsAttached" = "true"
          }
        }
      },
      {
        Sid      = "PublishOwnTelemetryThroughBasicIngest"
        Effect   = "Allow"
        Action   = "iot:Publish"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/${local.topic_prefix}/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/telemetry"
        Condition = {
          Bool = {
            "iot:Connection.Thing.IsAttached" = "true"
          }
        }
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "load_device" {
  for_each = var.load_device_certificate_arns

  policy = aws_iot_policy.load_device.name
  target = each.value
}

resource "aws_iot_thing" "probe" {
  name = var.probe_device_id
}

resource "aws_iot_policy" "probe" {
  name = "${var.rule_name}-probe"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectAsProbe"
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:client/${var.probe_device_id}"
      },
      {
        Sid      = "PublishProbeTelemetry"
        Effect   = "Allow"
        Action   = "iot:Publish"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/${local.topic_prefix}/fleet/v1/devices/${var.probe_device_id}/telemetry"
      },
      {
        Sid      = "SubscribeToProbeResult"
        Effect   = "Allow"
        Action   = "iot:Subscribe"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topicfilter/verified/fleet/v1/devices/${var.probe_device_id}/telemetry"
      },
      {
        Sid      = "ReceiveProbeResult"
        Effect   = "Allow"
        Action   = "iot:Receive"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/verified/fleet/v1/devices/${var.probe_device_id}/telemetry"
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "probe" {
  count = var.probe_certificate_arn == null ? 0 : 1

  policy = aws_iot_policy.probe.name
  target = var.probe_certificate_arn
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
