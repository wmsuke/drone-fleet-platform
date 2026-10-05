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

run "phase2_bootstrap_without_certificates" {
  command = plan

  variables {
    environment             = "dev"
    aws_region              = "ap-northeast-1"
    device_ids              = ["dev-drone-001", "dev-drone-002"]
    device_certificate_arns = {}
  }

  assert {
    condition     = length(aws_iot_thing.device) == 2
    error_message = "bootstrap plan must create Things before certificates are issued"
  }

  assert {
    condition     = length(aws_iot_policy_attachment.device) == 0
    error_message = "bootstrap plan must not create device attachments without certificate ARNs"
  }

  assert {
    condition = (
      aws_iot_policy.device.name == "drone-fleet-dev-device" &&
      aws_iot_policy.telemetry_ingestor.name == "drone-fleet-dev-telemetry-ingestor" &&
      aws_iot_policy.api.name == "drone-fleet-dev-api"
    )
    error_message = "bootstrap plan must create all Phase 2 policies"
  }
}

run "phase2_foundation_plan" {
  command = plan

  variables {
    environment = "dev"
    aws_region  = "ap-northeast-1"
    device_ids  = ["dev-drone-001", "dev-drone-002"]
    device_certificate_arns = {
      dev-drone-001 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
      dev-drone-002 = "arn:aws:iot:ap-northeast-1:123456789012:cert/1111111111111111111111111111111111111111111111111111111111111111"
    }
    telemetry_ingestor_certificate_arn = "arn:aws:iot:ap-northeast-1:123456789012:cert/2222222222222222222222222222222222222222222222222222222222222222"
    api_certificate_arn                = "arn:aws:iot:ap-northeast-1:123456789012:cert/3333333333333333333333333333333333333333333333333333333333333333"
  }

  assert {
    condition     = length(aws_iot_thing.device) == 2
    error_message = "plan must create one Thing for each deviceId"
  }

  assert {
    condition     = length(aws_iot_policy_attachment.device) == 2
    error_message = "plan must attach the device policy to every device certificate"
  }

  assert {
    condition     = output.device_policy.attachment_count == 2
    error_message = "device policy output must report every certificate attachment"
  }

  assert {
    condition = (
      jsondecode(aws_iot_policy.device.policy).Statement[0].Resource == "arn:aws:iot:ap-northeast-1:123456789012:client/$${iot:Connection.Thing.ThingName}" &&
      jsondecode(aws_iot_policy.device.policy).Statement[0].Condition.Bool["iot:Connection.Thing.IsAttached"] == "true" &&
      jsondecode(aws_iot_policy.device.policy).Statement[0].Condition["ForAllValues:StringEquals"]["iot:ConnectAttributes"] == ["LastWill"]
    )
    error_message = "device policy must only connect as its attached Thing with no connect attribute other than LastWill"
  }

  assert {
    condition = toset(jsondecode(aws_iot_policy.device.policy).Statement[1].Resource) == toset([
      "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/telemetry",
      "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/command-acks",
    ])
    error_message = "device policy must publish only its telemetry and ACK topics"
  }

  assert {
    condition = (
      toset(jsondecode(aws_iot_policy.device.policy).Statement[2].Action) == toset(["iot:Publish", "iot:RetainPublish"]) &&
      jsondecode(aws_iot_policy.device.policy).Statement[2].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/status"
    )
    error_message = "device policy must restrict retained publish to its status topic"
  }

  assert {
    condition = (
      jsondecode(aws_iot_policy.device.policy).Statement[3].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topicfilter/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/commands" &&
      jsondecode(aws_iot_policy.device.policy).Statement[4].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/commands"
    )
    error_message = "device policy must subscribe to and receive only its command topic"
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
    condition = (
      length(aws_iot_policy_attachment.telemetry_ingestor) == 1 &&
      output.telemetry_ingestor.certificate_attached
    )
    error_message = "telemetry-ingestor policy must be attached to its dedicated certificate"
  }

  assert {
    condition     = output.api.client_id == "drone-fleet-dev-api"
    error_message = "API clientId must include the environment"
  }

  assert {
    condition = (
      length(aws_iot_policy_attachment.api) == 1 &&
      output.api.certificate_attached
    )
    error_message = "API policy must be attached to its dedicated certificate"
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

run "reject_shared_device_and_telemetry_ingestor_certificate" {
  command = plan

  variables {
    environment = "dev"
    aws_region  = "ap-northeast-1"
    device_ids  = ["dev-drone-001"]
    device_certificate_arns = {
      dev-drone-001 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
    }
    telemetry_ingestor_certificate_arn = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
  }

  expect_failures = [var.telemetry_ingestor_certificate_arn]
}

run "reject_shared_device_and_api_certificate" {
  command = plan

  variables {
    environment = "dev"
    aws_region  = "ap-northeast-1"
    device_ids  = ["dev-drone-001"]
    device_certificate_arns = {
      dev-drone-001 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
    }
    api_certificate_arn = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
  }

  expect_failures = [var.api_certificate_arn]
}

run "reject_shared_backend_certificate" {
  command = plan

  variables {
    environment                        = "dev"
    aws_region                         = "ap-northeast-1"
    telemetry_ingestor_certificate_arn = "arn:aws:iot:ap-northeast-1:123456789012:cert/2222222222222222222222222222222222222222222222222222222222222222"
    api_certificate_arn                = "arn:aws:iot:ap-northeast-1:123456789012:cert/2222222222222222222222222222222222222222222222222222222222222222"
  }

  expect_failures = [var.api_certificate_arn]
}
