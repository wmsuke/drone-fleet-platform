resource "aws_iot_thing" "device" {
  for_each = var.device_ids

  name = each.value

  attributes = {
    environment = var.environment
  }
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
      }
    ]
  })
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
