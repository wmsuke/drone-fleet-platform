mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}

run "ota_permissions_are_directional_and_device_scoped" {
  command = plan
  variables {
    environment = "dev"
    aws_region  = "ap-northeast-1"
  }

  assert {
    condition = (
      jsondecode(aws_iot_policy.device.policy).Statement[5].Action == "iot:Publish" &&
      jsondecode(aws_iot_policy.device.policy).Statement[5].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/ota-events" &&
      jsondecode(aws_iot_policy.device.policy).Statement[6].Action == "iot:Subscribe" &&
      toset(jsondecode(aws_iot_policy.device.policy).Statement[6].Resource) == toset([
        "arn:aws:iot:ap-northeast-1:123456789012:topicfilter/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/ota-requests",
        "arn:aws:iot:ap-northeast-1:123456789012:topicfilter/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/ota-receipts"
      ]) &&
      jsondecode(aws_iot_policy.device.policy).Statement[7].Action == "iot:Receive" &&
      toset(jsondecode(aws_iot_policy.device.policy).Statement[7].Resource) == toset([
        "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/ota-requests",
        "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/ota-receipts"
      ]) &&
      alltrue([for s in slice(jsondecode(aws_iot_policy.device.policy).Statement, 5, 8) : s.Effect == "Allow" && s.Condition.Bool["iot:Connection.Thing.IsAttached"] == "true"])
    )
    error_message = "device OTA permissions must stay attached-Thing-only with no wildcard, reverse direction or retained publish"
  }
  assert {
    condition = (
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[4].Action == "iot:Subscribe" &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[4].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topicfilter/fleet/v1/devices/+/ota-events" &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[5].Action == "iot:Receive" &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[5].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/*/ota-events" &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[6].Action == "iot:Publish" &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[6].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/*/ota-receipts" &&
      length(jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement) == 7
    )
    error_message = "ingestor must only receive OTA events and publish non-retained receipts"
  }
  assert {
    condition = (
      jsondecode(aws_iot_policy.api.policy).Statement[2].Action == "iot:Publish" &&
      jsondecode(aws_iot_policy.api.policy).Statement[2].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/*/ota-requests" &&
      length(jsondecode(aws_iot_policy.api.policy).Statement) == 3
    )
    error_message = "API must only publish non-retained OTA requests, without event/receipt impersonation"
  }
}
