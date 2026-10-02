locals {
  name_prefix                  = "drone-fleet-${var.environment}"
  telemetry_ingestor_client_id = "${local.name_prefix}-telemetry-ingestor"
  api_client_id                = "${local.name_prefix}-api"
}
