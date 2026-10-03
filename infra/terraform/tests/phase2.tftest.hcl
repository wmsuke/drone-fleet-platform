mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/terraform-test"
      user_id    = "AIDATEST"
    }
  }

  mock_data "aws_iot_endpoint" {
    defaults = {
      endpoint_address = "example-ats.iot.ap-northeast-1.amazonaws.com"
    }
  }
}

run "phase2_foundation_plan" {
  command = plan

  variables {
    environment = "dev"
    aws_region  = "ap-northeast-1"
    device_ids  = ["dev-drone-001", "dev-drone-002"]
  }

  assert {
    condition     = length(aws_iot_thing.device) == 2
    error_message = "plan must create one Thing for each deviceId"
  }

  assert {
    condition     = output.iot_ats_endpoint == "example-ats.iot.ap-northeast-1.amazonaws.com"
    error_message = "plan must expose the ATS endpoint"
  }

  assert {
    condition     = output.telemetry_ingestor.client_id == "drone-fleet-dev-telemetry-ingestor"
    error_message = "telemetry-ingestor clientId must include the environment"
  }

  assert {
    condition     = output.api.client_id == "drone-fleet-dev-api"
    error_message = "API clientId must include the environment"
  }

  assert {
    condition     = jsondecode(aws_iot_policy.api.policy).Statement[1].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/*/commands"
    error_message = "API policy must only publish command topics"
  }

  assert {
    condition = contains(
      jsondecode(aws_iot_policy.telemetry_ingestor.policy).Statement[1].Resource,
      "arn:aws:iot:ap-northeast-1:123456789012:topicfilter/fleet/v1/devices/+/command-acks",
    )
    error_message = "telemetry-ingestor policy must subscribe to ACK topics"
  }
}
