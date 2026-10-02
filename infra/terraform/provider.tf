provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_iot_endpoint" "ats" {
  endpoint_type = "iot:Data-ATS"
}
