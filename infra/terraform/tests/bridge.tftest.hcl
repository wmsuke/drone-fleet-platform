mock_provider "aws" {
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
}
run "bridge_events_and_receipts_are_directional" {
  command = plan
  variables {
    environment = "dev"
    aws_region  = "ap-northeast-1"
  }
  assert {
    condition = (
      jsondecode(aws_iot_policy.device.policy).Statement[8].Action == "iot:Publish" &&
      jsondecode(aws_iot_policy.device.policy).Statement[8].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/bridge-events" &&
      jsondecode(aws_iot_policy.device.policy).Statement[9].Action == "iot:Subscribe" &&
      jsondecode(aws_iot_policy.device.policy).Statement[9].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topicfilter/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/bridge-receipts" &&
      jsondecode(aws_iot_policy.device.policy).Statement[10].Action == "iot:Receive" &&
      alltrue([for s in slice(jsondecode(aws_iot_policy.device.policy).Statement, 8, 11) : s.Condition.Bool["iot:Connection.Thing.IsAttached"] == "true"]) &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[7].Action == "iot:Subscribe" &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[8].Action == "iot:Receive" &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[9].Action == "iot:Publish" &&
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[9].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/*/bridge-receipts" &&
      length(jsondecode(aws_iot_policy.api.policy).Statement) == 4 &&
      jsondecode(aws_iot_policy.device.policy).Statement[11].Action == "iot:Subscribe" &&
      jsondecode(aws_iot_policy.device.policy).Statement[11].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topicfilter/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/bridge-requests" &&
      jsondecode(aws_iot_policy.device.policy).Statement[12].Action == "iot:Receive" &&
      jsondecode(aws_iot_policy.device.policy).Statement[12].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/bridge-requests" &&
      alltrue([for s in slice(jsondecode(aws_iot_policy.device.policy).Statement, 11, 13) : s.Condition.Bool["iot:Connection.Thing.IsAttached"] == "true"]) &&
      jsondecode(aws_iot_policy.api.policy).Statement[3].Action == "iot:Publish" &&
      jsondecode(aws_iot_policy.api.policy).Statement[3].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/*/bridge-requests"
    )
    error_message = "Bridge device/ingestor/API direction must stay scoped; no wildcard device permission"
  }
}
