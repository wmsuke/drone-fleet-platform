variable "aws_region" {
  description = "AWS IoT Coreを確認するリージョン"
  type        = string
  default     = "ap-northeast-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a valid AWS region name"
  }
}

variable "rule_name" {
  description = "Basic Ingestで呼び出すIoT Rule名"
  type        = string
  default     = "drone_fleet_load_test"

  validation {
    condition     = can(regex("^[A-Za-z0-9_]+$", var.rule_name))
    error_message = "rule_name must use only letters, numbers, and underscores"
  }
}

variable "load_device_ids" {
  description = "短時間確認に使うload deviceのdeviceId。Thing nameとMQTT clientIdにも使う"
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for device_id in var.load_device_ids :
      can(regex("^load-[0-9]{6}$", device_id))
    ])
    error_message = "load_device_ids must use the load-000001 format"
  }

}

variable "load_device_certificate_arns" {
  description = "load deviceごとの証明書ARN。Thing作成前のbootstrap時だけ空mapを許可する"
  type        = map(string)
  default     = {}

  validation {
    condition = (
      length(var.load_device_certificate_arns) == 0 ||
      toset(keys(var.load_device_certificate_arns)) == var.load_device_ids
    )
    error_message = "load_device_certificate_arns must be empty or contain exactly one ARN for every load_device_id"
  }

  validation {
    condition     = length(distinct(values(var.load_device_certificate_arns))) == length(var.load_device_certificate_arns)
    error_message = "load devices must not share certificate ARNs"
  }

  validation {
    condition = alltrue([
      for certificate_arn in values(var.load_device_certificate_arns) :
      can(regex("^arn:[a-z0-9-]+:iot:${var.aws_region}:[0-9]{12}:cert/[a-fA-F0-9]{64}$", certificate_arn))
    ])
    error_message = "load_device_certificate_arns must contain AWS IoT certificate ARNs in aws_region"
  }
}

variable "probe_device_id" {
  description = "verified topicの受信確認だけに使う専用probe identity"
  type        = string
  default     = "load-probe"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.probe_device_id))
    error_message = "probe_device_id must be a valid deviceId"
  }
}

variable "probe_certificate_arn" {
  description = "probe専用証明書ARN。bootstrap時はnull"
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.probe_certificate_arn == null ||
      can(regex("^arn:[a-z0-9-]+:iot:${var.aws_region}:[0-9]{12}:cert/[a-fA-F0-9]{64}$", var.probe_certificate_arn))
    )
    error_message = "probe_certificate_arn must be an AWS IoT certificate ARN in aws_region"
  }

  validation {
    condition = (
      var.probe_certificate_arn == null ||
      !contains(values(var.load_device_certificate_arns), var.probe_certificate_arn)
    )
    error_message = "probe_certificate_arn must differ from every load device certificate ARN"
  }
}

variable "budget_notification_email" {
  description = "AWS IoTの課金を通知するメールアドレス。空文字の場合はBudgetを作成しない"
  type        = string
  default     = ""
}
