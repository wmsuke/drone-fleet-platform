output "rule_name" {
  value = aws_iot_topic_rule.load_test.name
}

output "basic_ingest_topic_prefix" {
  value = local.topic_prefix
}

output "load_device_policy_name" {
  value = aws_iot_policy.load_device.name
}

output "probe_policy_name" {
  value = aws_iot_policy.probe.name
}
