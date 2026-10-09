resource "aws_iot_thing" "device" {
  for_each = var.device_ids

  name = each.value

  attributes = {
    environment = var.environment
  }
}

resource "aws_iot_policy" "device" {
  name = "${local.name_prefix}-device"

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
          "ForAllValues:StringEquals" = {
            "iot:ConnectAttributes" = ["LastWill"]
          }
        }
      },
      {
        Sid    = "PublishTelemetryAndAcks"
        Effect = "Allow"
        Action = "iot:Publish"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/telemetry",
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/command-acks"
        ]
        Condition = {
          Bool = {
            "iot:Connection.Thing.IsAttached" = "true"
          }
        }
      },
      {
        Sid      = "PublishRetainedStatus"
        Effect   = "Allow"
        Action   = ["iot:Publish", "iot:RetainPublish"]
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/status"
        Condition = {
          Bool = {
            "iot:Connection.Thing.IsAttached" = "true"
          }
        }
      },
      {
        Sid    = "SubscribeToCommands"
        Effect = "Allow"
        Action = "iot:Subscribe"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topicfilter/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/commands",
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topicfilter/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/telemetry-receipts"
        ]
        Condition = {
          Bool = {
            "iot:Connection.Thing.IsAttached" = "true"
          }
        }
      },
      {
        Sid    = "ReceiveCommands"
        Effect = "Allow"
        Action = "iot:Receive"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/commands",
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/telemetry-receipts"
        ]
        Condition = {
          Bool = {
            "iot:Connection.Thing.IsAttached" = "true"
          }
        }
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "device" {
  for_each = var.device_certificate_arns

  policy = aws_iot_policy.device.name
  target = each.value
}

resource "aws_iot_policy" "telemetry_ingestor" {
  name = "${local.name_prefix}-telemetry-ingestor"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectWithFixedClientId"
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:client/${local.telemetry_ingestor_client_id}"
      },
      {
        Sid    = "SubscribeToDeviceMessages"
        Effect = "Allow"
        Action = "iot:Subscribe"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topicfilter/fleet/v1/devices/+/telemetry",
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topicfilter/fleet/v1/devices/+/status",
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topicfilter/fleet/v1/devices/+/command-acks"
        ]
      },
      {
        Sid    = "ReceiveDeviceMessages"
        Effect = "Allow"
        Action = "iot:Receive"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/*/telemetry",
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/*/status",
          "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/*/command-acks"
        ]
      },
      {
        Sid      = "PublishTelemetryReceipts"
        Effect   = "Allow"
        Action   = "iot:Publish"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/*/telemetry-receipts"
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "telemetry_ingestor" {
  count = var.telemetry_ingestor_certificate_arn == null ? 0 : 1

  policy = aws_iot_policy.telemetry_ingestor.name
  target = var.telemetry_ingestor_certificate_arn
}

resource "aws_iot_policy" "api" {
  name = "${local.name_prefix}-api"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectWithFixedClientId"
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:client/${local.api_client_id}"
      },
      {
        Sid      = "PublishCommands"
        Effect   = "Allow"
        Action   = "iot:Publish"
        Resource = "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/fleet/v1/devices/*/commands"
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "api" {
  count = var.api_certificate_arn == null ? 0 : 1

  policy = aws_iot_policy.api.name
  target = var.api_certificate_arn
}
