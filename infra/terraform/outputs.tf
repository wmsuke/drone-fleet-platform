output "aws_account_id" {
  description = "リソース確認に使うAWS account ID"
  value       = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  description = "AWS IoT Coreのリージョン"
  value       = var.aws_region
}

output "iot_ats_endpoint" {
  description = "MQTT over TLSで接続するAWS IoT Core ATS endpoint"
  value       = data.aws_iot_endpoint.ats.endpoint_address
}

output "device_thing_names" {
  description = "作成したデバイスThing名"
  value       = sort(keys(aws_iot_thing.device))
}

output "device_policy" {
  description = "デバイス共通IoT Policyの識別子とattach件数"
  value = {
    policy_name      = aws_iot_policy.device.name
    policy_arn       = aws_iot_policy.device.arn
    attachment_count = length(aws_iot_policy_attachment.device)
  }
}

output "telemetry_ingestor" {
  description = "telemetry-ingestorの接続とPolicy識別子"
  value = {
    client_id            = local.telemetry_ingestor_client_id
    policy_name          = aws_iot_policy.telemetry_ingestor.name
    policy_arn           = aws_iot_policy.telemetry_ingestor.arn
    certificate_attached = length(aws_iot_policy_attachment.telemetry_ingestor) == 1
  }
}

output "api" {
  description = "APIの接続とPolicy識別子"
  value = {
    client_id   = local.api_client_id
    policy_name = aws_iot_policy.api.name
    policy_arn  = aws_iot_policy.api.arn
  }
}
