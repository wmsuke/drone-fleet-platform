mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/terraform-test"
      user_id    = "AIDATEST"
    }
  }
}

run "bootstrap_without_certificates" {
  command = plan

  variables {
    load_device_ids              = ["load-000001", "load-000002"]
    load_device_certificate_arns = {}
  }

  assert {
    condition     = length(aws_iot_thing.load_device) == 2
    error_message = "bootstrap must create every load Thing before certificate issuance"
  }

  assert {
    condition     = length(aws_iot_policy_attachment.load_device) == 0
    error_message = "bootstrap must not attach a certificate"
  }
}

run "per_device_policy_and_probe" {
  command = plan

  variables {
    load_device_ids = ["load-000001", "load-000002"]
    load_device_certificate_arns = {
      load-000001 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
      load-000002 = "arn:aws:iot:ap-northeast-1:123456789012:cert/1111111111111111111111111111111111111111111111111111111111111111"
    }
    probe_certificate_arn = "arn:aws:iot:ap-northeast-1:123456789012:cert/2222222222222222222222222222222222222222222222222222222222222222"
  }

  assert {
    condition = (
      jsondecode(aws_iot_policy.load_device.policy).Statement[0].Resource == "arn:aws:iot:ap-northeast-1:123456789012:client/$${iot:Connection.Thing.ThingName}" &&
      jsondecode(aws_iot_policy.load_device.policy).Statement[1].Resource == "arn:aws:iot:ap-northeast-1:123456789012:topic/$aws/rules/drone_fleet_load_test/fleet/v1/devices/$${iot:Connection.Thing.ThingName}/telemetry"
    )
    error_message = "load policy must bind clientId and publish topic to the attached Thing"
  }

  assert {
    condition = (
      length(aws_iot_policy_attachment.load_device) == 2 &&
      length(aws_iot_policy_attachment.probe) == 1
    )
    error_message = "Terraform must attach only IoT Policies to the dedicated certificates"
  }

  assert {
    condition = (
      length(jsondecode(aws_iot_policy.load_device.policy).Statement) == 2 &&
      length(jsondecode(aws_iot_policy.probe.policy).Statement) == 4
    )
    error_message = "only the dedicated probe may subscribe to verified telemetry"
  }
}

run "reject_partial_certificate_map" {
  command = plan

  variables {
    load_device_ids = ["load-000001", "load-000002"]
    load_device_certificate_arns = {
      load-000001 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
    }
  }

  expect_failures = [var.load_device_certificate_arns]
}

run "reject_shared_certificate" {
  command = plan

  variables {
    load_device_ids = ["load-000001", "load-000002"]
    load_device_certificate_arns = {
      load-000001 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
      load-000002 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
    }
  }

  expect_failures = [var.load_device_certificate_arns]
}

run "reject_probe_certificate_shared_with_device" {
  command = plan

  variables {
    load_device_ids = ["load-000001"]
    load_device_certificate_arns = {
      load-000001 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
    }
    probe_certificate_arn = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
  }

  expect_failures = [var.probe_certificate_arn]
}
